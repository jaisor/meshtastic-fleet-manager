import { fromBinary, toBinary, toJson, type DescMessage } from "@bufbuild/protobuf";
import { Protobuf } from "@meshtastic/core";
import {
  Channel as CurrentChannel,
  Config as CurrentConfig,
  Mesh as CurrentMesh,
  ModuleConfig as CurrentModuleConfig,
} from "@meshtastic/protobufs";
import {
  RAW_CONFIG_SECTIONS,
  type RawConfigReadResult,
  type RawConfigSectionId,
} from "../../shared/rawConfig.js";
import { AdminError, type AdminClient } from "./admin.js";
import { logNode } from "./nodeId.js";
import { pskKind } from "./radioConfig.js";
import { TaskCancelledError } from "./tasks.js";
import type { FastifyBaseLogger } from "fastify";

/**
 * A node's full configuration as JSON, for the raw view.
 *
 * **Encoded with the newer schema, not the one that decoded it.** The admin
 * reply is decoded by `@meshtastic/core`'s bundled protobufs, which predate
 * fields such as `LoRaConfig.femLnaMode`; those survive only as unknown fields
 * and `toJson` would drop them without a word (CLAUDE.md section 4). Re-encoding
 * keeps the unknown fields, so decoding those bytes again with
 * `@meshtastic/protobufs` recovers them. That is safe here because the decoding
 * is ours; on paths the library decodes, the bundled copy still wins. A field
 * neither schema knows is listed by number under `$unknownFields`, so a view
 * calling itself raw does not hide that something was left out. Its value is
 * not shown, since a future field could be a secret this file has not heard of.
 *
 * **Secrets are removed here, before anything is stored or sent.** Firmware
 * withholds the private key, Wi-Fi password and MQTT password from a remote
 * requester, but a request over USB counts as local and gets them all, and every
 * channel reply carries its key. No role sees these through this view: stored
 * JSON outlives a role change and is one copy-paste from a chat window.
 */

/**
 * Field names holding secrets. Matched by name so that a future `apiToken` is
 * withheld by default, and narrow enough to leave the many GPIO fields alone
 * (`pttPin`, `monitorPin`). Public keys and admin keys stay: they are public,
 * and reading who may administer a node is much of the point of this view.
 */
const SECRET_FIELD =
  /private_?key|psk|password|passphrase|passkey|secret|token|credential|fixed_?pin|pin_?code/i;

const REDACTED = "<redacted>";

/** An unset secret stays visibly unset: "no Wi-Fi password" is worth reading. */
function isUnset(value: unknown): boolean {
  return (
    value === "" ||
    value === 0 ||
    value === false ||
    value === null ||
    value === undefined
  );
}

/** Copies decoded JSON with every secret replaced. Exported to be tested. */
export function redactSecrets(value: unknown, key?: string): unknown {
  if (key !== undefined && SECRET_FIELD.test(key)) {
    if (isUnset(value)) return value;
    // A channel key's kind is safe to show anyone, and it is what an operator
    // needs: whether the channel is really private. See `PskKind`.
    if (key === "psk" && typeof value === "string") {
      return `<redacted: ${pskKind(Buffer.from(value, "base64"))}>`;
    }
    return REDACTED;
  }
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([name, entry]) => [name, redactSecrets(entry, name)]),
    );
  }
  return value;
}

/** Every field number a decoded message kept as unknown, nested ones included. */
function unknownFieldNumbers(message: object, found = new Set<number>()): Set<number> {
  for (const [name, value] of Object.entries(message)) {
    if (name === "$unknown" && Array.isArray(value)) {
      for (const field of value as { no: number }[]) found.add(field.no);
    } else if (value !== null && typeof value === "object" && !ArrayBuffer.isView(value)) {
      unknownFieldNumbers(value as object, found);
    }
  }
  return found;
}

/**
 * Bundled-schema message -> redacted JSON via the newer schema.
 *
 * `unwrap` names the oneof variant holding the interesting part, so a section
 * reads `{ "role": ... }` rather than `{ "device": { "role": ... } }`.
 */
export function toRawJson(
  decodedWith: DescMessage,
  encodeWith: DescMessage,
  message: Parameters<typeof toBinary>[1],
  unwrap?: string,
): Record<string, unknown> {
  const current = fromBinary(encodeWith, toBinary(decodedWith, message));
  const json = toJson(encodeWith, current, { alwaysEmitImplicit: true }) as Record<
    string,
    unknown
  >;
  const body = unwrap === undefined ? json : (json[unwrap] as Record<string, unknown>);
  const unknown = [...unknownFieldNumbers(current)].toSorted((a, b) => a - b);
  return {
    ...(redactSecrets(body) as Record<string, unknown>),
    ...(unknown.length > 0 ? { $unknownFields: unknown } : {}),
  };
}

const CONFIG_TYPES: Partial<
  Record<RawConfigSectionId, Protobuf.Admin.AdminMessage_ConfigType>
> = {
  device: Protobuf.Admin.AdminMessage_ConfigType.DEVICE_CONFIG,
  position: Protobuf.Admin.AdminMessage_ConfigType.POSITION_CONFIG,
  power: Protobuf.Admin.AdminMessage_ConfigType.POWER_CONFIG,
  network: Protobuf.Admin.AdminMessage_ConfigType.NETWORK_CONFIG,
  display: Protobuf.Admin.AdminMessage_ConfigType.DISPLAY_CONFIG,
  lora: Protobuf.Admin.AdminMessage_ConfigType.LORA_CONFIG,
  bluetooth: Protobuf.Admin.AdminMessage_ConfigType.BLUETOOTH_CONFIG,
  security: Protobuf.Admin.AdminMessage_ConfigType.SECURITY_CONFIG,
};

const MODULE_TYPES: Partial<
  Record<RawConfigSectionId, Protobuf.Admin.AdminMessage_ModuleConfigType>
> = {
  mqtt: Protobuf.Admin.AdminMessage_ModuleConfigType.MQTT_CONFIG,
  serial: Protobuf.Admin.AdminMessage_ModuleConfigType.SERIAL_CONFIG,
  externalNotification: Protobuf.Admin.AdminMessage_ModuleConfigType.EXTNOTIF_CONFIG,
  storeForward: Protobuf.Admin.AdminMessage_ModuleConfigType.STOREFORWARD_CONFIG,
  rangeTest: Protobuf.Admin.AdminMessage_ModuleConfigType.RANGETEST_CONFIG,
  telemetry: Protobuf.Admin.AdminMessage_ModuleConfigType.TELEMETRY_CONFIG,
  cannedMessage: Protobuf.Admin.AdminMessage_ModuleConfigType.CANNEDMSG_CONFIG,
  audio: Protobuf.Admin.AdminMessage_ModuleConfigType.AUDIO_CONFIG,
  remoteHardware: Protobuf.Admin.AdminMessage_ModuleConfigType.REMOTEHARDWARE_CONFIG,
  neighborInfo: Protobuf.Admin.AdminMessage_ModuleConfigType.NEIGHBORINFO_CONFIG,
  ambientLighting: Protobuf.Admin.AdminMessage_ModuleConfigType.AMBIENTLIGHTING_CONFIG,
  detectionSensor: Protobuf.Admin.AdminMessage_ModuleConfigType.DETECTIONSENSOR_CONFIG,
  paxcounter: Protobuf.Admin.AdminMessage_ModuleConfigType.PAXCOUNTER_CONFIG,
};

const CHANNEL_SLOTS = 8;

/** Two silent reads in a row: the rest would each sit out a timeout too. */
const MAX_SILENT_READS = 2;

function isSilence(cause: unknown): boolean {
  return cause instanceof AdminError && cause.capability === "unreachable";
}

function isRefusal(cause: unknown): boolean {
  return cause instanceof AdminError && cause.capability === "unauthorized";
}

/** One section's reads. Returns its JSON, and any slots that went unanswered. */
async function readSection(
  admin: AdminClient,
  nodeNum: number,
  id: RawConfigSectionId,
  signal?: AbortSignal,
): Promise<{ data: unknown; missing?: string }> {
  const configType = CONFIG_TYPES[id];
  if (configType !== undefined) {
    const config = await admin.getConfig(nodeNum, configType, signal);
    if (config.payloadVariant.case !== id) {
      throw new AdminError(`the node sent no ${id} settings`, "unknown");
    }
    return {
      data: toRawJson(
        Protobuf.Config.ConfigSchema,
        CurrentConfig.ConfigSchema,
        config,
        id,
      ),
    };
  }

  const moduleType = MODULE_TYPES[id];
  if (moduleType !== undefined) {
    const config = await admin.getModuleConfig(nodeNum, moduleType, signal);
    if (config.payloadVariant.case !== id) {
      // A build with the module compiled out answers with nothing in it.
      throw new AdminError(`the node sent no ${id} settings`, "unknown");
    }
    return {
      data: toRawJson(
        Protobuf.ModuleConfig.ModuleConfigSchema,
        CurrentModuleConfig.ModuleConfigSchema,
        config,
        id,
      ),
    };
  }

  if (id === "owner") {
    const owner = await admin.getOwner(nodeNum, signal);
    return { data: toRawJson(Protobuf.Mesh.UserSchema, CurrentMesh.UserSchema, owner) };
  }

  if (id === "metadata") {
    const metadata = await admin.getMetadata(nodeNum, signal);
    return {
      data: toRawJson(
        Protobuf.Mesh.DeviceMetadataSchema,
        CurrentMesh.DeviceMetadataSchema,
        metadata,
      ),
    };
  }

  const channels: unknown[] = [];
  const missing: number[] = [];
  let lastFailure: unknown = null;
  for (let index = 0; index < CHANNEL_SLOTS; index++) {
    try {
      const channel = await admin.getChannel(nodeNum, index, signal);
      channels.push(
        toRawJson(Protobuf.Channel.ChannelSchema, CurrentChannel.ChannelSchema, channel),
      );
    } catch (cause) {
      if (cause instanceof TaskCancelledError || isRefusal(cause)) throw cause;
      missing.push(index);
      lastFailure = cause;
      // The section's own slots would otherwise run the node's silence to
      // eight timeouts, where the outer loop stops at two.
      if (isSilence(cause) && missing.length >= MAX_SILENT_READS) break;
    }
  }
  if (channels.length === 0) throw lastFailure;
  return {
    data: channels,
    ...(missing.length > 0
      ? { missing: `channel slots ${missing.join(", ")} did not answer` }
      : {}),
  };
}

export interface RawConfigOutcome
  extends Omit<RawConfigReadResult, "sections"> {
  /**
   * What the failures establish about admin rights, when nothing was read.
   * Null when something answered, which already proves them, or when no
   * failure said anything about them.
   */
  verdict: "unauthorized" | "unreachable" | null;
}

/**
 * Reads the requested sections one at a time, handing each to `onSection` as it
 * arrives, so a cancel or a dropped link keeps what already came back.
 *
 * Sequential for the reason `readRadioConfig` is. Unlike that one it does not
 * always press on past a failure: it can be thirty round trips, so one refusal,
 * or two silences in a row, ends it rather than spending fifteen minutes
 * confirming a node is gone. Any other failure skips just that section, since a
 * firmware build with a module compiled out still answers the rest.
 */
export async function readRawConfig(
  admin: AdminClient,
  nodeNum: number,
  sections: readonly RawConfigSectionId[],
  options: {
    signal?: AbortSignal;
    logger: FastifyBaseLogger;
    onSection: (section: RawConfigSectionId, data: unknown) => void;
  },
): Promise<RawConfigOutcome> {
  const wanted = RAW_CONFIG_SECTIONS.map((entry) => entry.id).filter((id) =>
    sections.includes(id),
  );
  const outcome: RawConfigOutcome = { read: [], failed: [], skipped: [], verdict: null };
  let silent = 0;

  for (const [position, id] of wanted.entries()) {
    try {
      const { data, missing } = await readSection(admin, nodeNum, id, options.signal);
      options.onSection(id, data);
      outcome.read.push(id);
      silent = 0;
      if (missing) outcome.failed.push({ section: id, error: missing });
    } catch (cause) {
      if (cause instanceof TaskCancelledError) throw cause;
      const error = (cause as Error).message;
      outcome.failed.push({ section: id, error });
      options.logger.debug(
        { ...logNode(nodeNum), section: id, err: error },
        "raw config read failed",
      );

      const refused = isRefusal(cause);
      silent = isSilence(cause) ? silent + 1 : 0;
      if (refused || silent >= MAX_SILENT_READS) {
        outcome.skipped = wanted.slice(position + 1);
        if (outcome.read.length === 0) {
          outcome.verdict = refused ? "unauthorized" : "unreachable";
        }
        break;
      }
    }
  }
  return outcome;
}
