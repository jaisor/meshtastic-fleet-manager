import { Protobuf } from "@meshtastic/core";
import type { NodeRadioConfig } from "../../shared/types.js";

/**
 * Builds a `NodeRadioConfig` snapshot out of protobuf config messages.
 *
 * Both paths that produce one land here: the local radio's config dump over
 * USB, and the admin reads against a remote node. Keeping the mapping in one
 * place is what stops the two drifting -- the local node is the one whose
 * values you can check against the Meshtastic app, so it is the one that
 * would hide a mapping bug on every other node.
 *
 * **Every read goes through `num`/`bool`, which map `undefined` to null.**
 * That is not defensiveness for its own sake: `@meshtastic/core` bundles its
 * own older copy of the protobufs and it is that copy which decodes what
 * arrives, so a field added to `@meshtastic/protobufs` since is simply absent
 * at runtime even though the types promise it. Reading one raw yields
 * `undefined`, which would then store as 0 or `false` -- a fabricated setting.
 * Null says "not read", which is true. See CLAUDE.md section 4.
 *
 * **Zero is kept, not nulled.** Firmware overloads 0 on most of these to
 * mean "use the built-in default", and on `channelNum` to mean "derive the
 * slot from the channel name" -- real settings, distinct from a field we
 * never read. Null is reserved for the latter, and the UI spells out what a
 * zero means per field. Collapsing them would report a node broadcasting
 * every three hours as broadcasting never.
 */

/**
 * Coerce a protobuf field to a stored value, mapping absence to null.
 *
 * A field missing from the runtime protobuf copy reads as `undefined`, and
 * both of these keep that distinct from a genuine 0 or `false`.
 */
function num(value: number | undefined): number | null {
  return value === undefined ? null : value;
}

function bool(value: boolean | undefined): boolean | null {
  return value === undefined ? null : value;
}

/** A snapshot with nothing read yet. */
export function emptyRadioConfig(fetchedAt: number): NodeRadioConfig {
  return {
    fetchedAt,
    region: null,
    modemPreset: null,
    usesPreset: null,
    bandwidth: null,
    spreadFactor: null,
    codingRate: null,
    frequencySlot: null,
    hopLimit: null,
    txPower: null,
    txEnabled: null,
    nodeInfoInterval: null,
    positionInterval: null,
    gpsUpdateInterval: null,
    deviceMetricsInterval: null,
    environmentInterval: null,
    environmentEnabled: null,
    airQualityInterval: null,
    airQualityEnabled: null,
    powerInterval: null,
    powerEnabled: null,
    healthInterval: null,
    healthEnabled: null,
  };
}

/** Numeric protobuf enum -> its name, for display and storage. */
function enumName(
  table: Record<number, string> | object,
  value: number | undefined,
): string | null {
  if (value === undefined) return null;
  const name = (table as Record<number, string>)[value];
  return typeof name === "string" ? name : null;
}

export function applyLoRa(
  target: NodeRadioConfig,
  lora: Protobuf.Config.Config_LoRaConfig,
): void {
  target.region = enumName(Protobuf.Config.Config_LoRaConfig_RegionCode, lora.region);
  target.modemPreset = enumName(
    Protobuf.Config.Config_LoRaConfig_ModemPreset,
    lora.modemPreset,
  );
  target.usesPreset = bool(lora.usePreset);
  target.bandwidth = num(lora.bandwidth);
  target.spreadFactor = num(lora.spreadFactor);
  target.codingRate = num(lora.codingRate);
  target.frequencySlot = num(lora.channelNum);
  target.hopLimit = num(lora.hopLimit);
  target.txPower = num(lora.txPower);
  target.txEnabled = bool(lora.txEnabled);
}

export function applyDevice(
  target: NodeRadioConfig,
  device: Protobuf.Config.Config_DeviceConfig,
): void {
  target.nodeInfoInterval = num(device.nodeInfoBroadcastSecs);
}

export function applyPosition(
  target: NodeRadioConfig,
  position: Protobuf.Config.Config_PositionConfig,
): void {
  target.positionInterval = num(position.positionBroadcastSecs);
  target.gpsUpdateInterval = num(position.gpsUpdateInterval);
}

export function applyTelemetry(
  target: NodeRadioConfig,
  telemetry: Protobuf.ModuleConfig.ModuleConfig_TelemetryConfig,
): void {
  // No `deviceTelemetryEnabled` here on purpose: the field exists in the
  // protobuf types but not in the copy `@meshtastic/core` decodes with, so it
  // would be null on every node forever. The interval alone is honest.
  target.deviceMetricsInterval = num(telemetry.deviceUpdateInterval);
  target.environmentInterval = num(telemetry.environmentUpdateInterval);
  target.environmentEnabled = bool(telemetry.environmentMeasurementEnabled);
  target.airQualityInterval = num(telemetry.airQualityInterval);
  target.airQualityEnabled = bool(telemetry.airQualityEnabled);
  target.powerInterval = num(telemetry.powerUpdateInterval);
  target.powerEnabled = bool(telemetry.powerMeasurementEnabled);
  target.healthInterval = num(telemetry.healthUpdateInterval);
  target.healthEnabled = bool(telemetry.healthMeasurementEnabled);
}

/**
 * Folds a `Config` message into a snapshot, whichever variant it carries.
 *
 * The local dump arrives as a series of single-variant `Config` messages, so
 * this is called once per variant and ignores the ones we do not surface.
 * Returns whether anything was recognized, which is what lets the remote
 * read report a partial result honestly.
 */
export function applyConfig(
  target: NodeRadioConfig,
  config: Protobuf.Config.Config,
): boolean {
  switch (config.payloadVariant.case) {
    case "lora":
      applyLoRa(target, config.payloadVariant.value);
      return true;
    case "device":
      applyDevice(target, config.payloadVariant.value);
      return true;
    case "position":
      applyPosition(target, config.payloadVariant.value);
      return true;
    default:
      return false;
  }
}

/** As `applyConfig`, for the module half of the settings. */
export function applyModuleConfig(
  target: NodeRadioConfig,
  config: Protobuf.ModuleConfig.ModuleConfig,
): boolean {
  if (config.payloadVariant.case === "telemetry") {
    applyTelemetry(target, config.payloadVariant.value);
    return true;
  }
  return false;
}
