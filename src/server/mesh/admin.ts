import { randomInt } from "node:crypto";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Protobuf, Types } from "@meshtastic/core";
import type { FastifyBaseLogger } from "fastify";
import type {
  AdminCapability,
  ChannelUpdate,
  ConfigReadOutcome,
  LoRaUpdate,
  NodeConfigUpdate,
  NodeRadioConfig,
} from "../../shared/types.js";
import type { MeshListener } from "./listener.js";
import {
  applyConfig,
  applyModuleConfig,
  emptyRadioConfig,
} from "./radioConfig.js";
import { logNode } from "./nodeId.js";
import { TaskCancelledError } from "./tasks.js";

/**
 * Remote administration over the mesh.
 *
 * This module exists because `@meshtastic/core`'s convenience methods --
 * `setConfig`, `setModuleConfig`, `setOwner` -- take no destination and so
 * only ever configure the *local* node. Remote writes have to be assembled
 * as `AdminMessage` protobufs and sent on `PortNum.ADMIN_APP` ourselves.
 *
 * There is also no `onAdminPacket` event, so answers are recovered from
 * `onMeshPacket` and correlated on `decoded.requestId`, which firmware sets
 * to the id of the packet being answered.
 *
 * **A read is answered with an admin message; a write with a routing ACK.**
 * Firmware's `AdminModule` finishes every request with "if asked for a
 * response and it is not yet set, generate an 'ACK' response": a
 * `ROUTING_APP` packet, error `NONE`, from the target. That ACK is the only
 * confirmation a write ever gets. It is also the same shape as the delivery
 * ACKs our own radio and the relays generate along the way, which is why it
 * counts only when it comes *from the node addressed* -- a relay's ACK says
 * the packet moved on, not that anything was applied.
 */

const ADMIN_PORT = Protobuf.Portnums.PortNum.ADMIN_APP;
const ROUTING_PORT = Protobuf.Portnums.PortNum.ROUTING_APP;

/**
 * Firmware expires an admin session passkey after about five minutes. We
 * refresh well inside that -- a passkey that expires mid-write surfaces as
 * ADMIN_BAD_SESSION_KEY, which reads like an authorization failure and
 * isn't one.
 */
const PASSKEY_TTL_SECONDS = 240;

type AdminMessage = Protobuf.Admin.AdminMessage;
type PayloadVariant = AdminMessage["payloadVariant"];

/** What answered a request: data, or the target's bare acknowledgement. */
type AdminReply =
  | { kind: "message"; message: AdminMessage }
  | { kind: "ack" };

interface PendingRequest {
  nodeNum: number;
  resolve: (reply: AdminReply) => void;
  reject: (error: Error) => void;
}

export class AdminError extends Error {
  constructor(
    message: string,
    readonly capability: AdminCapability,
  ) {
    super(message);
    this.name = "AdminError";
  }
}

/**
 * A write that was sent but neither acknowledged nor verifiable.
 *
 * Distinct from a failure on purpose: the change may well have been applied,
 * and saying otherwise sends the operator off to retry something that is
 * already done -- or to conclude that a working node refuses writes.
 */
export class WriteUnconfirmedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteUnconfirmedError";
  }
}

/** How a write was established to have landed. */
export type WriteConfirmation = "ack" | "readback";

/** Routing errors that mean "we are not allowed", not "we could not reach". */
const UNAUTHORIZED_ERRORS = new Set<Protobuf.Mesh.Routing_Error>([
  Protobuf.Mesh.Routing_Error.NOT_AUTHORIZED,
  Protobuf.Mesh.Routing_Error.ADMIN_PUBLIC_KEY_UNAUTHORIZED,
  Protobuf.Mesh.Routing_Error.ADMIN_BAD_SESSION_KEY,
  Protobuf.Mesh.Routing_Error.PKI_UNKNOWN_PUBKEY,
  Protobuf.Mesh.Routing_Error.PKI_FAILED,
]);

const UNREACHABLE_ERRORS = new Set<Protobuf.Mesh.Routing_Error>([
  Protobuf.Mesh.Routing_Error.NO_ROUTE,
  Protobuf.Mesh.Routing_Error.TIMEOUT,
  Protobuf.Mesh.Routing_Error.MAX_RETRANSMIT,
  Protobuf.Mesh.Routing_Error.NO_RESPONSE,
  Protobuf.Mesh.Routing_Error.NO_INTERFACE,
  Protobuf.Mesh.Routing_Error.NO_CHANNEL,
]);

export interface AdminClientOptions {
  listener: MeshListener;
  logger: FastifyBaseLogger;
  /** Seconds to wait for a response before giving up. */
  timeout: number;
}

/**
 * Wraps an admin message in the MeshPacket and ToRadio envelopes, exactly as
 * `MeshDevice.sendPacket` would -- but with an id chosen by the caller.
 *
 * `sendPacket` generates its id internally and returns it only once the send
 * queue settles, which takes an ACK: long after a fast reply can have
 * arrived, and never at all for a packet whose answer *is* the reply. With
 * the id chosen up front, the waiter is in place before anything is sent.
 */
export function buildAdminToRadio(input: {
  from: number;
  to: number;
  id: number;
  message: AdminMessage;
  wantAck: boolean;
}): Uint8Array {
  return buildToRadio({
    from: input.from,
    to: input.to,
    id: input.id,
    portnum: ADMIN_PORT,
    payload: toBinary(Protobuf.Admin.AdminMessageSchema, input.message),
    wantAck: input.wantAck,
    wantResponse: true,
  });
}

/**
 * Any decoded MeshPacket in its ToRadio envelope, with a caller-chosen id.
 *
 * For every send whose answer is not a routing ACK. `sendPacket` resolves
 * only on an ACK for its packet, or rejects after the queue's 60s timeout --
 * so a request sent with `wantAck: false`, or one answered by data rather
 * than by an ACK, holds whoever awaits it for the full minute.
 */
export function buildToRadio(input: {
  from: number;
  to: number;
  id: number;
  portnum: Protobuf.Portnums.PortNum;
  payload: Uint8Array;
  wantAck: boolean;
  wantResponse: boolean;
}): Uint8Array {
  const packet = create(Protobuf.Mesh.MeshPacketSchema, {
    from: input.from,
    to: input.to,
    id: input.id,
    wantAck: input.wantAck,
    channel: Types.ChannelNumber.Primary,
    payloadVariant: {
      case: "decoded",
      value: {
        portnum: input.portnum,
        payload: input.payload,
        wantResponse: input.wantResponse,
      },
    },
  });
  return toBinary(
    Protobuf.Mesh.ToRadioSchema,
    create(Protobuf.Mesh.ToRadioSchema, {
      payloadVariant: { case: "packet", value: packet },
    }),
  );
}

/** A packet id: any nonzero uint32. */
export function newPacketId(): number {
  return randomInt(1, 0xffffffff);
}

export class AdminClient {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly passkeys = new Map<
    number,
    { key: Uint8Array; expiresAt: number }
  >();

  constructor(private readonly options: AdminClientOptions) {}

  attach(): void {
    this.options.listener.on("meshPacket", (packet: Protobuf.Mesh.MeshPacket) => {
      if (packet.payloadVariant.case !== "decoded") return;
      const data = packet.payloadVariant.value;
      if (data.requestId === 0) return;
      if (data.portnum === ADMIN_PORT) this.onAdminReply(packet, data);
      else if (data.portnum === ROUTING_PORT) this.onRoutingReply(packet, data);
    });
  }

  private onAdminReply(
    packet: Protobuf.Mesh.MeshPacket,
    data: Protobuf.Mesh.Data,
  ): void {
    let message: AdminMessage;
    try {
      message = fromBinary(Protobuf.Admin.AdminMessageSchema, data.payload);
    } catch (cause) {
      this.options.logger.warn(
        { err: (cause as Error).message },
        "undecodable admin response",
      );
      return;
    }

    // Every admin response carries a fresh passkey. Cache it so the next
    // write does not need its own round trip to obtain one.
    if (message.sessionPasskey.length > 0) {
      this.passkeys.set(packet.from, {
        key: message.sessionPasskey,
        expiresAt: Date.now() + PASSKEY_TTL_SECONDS * 1000,
      });
    }

    this.pending.get(data.requestId)?.resolve({ kind: "message", message });
  }

  /**
   * A routing packet about one of ours: either a refusal that says *why* it
   * will never be answered -- the only way to tell "not authorized" from "out
   * of range" -- or an ACK.
   *
   * Correlated on `requestId`. The library's typed `onRoutingPacket` event
   * carries only the routing packet's *own* id, which matches nothing.
   */
  private onRoutingReply(
    packet: Protobuf.Mesh.MeshPacket,
    data: Protobuf.Mesh.Data,
  ): void {
    const waiter = this.pending.get(data.requestId);
    if (!waiter) return;

    let routing: Protobuf.Mesh.Routing;
    try {
      routing = fromBinary(Protobuf.Mesh.RoutingSchema, data.payload);
    } catch {
      return;
    }
    if (routing.variant.case !== "errorReason") return;
    const reason = routing.variant.value;

    if (reason === Protobuf.Mesh.Routing_Error.NONE) {
      // Only the target's ACK means the request was handled; one from our
      // radio or a relay is progress, and the answer is still to come.
      if (packet.from === waiter.nodeNum) waiter.resolve({ kind: "ack" });
      return;
    }

    waiter.reject(
      new AdminError(
        `mesh routing error: ${Protobuf.Mesh.Routing_Error[reason] ?? reason}`,
        classifyRoutingError(reason),
      ),
    );
  }

  private passkeyFor(nodeNum: number): Uint8Array {
    const entry = this.passkeys.get(nodeNum);
    if (!entry || entry.expiresAt <= Date.now()) {
      this.passkeys.delete(nodeNum);
      return new Uint8Array();
    }
    return entry.key;
  }

  /**
   * Sends one admin message and waits for whatever answers it.
   *
   * `wantResponse` is what makes the remote reply at all; without it the
   * firmware applies the change silently and the only ACK is a delivery
   * receipt, which says nothing about what was applied.
   */
  private async exchange(
    nodeNum: number,
    variant: PayloadVariant,
    options: { withPasskey: boolean; signal?: AbortSignal },
  ): Promise<AdminReply> {
    // Checked before transmitting as well as while waiting: a cancel that
    // lands between two requests of a multi-step operation should stop the
    // next one going out at all.
    if (options.signal?.aborted) throw new TaskCancelledError();

    const device = this.options.listener.getDevice();
    const local = this.options.listener.getStatus().localNodeNum;
    if (!device || local === null) {
      throw new AdminError("local radio is not connected", "unknown");
    }

    const id = newPacketId();
    const bytes = buildAdminToRadio({
      from: local,
      to: nodeNum,
      id,
      wantAck: true,
      message: create(Protobuf.Admin.AdminMessageSchema, {
        payloadVariant: variant,
        sessionPasskey: options.withPasskey
          ? this.passkeyFor(nodeNum)
          : new Uint8Array(),
      }),
    });

    return new Promise<AdminReply>((resolve, reject) => {
      const settle = (): void => {
        clearTimeout(timer);
        this.pending.delete(id);
        options.signal?.removeEventListener("abort", onAbort);
      };

      const timer = setTimeout(() => {
        settle();
        // The library's queue would otherwise hold the packet for its own
        // 60s and then log a timeout of its own for it.
        device.queue.remove(id);
        reject(
          new AdminError(
            `no admin response within ${this.options.timeout}s`,
            "unreachable",
          ),
        );
      }, this.options.timeout * 1000);

      // Cancelling cannot un-send a packet that is already on the air. What
      // it does is stop us waiting on it and release the operation, so the
      // UI unblocks immediately. A late reply is simply unmatched.
      const onAbort = (): void => {
        settle();
        reject(new TaskCancelledError());
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      this.pending.set(id, {
        nodeNum,
        resolve: (reply) => {
          settle();
          device.queue.processAck(id);
          resolve(reply);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
      });

      device.sendRaw(bytes, id).catch((cause: unknown) => {
        // The queue settles on its own terms -- an ACK from anyone, a routing
        // error, or its 60s timeout -- all handled above with better
        // information. Only a failure to write at all is news.
        if (!(cause instanceof Error)) return;
        this.pending.get(id)?.reject(
          new AdminError(`could not send to the radio: ${cause.message}`, "unknown"),
        );
      });
    });
  }

  /** An exchange that must be answered with data, as every read is. */
  private async request(
    nodeNum: number,
    variant: PayloadVariant,
    options: { withPasskey: boolean; signal?: AbortSignal },
  ): Promise<AdminMessage> {
    const reply = await this.exchange(nodeNum, variant, options);
    if (reply.kind === "ack") {
      // Firmware ACKs a request it handled but had nothing to say to --
      // typically a config type it does not know. Better said now than after
      // a timeout.
      throw new AdminError(
        "the node acknowledged the request but sent no data",
        "unknown",
      );
    }
    return reply.message;
  }

  /** Reads a remote node's firmware metadata. Doubles as the admin probe. */
  async getMetadata(
    nodeNum: number,
    signal?: AbortSignal,
  ): Promise<Protobuf.Mesh.DeviceMetadata> {
    const response = await this.request(
      nodeNum,
      { case: "getDeviceMetadataRequest", value: true },
      { withPasskey: false, signal },
    );
    if (response.payloadVariant.case !== "getDeviceMetadataResponse") {
      throw new AdminError(
        `unexpected admin response: ${response.payloadVariant.case ?? "empty"}`,
        "unknown",
      );
    }
    return response.payloadVariant.value;
  }

  /**
   * Establishes whether the local node may administer `nodeNum`.
   *
   * Necessarily a probe, not an inspection: authorization lives in the
   * remote's `SecurityConfig.adminKey`, which cannot be read without
   * already holding admin rights. A silent timeout is therefore
   * `unreachable`, never `unauthorized` -- an out-of-range node must not be
   * reported as a permissions problem.
   */
  async probe(nodeNum: number, signal?: AbortSignal): Promise<AdminCapability> {
    try {
      await this.getMetadata(nodeNum, signal);
      return "capable";
    } catch (cause) {
      // A cancelled probe establishes nothing, so it must propagate rather
      // than be recorded as a verdict -- writing "unreachable" here would
      // brand a node unreachable because someone clicked stop.
      if (cause instanceof TaskCancelledError) throw cause;
      if (cause instanceof AdminError) return cause.capability;
      return "unknown";
    }
  }

  /** The node's current User record. */
  async getOwner(
    nodeNum: number,
    signal?: AbortSignal,
  ): Promise<Protobuf.Mesh.User> {
    const response = await this.request(
      nodeNum,
      { case: "getOwnerRequest", value: true },
      { withPasskey: false, signal },
    );
    if (response.payloadVariant.case !== "getOwnerResponse") {
      throw new AdminError("could not read current owner", "unknown");
    }
    return response.payloadVariant.value;
  }

  /**
   * Sends a write and establishes whether it landed.
   *
   * **When the write gets no definitive answer, the node is asked.** Over a
   * few hops the ACK routinely loses the race with the timeout, or is lost
   * outright while the write itself landed, so "no answer" is weak evidence
   * of "not applied". `verify` reads the setting back and lists what does not
   * match. An explicit refusal -- not authorized, a bad passkey -- is
   * definitive and skips this, as does a cancel.
   *
   * Resolves with how the change was confirmed. Throws `AdminError` when it
   * was refused or demonstrably not applied, and `WriteUnconfirmedError` when
   * the read-back went unanswered too.
   */
  private async confirmWrite(
    nodeNum: number,
    variant: PayloadVariant,
    verify: () => Promise<string[]>,
    signal?: AbortSignal,
  ): Promise<WriteConfirmation> {
    let doubt: string;
    try {
      await this.exchange(nodeNum, variant, { withPasskey: true, signal });
      return "ack";
    } catch (cause) {
      if (cause instanceof TaskCancelledError) throw cause;
      // Refused outright: the node answered, and the answer was no.
      if (cause instanceof AdminError && cause.capability === "unauthorized") {
        throw cause;
      }
      doubt = (cause as Error).message;
    }

    this.options.logger.info(
      { ...logNode(nodeNum), write: variant.case, doubt },
      "write not acknowledged; reading back to check whether it landed",
    );

    let mismatches: string[];
    try {
      mismatches = await verify();
    } catch (cause) {
      if (cause instanceof TaskCancelledError) throw cause;
      throw new WriteUnconfirmedError(
        `The change was sent but not acknowledged (${doubt}), and the node did not answer a read-back either (${(cause as Error).message}). It may still have been applied.`,
      );
    }

    if (mismatches.length > 0) {
      // It answered an admin read, so it is reachable and we hold rights;
      // the write simply did not take. "unknown" leaves the verdict alone.
      throw new AdminError(
        `Not applied: the change was not acknowledged (${doubt}), and a read-back shows ${mismatches.join(" and ")}.`,
        "unknown",
      );
    }
    return "readback";
  }

  /**
   * Renames a node. `setOwner` replaces the whole User record, so we read
   * the current one first and patch it -- sending a partial User blanks
   * whichever name was omitted.
   */
  async setOwner(
    nodeNum: number,
    update: NodeConfigUpdate,
    signal?: AbortSignal,
  ): Promise<WriteConfirmation> {
    const owner = await this.getOwner(nodeNum, signal);
    // Patched in place rather than rebuilt with `create`, so any field the
    // bundled protobufs cannot decode rides along in the unknown fields
    // instead of being silently dropped (CLAUDE.md section 4).
    if (update.longName !== undefined) owner.longName = update.longName;
    if (update.shortName !== undefined) owner.shortName = update.shortName;

    return this.confirmWrite(
      nodeNum,
      { case: "setOwner", value: owner },
      async () => {
        const current = await this.getOwner(nodeNum, signal);
        const mismatches: string[] = [];
        if (current.longName !== owner.longName) {
          mismatches.push(`the node's long name is "${current.longName}"`);
        }
        if (current.shortName !== owner.shortName) {
          mismatches.push(`the node's short name is "${current.shortName}"`);
        }
        return mismatches;
      },
      signal,
    );
  }

  /** The node's LoRa settings, decoded with unknown fields kept. */
  async getLoRa(
    nodeNum: number,
    signal?: AbortSignal,
  ): Promise<Protobuf.Config.Config_LoRaConfig> {
    const response = await this.request(
      nodeNum,
      {
        case: "getConfigRequest",
        value: Protobuf.Admin.AdminMessage_ConfigType.LORA_CONFIG,
      },
      { withPasskey: false, signal },
    );
    if (
      response.payloadVariant.case !== "getConfigResponse" ||
      response.payloadVariant.value.payloadVariant.case !== "lora"
    ) {
      throw new AdminError("could not read LoRa settings", "unknown");
    }
    return response.payloadVariant.value.payloadVariant.value;
  }

  /**
   * Changes the modem preset and/or frequency slot.
   *
   * `setConfig` replaces the whole LoRa block, so the current one is read and
   * patched in place. That matters more here than anywhere: the bundled
   * protobufs predate two LoRa fields (`femLnaMode`, `serialHalOnly`), and a
   * block rebuilt from decoded fields would quietly reset both. Patching the
   * decoded message keeps them in its unknown fields, which are re-encoded.
   *
   * Firmware reboots about five seconds after applying a LoRa change, so
   * there is no read-back: an unacknowledged write is reported unconfirmed,
   * and the new values arrive with the config dump on reconnect.
   */
  async setLoRa(
    nodeNum: number,
    update: LoRaUpdate,
    signal?: AbortSignal,
  ): Promise<void> {
    const lora = await this.getLoRa(nodeNum, signal);
    if (update.modemPreset !== undefined) {
      lora.modemPreset =
        Protobuf.Config.Config_LoRaConfig_ModemPreset[update.modemPreset];
      lora.usePreset = true;
    }
    if (update.frequencySlot !== undefined) lora.channelNum = update.frequencySlot;

    const config = create(Protobuf.Config.ConfigSchema, {
      payloadVariant: { case: "lora", value: lora },
    });
    try {
      await this.exchange(
        nodeNum,
        { case: "setConfig", value: config },
        { withPasskey: true, signal },
      );
    } catch (cause) {
      if (cause instanceof TaskCancelledError) throw cause;
      if (cause instanceof AdminError && cause.capability === "unauthorized") {
        throw cause;
      }
      throw new WriteUnconfirmedError(
        `The change was sent but not acknowledged (${(cause as Error).message}). The radio may already be restarting to apply it; its settings are re-read when it reconnects.`,
      );
    }
  }

  /** One channel slot, 0-7. */
  async getChannel(
    nodeNum: number,
    index: number,
    signal?: AbortSignal,
  ): Promise<Protobuf.Channel.Channel> {
    const response = await this.request(
      nodeNum,
      // Firmware's request is 1-based, so that 0 can mean "unset".
      { case: "getChannelRequest", value: index + 1 },
      { withPasskey: false, signal },
    );
    if (response.payloadVariant.case !== "getChannelResponse") {
      throw new AdminError(`could not read channel ${index}`, "unknown");
    }
    return response.payloadVariant.value;
  }

  /**
   * Replaces one channel, then reads it back.
   *
   * The read-back happens even after an ACK, because firmware may adjust what
   * it stores -- it coarsens position precision on a channel whose key is
   * public -- and what is recorded should be what the radio holds, not what
   * was asked for. Position precision is left out of the comparison for the
   * same reason.
   */
  async setChannel(
    nodeNum: number,
    index: number,
    update: ChannelUpdate,
    signal?: AbortSignal,
  ): Promise<{ confirmedBy: WriteConfirmation; channel: Protobuf.Channel.Channel | null }> {
    const channel = await this.getChannel(nodeNum, index, signal);
    channel.index = index;
    channel.role = Protobuf.Channel.Channel_Role[update.role];
    channel.settings ??= create(Protobuf.Channel.ChannelSettingsSchema);
    const settings = channel.settings;
    settings.name = update.name;
    settings.psk = Buffer.from(update.psk, "base64");
    settings.uplinkEnabled = update.uplinkEnabled;
    settings.downlinkEnabled = update.downlinkEnabled;
    settings.moduleSettings ??= create(Protobuf.Channel.ModuleSettingsSchema);
    settings.moduleSettings.positionPrecision = update.positionPrecision;

    let readBack: Protobuf.Channel.Channel | null = null;
    const verify = async (): Promise<string[]> => {
      readBack = await this.getChannel(nodeNum, index, signal);
      const now = readBack.settings;
      const mismatches: string[] = [];
      if (readBack.role !== channel.role) mismatches.push("a different role");
      if ((now?.name ?? "") !== settings.name) {
        mismatches.push(`the name "${now?.name ?? ""}"`);
      }
      if (!sameBytes(now?.psk ?? new Uint8Array(), settings.psk)) {
        mismatches.push("a different key");
      }
      return mismatches;
    };

    const confirmedBy = await this.confirmWrite(
      nodeNum,
      { case: "setChannel", value: channel },
      verify,
      signal,
    );
    if (confirmedBy === "ack") {
      try {
        await verify();
      } catch (cause) {
        if (cause instanceof TaskCancelledError) throw cause;
        // Acknowledged; the record is simply refreshed on the next re-read.
      }
    }
    return { confirmedBy, channel: readBack };
  }

  /**
   * Reads everything we surface about a remote node's radio and module
   * settings: four admin reads, sequentially.
   *
   * Sequential rather than concurrent on purpose. Each is a mesh round trip
   * on a duty-cycled band, and four at once would collide with each other on
   * the air far more often than they would save time. The whole thing runs
   * to a couple of minutes on a distant node, which is why it registers a
   * cancellable task.
   *
   * A read that fails does not abort the rest. Firmware answers the config
   * types it knows and ignores the others, and a node that will not give up
   * its telemetry module config may still report its LoRa settings -- which
   * is the half that matters most. The returned outcome says which arrived
   * so the UI can report a partial read rather than implying the blanks are
   * settings.
   */
  async readRadioConfig(
    nodeNum: number,
    signal?: AbortSignal,
  ): Promise<{ config: NodeRadioConfig; outcome: ConfigReadOutcome }> {
    const config = emptyRadioConfig(Math.floor(Date.now() / 1000));
    const outcome: ConfigReadOutcome = {
      lora: false,
      device: false,
      position: false,
      telemetry: false,
    };

    const ConfigType = Protobuf.Admin.AdminMessage_ConfigType;
    const ModuleConfigType = Protobuf.Admin.AdminMessage_ModuleConfigType;

    outcome.lora = await this.readConfigInto(
      nodeNum, config, ConfigType.LORA_CONFIG, signal,
    );
    outcome.device = await this.readConfigInto(
      nodeNum, config, ConfigType.DEVICE_CONFIG, signal,
    );
    outcome.position = await this.readConfigInto(
      nodeNum, config, ConfigType.POSITION_CONFIG, signal,
    );
    outcome.telemetry = await this.readModuleConfigInto(
      nodeNum, config, ModuleConfigType.TELEMETRY_CONFIG, signal,
    );

    return { config, outcome };
  }

  /** One `getConfigRequest`, folded into the snapshot. False if it failed. */
  private async readConfigInto(
    nodeNum: number,
    target: NodeRadioConfig,
    type: Protobuf.Admin.AdminMessage_ConfigType,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      const response = await this.request(
        nodeNum,
        { case: "getConfigRequest", value: type },
        { withPasskey: false, signal },
      );
      if (response.payloadVariant.case !== "getConfigResponse") return false;
      return applyConfig(target, response.payloadVariant.value);
    } catch (cause) {
      // A cancel must abandon the whole sequence rather than be recorded as
      // "this config type did not answer".
      if (cause instanceof TaskCancelledError) throw cause;
      this.options.logger.debug(
        {
          nodeNum,
          type: Protobuf.Admin.AdminMessage_ConfigType[type],
          err: (cause as Error).message,
        },
        "config read failed",
      );
      return false;
    }
  }

  /** As `readConfigInto`, for `getModuleConfigRequest`. */
  private async readModuleConfigInto(
    nodeNum: number,
    target: NodeRadioConfig,
    type: Protobuf.Admin.AdminMessage_ModuleConfigType,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      const response = await this.request(
        nodeNum,
        { case: "getModuleConfigRequest", value: type },
        { withPasskey: false, signal },
      );
      if (response.payloadVariant.case !== "getModuleConfigResponse") {
        return false;
      }
      return applyModuleConfig(target, response.payloadVariant.value);
    } catch (cause) {
      if (cause instanceof TaskCancelledError) throw cause;
      this.options.logger.debug(
        {
          nodeNum,
          type: Protobuf.Admin.AdminMessage_ModuleConfigType[type],
          err: (cause as Error).message,
        },
        "module config read failed",
      );
      return false;
    }
  }

  /** Clears cached state for a node, forcing a fresh passkey next time. */
  forget(nodeNum: number): void {
    this.passkeys.delete(nodeNum);
  }
}

function classifyRoutingError(
  reason: Protobuf.Mesh.Routing_Error,
): AdminCapability {
  if (UNAUTHORIZED_ERRORS.has(reason)) return "unauthorized";
  if (UNREACHABLE_ERRORS.has(reason)) return "unreachable";
  return "unknown";
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
