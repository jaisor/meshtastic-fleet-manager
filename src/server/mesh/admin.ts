import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Protobuf, Types } from "@meshtastic/core";
import type { FastifyBaseLogger } from "fastify";
import type { AdminCapability, NodeConfigUpdate } from "../../shared/types.js";
import type { MeshListener } from "./listener.js";

/**
 * Remote administration over the mesh.
 *
 * This module exists because `@meshtastic/core`'s convenience methods --
 * `setConfig`, `setModuleConfig`, `setOwner` -- take no destination and so
 * only ever configure the *local* node. Remote writes have to be assembled
 * as `AdminMessage` protobufs and pushed through the generic `sendPacket`
 * on `PortNum.ADMIN_APP`.
 *
 * There is also no `onAdminPacket` event, so responses are recovered by
 * filtering `onMeshPacket` for the admin port and correlating on
 * `decoded.requestId`.
 */

const ADMIN_PORT = Protobuf.Portnums.PortNum.ADMIN_APP;

/**
 * Firmware expires an admin session passkey after about five minutes. We
 * refresh well inside that -- a passkey that expires mid-write surfaces as
 * ADMIN_BAD_SESSION_KEY, which reads like an authorization failure and
 * isn't one.
 */
const PASSKEY_TTL_SECONDS = 240;

/** Window for holding a response that arrives before its waiter registers. */
const ORPHAN_RESPONSE_TTL_MS = 10_000;

type AdminMessage = Protobuf.Admin.AdminMessage;
type PayloadVariant = AdminMessage["payloadVariant"];

interface PendingRequest {
  resolve: (message: AdminMessage) => void;
  reject: (error: AdminError) => void;
  timer: NodeJS.Timeout;
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

export class AdminClient {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly orphans = new Map<number, AdminMessage>();
  private readonly passkeys = new Map<
    number,
    { key: Uint8Array; expiresAt: number }
  >();

  constructor(private readonly options: AdminClientOptions) {}

  attach(): void {
    this.options.listener.on("meshPacket", (packet: Protobuf.Mesh.MeshPacket) => {
      if (packet.payloadVariant.case !== "decoded") return;
      const data = packet.payloadVariant.value;
      if (data.portnum !== ADMIN_PORT || data.requestId === 0) return;

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

      this.deliver(data.requestId, message);
    });

    // A routing error tells us *why* a request will never be answered, which
    // is the only way to tell "not authorized" apart from "out of range".
    this.options.listener.on(
      "routing",
      (packet: Types.PacketMetadata<Protobuf.Mesh.Routing>) => {
        const variant = packet.data.variant;
        if (variant?.case !== "errorReason") return;
        const reason = variant.value;
        if (reason === Protobuf.Mesh.Routing_Error.NONE) return;

        const waiter = this.pending.get(packet.id);
        if (!waiter) return;
        this.settle(packet.id);
        waiter.reject(
          new AdminError(
            `mesh routing error: ${Protobuf.Mesh.Routing_Error[reason] ?? reason}`,
            classifyRoutingError(reason),
          ),
        );
      },
    );
  }

  private deliver(requestId: number, message: AdminMessage): void {
    const waiter = this.pending.get(requestId);
    if (waiter) {
      this.settle(requestId);
      waiter.resolve(message);
      return;
    }
    // Response beat its waiter -- hold it briefly so `request` can pick it up.
    this.orphans.set(requestId, message);
    setTimeout(() => this.orphans.delete(requestId), ORPHAN_RESPONSE_TTL_MS);
  }

  private settle(requestId: number): void {
    const waiter = this.pending.get(requestId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.pending.delete(requestId);
    }
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
   * Sends one admin message and waits for the matching response.
   *
   * `wantResponse` is what makes the remote reply at all; without it the
   * firmware applies the change silently and an ACK tells you only that a
   * packet was relayed, not that anything was applied.
   */
  private async request(
    nodeNum: number,
    variant: PayloadVariant,
    options: { withPasskey: boolean },
  ): Promise<AdminMessage> {
    const device = this.options.listener.getDevice();
    if (!device) {
      throw new AdminError("local radio is not connected", "unknown");
    }

    const message = create(Protobuf.Admin.AdminMessageSchema, {
      payloadVariant: variant,
      sessionPasskey: options.withPasskey
        ? this.passkeyFor(nodeNum)
        : new Uint8Array(),
    });

    const packetId = await device.sendPacket(
      toBinary(Protobuf.Admin.AdminMessageSchema, message),
      ADMIN_PORT,
      nodeNum,
      Types.ChannelNumber.Primary,
      true, // wantAck
      true, // wantResponse
    );

    const orphan = this.orphans.get(packetId);
    if (orphan) {
      this.orphans.delete(packetId);
      return orphan;
    }

    return new Promise<AdminMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(packetId);
        reject(
          new AdminError(
            `no admin response within ${this.options.timeout}s`,
            "unreachable",
          ),
        );
      }, this.options.timeout * 1000);

      this.pending.set(packetId, { resolve, reject, timer });
    });
  }

  /** Reads a remote node's firmware metadata. Doubles as the admin probe. */
  async getMetadata(nodeNum: number): Promise<Protobuf.Mesh.DeviceMetadata> {
    const response = await this.request(
      nodeNum,
      { case: "getDeviceMetadataRequest", value: true },
      { withPasskey: false },
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
  async probe(nodeNum: number): Promise<AdminCapability> {
    try {
      await this.getMetadata(nodeNum);
      return "capable";
    } catch (cause) {
      if (cause instanceof AdminError) return cause.capability;
      return "unknown";
    }
  }

  /**
   * Renames a remote node. `setOwner` replaces the whole User record, so we
   * read the current one first and patch it -- sending a partial User blanks
   * whichever name was omitted.
   */
  async setOwner(nodeNum: number, update: NodeConfigUpdate): Promise<void> {
    const current = await this.request(
      nodeNum,
      { case: "getOwnerRequest", value: true },
      { withPasskey: false },
    );
    if (current.payloadVariant.case !== "getOwnerResponse") {
      throw new AdminError("could not read current owner", "unknown");
    }

    const owner = current.payloadVariant.value;
    const patched = create(Protobuf.Mesh.UserSchema, {
      ...owner,
      longName: update.longName ?? owner.longName,
      shortName: update.shortName ?? owner.shortName,
    });

    await this.request(
      nodeNum,
      { case: "setOwner", value: patched },
      { withPasskey: true },
    );
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
