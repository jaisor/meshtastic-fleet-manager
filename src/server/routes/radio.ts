import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  ChannelRole,
  ChannelUpdate,
  LocalRadioDetail,
  LoRaUpdate,
  ModemPreset,
} from "../../shared/types.js";
import { MODEM_PRESETS } from "../../shared/types.js";
import { canAdminister } from "../../shared/roles.js";
import { currentUser, requireCapability } from "../auth.js";
import type { ChannelRepository } from "../db/repositories/channels.js";
import { AdminError, WriteUnconfirmedError } from "../mesh/admin.js";
import { readLocalRadio } from "../mesh/localRadio.js";
import { logNode } from "../mesh/nodeId.js";
import { channelFromProto, pskKind } from "../mesh/radioConfig.js";
import { TaskCancelledError } from "../mesh/tasks.js";
import {
  busyError,
  validateConfigUpdate,
  type ApiDependencies,
} from "./api.js";

/**
 * The USB-attached radio's own page.
 *
 * It is not a fleet member -- it is the instrument the fleet is observed
 * through -- and it differs from one in the ways that matter here: it is
 * reached over a cable rather than the air, so reading it costs no airtime
 * and writing it cannot strand it out of reach.
 *
 * **Who may do what.** Reading it back is open to every role, viewers
 * included: it is a USB exchange, nothing is transmitted, and "viewers never
 * transmit" is the rule that matters. Changing it is admin-only, a step above
 * operating the radio, because a preset, slot or channel change moves the
 * whole console onto a different mesh.
 *
 * **Channel keys are secrets.** They are stored, so the page works with the
 * radio unplugged, but only an admin is sent them; everyone else sees what
 * kind of key a channel uses. No key reaches a log line or the operation log.
 */

export type RadioRouteDependencies = ApiDependencies & {
  channels: ChannelRepository;
};

const TELEMETRY_LIMIT = 200;
const OPERATION_LIMIT = 20;
/** Channel names are 11 bytes on the wire, plus the terminator. */
const MAX_CHANNEL_NAME_BYTES = 11;
/** Firmware wraps an over-large slot modulo the band's slot count. */
const MAX_FREQUENCY_SLOT = 1000;

export function registerRadioRoutes(
  app: FastifyInstance,
  deps: RadioRouteDependencies,
): void {
  const requireAdmin = requireCapability(deps.auth, "administer");

  /**
   * The radio on the cable, by the number it reported on this connection.
   * Deliberately nothing else: falling back to the last radio stored here
   * once presented an NRF52 unplugged ten days earlier as the attached radio,
   * while the ESP32-S3 actually on the cable answered nothing at all.
   */
  const localNodeNum = (): number | null =>
    deps.listener.getIdentifiedDevice() ? deps.listener.getStatus().localNodeNum : null;

  app.get("/api/radio", async (request): Promise<LocalRadioDetail> => {
    const nodeNum = localNodeNum();
    const user = currentUser(request, deps.auth);
    if (nodeNum === null) {
      return {
        node: null,
        publicKey: null,
        config: null,
        channels: [],
        telemetry: [],
        operations: [],
        lastIdentified: deps.nodes.lastLocal(),
      };
    }
    return {
      node: deps.nodes.get(nodeNum),
      publicKey: deps.nodes.publicKeyFor(nodeNum),
      config: deps.nodes.configFor(nodeNum),
      channels: deps.channels.list(nodeNum, {
        includeKeys: user !== null && canAdminister(user.role),
      }),
      telemetry: deps.nodes.telemetryFor(nodeNum, TELEMETRY_LIMIT),
      operations: deps.operations.recentFor(nodeNum, OPERATION_LIMIT),
      lastIdentified: null,
    };
  });

  /**
   * Reads everything back from the radio: identity, settings, all eight
   * channel slots. The same read runs by itself whenever the radio finishes
   * its config dump (`LocalRadioProbe`); this is the button for it.
   *
   * Takes no radio lock. Every request is addressed to the radio itself and
   * answered over USB without transmitting, so it contends with nothing on
   * the air -- the same reasoning as the watchdog's self-check.
   */
  app.post("/api/radio/read", async (request, reply) => {
    const nodeNum = deps.listener.getStatus().localNodeNum;
    const blocked = deps.listener.unavailableReason();
    if (blocked !== null || nodeNum === null) {
      return reply.status(503).send({ error: blocked ?? "local radio is not connected" });
    }

    try {
      const { outcome, channelsRead } = await readLocalRadio(nodeNum, {
        ...deps,
        logger: request.log,
      });

      request.log.info(
        { ...logNode(nodeNum), outcome, channelsRead },
        "local radio re-read",
      );
      return { outcome, channelsRead };
    } catch (cause) {
      if (cause instanceof AdminError) {
        return reply.status(502).send({ error: cause.message });
      }
      throw cause;
    }
  });

  app.patch<{ Body: { longName?: string; shortName?: string } }>(
    "/api/radio/owner",
    async (request, reply) => {
      if (!(await requireAdmin(request, reply))) return reply;
      const update = validateConfigUpdate(request.body);
      if ("error" in update) {
        return reply.status(400).send({ error: update.error });
      }
      return runLocalWrite(request, reply, {
        kind: "setOwner",
        label: "Renaming the local radio",
        detail: describe(update.value),
        write: async (nodeNum, signal) => {
          const confirmedBy = await deps.admin.setOwner(
            nodeNum,
            update.value,
            signal,
          );
          deps.nodes.upsert({
            nodeNum,
            longName: update.value.longName ?? null,
            shortName: update.value.shortName ?? null,
          });
          return { confirmedBy };
        },
      });
    },
  );

  app.patch<{ Body: LoRaUpdate }>("/api/radio/lora", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return reply;
    const update = validateLoRaUpdate(request.body);
    if ("error" in update) {
      return reply.status(400).send({ error: update.error });
    }
    return runLocalWrite(request, reply, {
      kind: "setLoRa",
      label: "Changing the local radio's LoRa settings",
      detail: describe(update.value),
      write: async (nodeNum, signal) => {
        await deps.admin.setLoRa(nodeNum, update.value, signal);
        // Nothing to record yet: the radio restarts to apply this, and its
        // config dump on reconnect is what updates the stored snapshot.
        return { confirmedBy: "ack" as const, restarting: true };
      },
    });
  });

  app.put<{ Params: { index: string }; Body: ChannelUpdate }>(
    "/api/radio/channels/:index",
    async (request, reply) => {
      if (!(await requireAdmin(request, reply))) return reply;
      const index = Number(request.params.index);
      const update = validateChannelUpdate(index, request.body);
      if ("error" in update) {
        return reply.status(400).send({ error: update.error });
      }
      const { psk, ...rest } = update.value;
      return runLocalWrite(request, reply, {
        kind: "setChannel",
        label: `Changing channel ${index} on the local radio`,
        // The key is never logged; its kind says enough to audit.
        detail: `index=${index}, ${describe(rest)}, key=${pskKind(Buffer.from(psk, "base64"))}`,
        write: async (nodeNum, signal) => {
          const result = await deps.admin.setChannel(
            nodeNum,
            index,
            update.value,
            signal,
          );
          if (result.channel) {
            deps.channels.save(
              nodeNum,
              channelFromProto(result.channel, Math.floor(Date.now() / 1000)),
            );
          }
          return { confirmedBy: result.confirmedBy };
        },
      });
    },
  );

  /**
   * One write to the local radio, start to finish: the radio check, the
   * lock, the audit row, and turning the outcome into a response.
   *
   * Writes take the radio lock even though they never leave the cable: a
   * LoRa change restarts the radio, and an operator's remote exchange in
   * flight at that moment would be lost with it.
   */
  async function runLocalWrite(
    request: FastifyRequest,
    reply: FastifyReply,
    op: {
      kind: string;
      label: string;
      detail: string;
      write: (
        nodeNum: number,
        signal: AbortSignal,
      ) => Promise<{ confirmedBy: "ack" | "readback"; restarting?: boolean }>;
    },
  ): Promise<FastifyReply | object> {
    const nodeNum = deps.listener.getStatus().localNodeNum;
    const blocked = deps.listener.unavailableReason();
    if (blocked !== null || nodeNum === null) {
      return reply.status(503).send({ error: blocked ?? "local radio is not connected" });
    }
    const node = deps.nodes.get(nodeNum);

    const started = deps.tasks.start({
      kind: "config",
      label: op.label,
      nodeNum,
      nodeName: node?.longName ?? node?.shortName ?? null,
      timeoutSeconds: 3 * deps.config.fleet.admin_probe_timeout,
    });
    if (!started) {
      return reply.status(409).send(busyError(deps.tasks.occupancy()));
    }
    const { task, signal } = started;
    const operationId = deps.operations.create(nodeNum, op.kind, op.detail);

    try {
      const result = await op.write(nodeNum, signal);
      deps.operations.settle(
        operationId,
        "confirmed",
        result.confirmedBy === "readback"
          ? "not acknowledged; confirmed by reading the radio back"
          : null,
      );
      request.log.info(
        { ...logNode(nodeNum), kind: op.kind, detail: op.detail },
        "local radio changed",
      );
      return { operationId, state: "confirmed" as const, ...result };
    } catch (cause) {
      if (cause instanceof TaskCancelledError) {
        deps.operations.settle(
          operationId,
          "failed",
          "cancelled by operator; the change may still have been applied",
        );
        return reply.status(409).send({
          error: "Cancelled. The change may already have been applied; re-read the radio to check.",
          operationId,
          state: "failed" as const,
        });
      }
      if (cause instanceof WriteUnconfirmedError) {
        deps.operations.settle(operationId, "unconfirmed", cause.message);
        return reply.status(504).send({
          error: cause.message,
          operationId,
          state: "unconfirmed" as const,
        });
      }
      const message = cause instanceof Error ? cause.message : "unknown failure";
      deps.operations.settle(operationId, "failed", message);
      request.log.warn(
        { ...logNode(nodeNum), kind: op.kind, err: message },
        "local radio change failed",
      );
      return reply
        .status(502)
        .send({ error: message, operationId, state: "failed" as const });
    } finally {
      deps.tasks.finish(task.id);
    }
  }
}

/** `key=value, ...` for the operation log. */
function describe(value: object): string {
  return Object.entries(value)
    .map(([key, entry]) => `${key}=${String(entry)}`)
    .join(", ");
}

function validateLoRaUpdate(
  body: LoRaUpdate | undefined,
): { value: LoRaUpdate } | { error: string } {
  const value: LoRaUpdate = {};
  if (body?.modemPreset !== undefined) {
    if (!(MODEM_PRESETS as readonly string[]).includes(body.modemPreset)) {
      return { error: `modemPreset must be one of ${MODEM_PRESETS.join(", ")}` };
    }
    value.modemPreset = body.modemPreset as ModemPreset;
  }
  if (body?.frequencySlot !== undefined) {
    const slot = body.frequencySlot;
    if (!Number.isInteger(slot) || slot < 0 || slot > MAX_FREQUENCY_SLOT) {
      return { error: `frequencySlot must be a whole number from 0 to ${MAX_FREQUENCY_SLOT}` };
    }
    value.frequencySlot = slot;
  }
  if (Object.keys(value).length === 0) {
    return { error: "no supported settings in request" };
  }
  return { value };
}

const CHANNEL_ROLES: ChannelRole[] = ["PRIMARY", "SECONDARY", "DISABLED"];
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * The firmware accepts a lot it should not -- a disabled primary, a key of
 * any length -- and then behaves oddly rather than refusing. Refuse here.
 */
function validateChannelUpdate(
  index: number,
  body: ChannelUpdate | undefined,
): { value: ChannelUpdate } | { error: string } {
  if (!Number.isInteger(index) || index < 0 || index > 7) {
    return { error: "channel index must be 0-7" };
  }
  if (!body) return { error: "missing channel" };

  if (!CHANNEL_ROLES.includes(body.role)) {
    return { error: `role must be one of ${CHANNEL_ROLES.join(", ")}` };
  }
  // Exactly one primary, and it lives in slot 0: firmware derives the
  // frequency slot and the default key's scope from it.
  if (index === 0 && body.role !== "PRIMARY") {
    return { error: "channel 0 is the primary channel and cannot be disabled or demoted" };
  }
  if (index !== 0 && body.role === "PRIMARY") {
    return { error: "only channel 0 can be the primary channel" };
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (Buffer.byteLength(name, "utf8") > MAX_CHANNEL_NAME_BYTES) {
    return { error: `name must be at most ${MAX_CHANNEL_NAME_BYTES} bytes` };
  }
  if (body.role === "SECONDARY" && name.length === 0) {
    return { error: "a secondary channel needs a name" };
  }

  if (typeof body.psk !== "string" || !STRICT_BASE64.test(body.psk)) {
    return { error: "psk must be base64" };
  }
  const keyLength = Buffer.from(body.psk, "base64").length;
  if (![0, 1, 16, 32].includes(keyLength)) {
    return {
      error: "psk must be empty (no encryption), 1 byte (a well-known key), 16 bytes (AES-128) or 32 bytes (AES-256)",
    };
  }

  const precision = body.positionPrecision;
  if (!Number.isInteger(precision) || precision < 0 || precision > 32) {
    return { error: "positionPrecision must be a whole number from 0 to 32" };
  }

  return {
    value: {
      role: body.role,
      name,
      psk: body.psk,
      uplinkEnabled: body.uplinkEnabled === true,
      downlinkEnabled: body.downlinkEnabled === true,
      positionPrecision: precision,
    },
  };
}
