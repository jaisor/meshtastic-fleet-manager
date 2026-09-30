import type { Db } from "../index.js";
import type {
  AdminCapability,
  FleetNode,
  NodeRadioConfig,
  NodeState,
  PositionPoint,
  SignalQuality,
  TelemetryPoint,
} from "../../../shared/types.js";
import { toNodeId } from "../../mesh/nodeId.js";

interface NodeRow {
  node_num: number;
  short_name: string | null;
  long_name: string | null;
  hw_model: string | null;
  role: string | null;
  firmware_version: string | null;
  is_local: number;
  first_seen_at: number;
  last_heard_at: number | null;
  snr: number | null;
  rssi: number | null;
  hops_away: number | null;
  battery_level: number | null;
  voltage: number | null;
  admin_capability: string;
  admin_checked_at: number | null;
}

/** `node_config` as SQLite hands it back: booleans are 0/1 or null. */
interface NodeConfigRow {
  fetched_at: number;
  region: string | null;
  modem_preset: string | null;
  uses_preset: number | null;
  bandwidth: number | null;
  spread_factor: number | null;
  coding_rate: number | null;
  frequency_slot: number | null;
  hop_limit: number | null;
  tx_power: number | null;
  tx_enabled: number | null;
  node_info_interval: number | null;
  position_interval: number | null;
  gps_update_interval: number | null;
  device_metrics_interval: number | null;
  environment_interval: number | null;
  environment_enabled: number | null;
  air_quality_interval: number | null;
  air_quality_enabled: number | null;
  power_interval: number | null;
  power_enabled: number | null;
  health_interval: number | null;
  health_enabled: number | null;
}

/**
 * SQLite has no boolean type. These round-trip through 0/1 while preserving
 * null, which here means "not read" and must not collapse into `false`.
 */
function asInt(value: boolean | null | undefined): number | null {
  return value === null || value === undefined ? null : value ? 1 : 0;
}

function asBool(value: number | null): boolean | null {
  return value === null ? null : value === 1;
}

function toRadioConfig(row: NodeConfigRow): NodeRadioConfig {
  return {
    fetchedAt: row.fetched_at,
    region: row.region,
    modemPreset: row.modem_preset,
    usesPreset: asBool(row.uses_preset),
    bandwidth: row.bandwidth,
    spreadFactor: row.spread_factor,
    codingRate: row.coding_rate,
    frequencySlot: row.frequency_slot,
    hopLimit: row.hop_limit,
    txPower: row.tx_power,
    txEnabled: asBool(row.tx_enabled),
    nodeInfoInterval: row.node_info_interval,
    positionInterval: row.position_interval,
    gpsUpdateInterval: row.gps_update_interval,
    deviceMetricsInterval: row.device_metrics_interval,
    environmentInterval: row.environment_interval,
    environmentEnabled: asBool(row.environment_enabled),
    airQualityInterval: row.air_quality_interval,
    airQualityEnabled: asBool(row.air_quality_enabled),
    powerInterval: row.power_interval,
    powerEnabled: asBool(row.power_enabled),
    healthInterval: row.health_interval,
    healthEnabled: asBool(row.health_enabled),
  };
}

/** Fields an ingest may set. Undefined means "leave whatever we had". */
export interface NodeUpsert {
  nodeNum: number;
  shortName?: string | null;
  longName?: string | null;
  hwModel?: string | null;
  role?: string | null;
  firmwareVersion?: string | null;
  publicKey?: Uint8Array | null;
  isLocal?: boolean;
  lastHeardAt?: number | null;
  snr?: number | null;
  rssi?: number | null;
  hopsAway?: number | null;
  batteryLevel?: number | null;
  voltage?: number | null;
}

export interface StaleThresholds {
  staleAfter: number;
  offlineAfter: number;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function deriveState(
  lastHeardAt: number | null,
  thresholds: StaleThresholds,
): NodeState {
  if (lastHeardAt === null) return "offline";
  const age = nowSeconds() - lastHeardAt;
  if (age <= thresholds.staleAfter) return "online";
  if (age <= thresholds.offlineAfter) return "stale";
  return "offline";
}

/**
 * Classifies link quality from the last direct measurement.
 *
 * Thresholds are judgment calls, not a standard. LoRa demodulates below the
 * noise floor -- Meshtastic's default preset bottoms out near -17.5 dB SNR --
 * so a negative SNR is normal and only the margin above that floor matters:
 *
 *   SNR  >= -5 dB   comfortable margin
 *        >= -12 dB  workable, degrading
 *         < -12 dB  within a few dB of not decoding at all
 *
 * RSSI is the coarser check, against a typical LoRa sensitivity near
 * -130 dBm. When both are present the *worse* of the two wins: a strong
 * carrier buried in noise is not a good link, and neither is a clean but
 * vanishingly faint one.
 */
function deriveSignal(snr: number | null, rssi: number | null): SignalQuality {
  const ladder: SignalQuality[] = ["bad", "medium", "good"];
  const ranks: number[] = [];

  if (snr !== null) ranks.push(snr >= -5 ? 2 : snr >= -12 ? 1 : 0);
  if (rssi !== null) ranks.push(rssi >= -115 ? 2 : rssi >= -126 ? 1 : 0);
  if (ranks.length === 0) return "unknown";

  return ladder[Math.min(...ranks)] ?? "unknown";
}

function toFleetNode(row: NodeRow, thresholds: StaleThresholds): FleetNode {
  return {
    nodeNum: row.node_num,
    nodeId: toNodeId(row.node_num),
    shortName: row.short_name,
    longName: row.long_name,
    hwModel: row.hw_model,
    role: row.role,
    firmwareVersion: row.firmware_version,
    lastHeardAt: row.last_heard_at,
    firstSeenAt: row.first_seen_at,
    state: deriveState(row.last_heard_at, thresholds),
    isLocal: row.is_local === 1,
    snr: row.snr,
    rssi: row.rssi,
    signal: deriveSignal(row.snr, row.rssi),
    hopsAway: row.hops_away,
    batteryLevel: row.battery_level,
    voltage: row.voltage,
    adminCapability: row.admin_capability as AdminCapability,
    adminCheckedAt: row.admin_checked_at,
  };
}

export class NodeRepository {
  constructor(
    private readonly db: Db,
    private readonly thresholds: StaleThresholds,
  ) {}

  /**
   * Insert-or-update by node number. Every optional column uses
   * `COALESCE(excluded.x, nodes.x)` so a packet that carries only a
   * position does not blank out a name learned from an earlier NodeInfo.
   */
  upsert(node: NodeUpsert): void {
    this.db
      .prepare(
        `
        INSERT INTO nodes (
          node_num, short_name, long_name, hw_model, role, firmware_version,
          public_key, is_local, first_seen_at, last_heard_at, snr, rssi,
          hops_away, battery_level, voltage
        ) VALUES (
          @nodeNum, @shortName, @longName, @hwModel, @role, @firmwareVersion,
          @publicKey, @isLocal, @now, @lastHeardAt, @snr, @rssi,
          @hopsAway, @batteryLevel, @voltage
        )
        ON CONFLICT(node_num) DO UPDATE SET
          short_name       = COALESCE(excluded.short_name, nodes.short_name),
          long_name        = COALESCE(excluded.long_name, nodes.long_name),
          hw_model         = COALESCE(excluded.hw_model, nodes.hw_model),
          role             = COALESCE(excluded.role, nodes.role),
          firmware_version = COALESCE(excluded.firmware_version, nodes.firmware_version),
          public_key       = COALESCE(excluded.public_key, nodes.public_key),
          is_local         = MAX(excluded.is_local, nodes.is_local),
          snr              = COALESCE(excluded.snr, nodes.snr),
          rssi             = COALESCE(excluded.rssi, nodes.rssi),
          hops_away        = COALESCE(excluded.hops_away, nodes.hops_away),
          battery_level    = COALESCE(excluded.battery_level, nodes.battery_level),
          voltage          = COALESCE(excluded.voltage, nodes.voltage),
          -- Never move last_heard_at backwards: packets can arrive out of order.
          last_heard_at    = MAX(
                               COALESCE(excluded.last_heard_at, 0),
                               COALESCE(nodes.last_heard_at, 0)
                             )
        `,
      )
      .run({
        nodeNum: node.nodeNum,
        shortName: node.shortName ?? null,
        longName: node.longName ?? null,
        hwModel: node.hwModel ?? null,
        role: node.role ?? null,
        firmwareVersion: node.firmwareVersion ?? null,
        publicKey: node.publicKey ? Buffer.from(node.publicKey) : null,
        isLocal: node.isLocal ? 1 : 0,
        now: nowSeconds(),
        lastHeardAt: node.lastHeardAt ?? null,
        snr: node.snr ?? null,
        rssi: node.rssi ?? null,
        hopsAway: node.hopsAway ?? null,
        batteryLevel: node.batteryLevel ?? null,
        voltage: node.voltage ?? null,
      });
  }

  list(): FleetNode[] {
    const rows = this.db
      .prepare<[], NodeRow>(
        `SELECT * FROM nodes
         ORDER BY is_local DESC, last_heard_at DESC NULLS LAST, node_num`,
      )
      .all();
    return rows.map((row) => toFleetNode(row, this.thresholds));
  }

  /**
   * Cheap membership test for the discovery gate, which runs on every
   * inbound packet. Avoids building a whole FleetNode just to ask whether
   * the row is there.
   */
  exists(nodeNum: number): boolean {
    return (
      this.db
        .prepare<[number], { one: number }>(
          "SELECT 1 AS one FROM nodes WHERE node_num = ?",
        )
        .get(nodeNum) !== undefined
    );
  }

  get(nodeNum: number): FleetNode | null {
    const row = this.db
      .prepare<[number], NodeRow>("SELECT * FROM nodes WHERE node_num = ?")
      .get(nodeNum);
    return row ? toFleetNode(row, this.thresholds) : null;
  }

  setAdminCapability(nodeNum: number, capability: AdminCapability): void {
    this.db
      .prepare("UPDATE nodes SET admin_capability = ?, admin_checked_at = ? WHERE node_num = ?")
      .run(capability, nowSeconds(), nodeNum);
  }

  /** Nodes whose admin verdict is older than `interval`, oldest first. */
  needingAdminProbe(interval: number, limit: number): FleetNode[] {
    const cutoff = nowSeconds() - interval;
    const rows = this.db
      .prepare<[number, number], NodeRow>(
        `SELECT * FROM nodes
         WHERE is_local = 0
           AND (admin_checked_at IS NULL OR admin_checked_at < ?)
         ORDER BY admin_checked_at ASC NULLS FIRST
         LIMIT ?`,
      )
      .all(cutoff, limit);
    return rows.map((row) => toFleetNode(row, this.thresholds));
  }

  recordTelemetry(nodeNum: number, point: TelemetryPoint): void {
    this.db
      .prepare(
        `INSERT INTO telemetry (
           node_num, recorded_at, battery_level, voltage, channel_utilization,
           air_util_tx, uptime_seconds, temperature, relative_humidity,
           barometric_pressure
         ) VALUES (
           @nodeNum, @recordedAt, @batteryLevel, @voltage, @channelUtilization,
           @airUtilTx, @uptimeSeconds, @temperature, @relativeHumidity,
           @barometricPressure
         )`,
      )
      .run({ nodeNum, ...point });
  }

  telemetryFor(nodeNum: number, limit: number): TelemetryPoint[] {
    return this.db
      .prepare<[number, number], TelemetryPoint & { id: number }>(
        `SELECT recorded_at AS recordedAt, battery_level AS batteryLevel,
                voltage, channel_utilization AS channelUtilization,
                air_util_tx AS airUtilTx, uptime_seconds AS uptimeSeconds,
                temperature, relative_humidity AS relativeHumidity,
                barometric_pressure AS barometricPressure
         FROM telemetry WHERE node_num = ?
         ORDER BY recorded_at DESC LIMIT ?`,
      )
      .all(nodeNum, limit);
  }

  recordPosition(nodeNum: number, point: PositionPoint): void {
    this.db
      .prepare(
        `INSERT INTO positions (node_num, recorded_at, latitude, longitude, altitude)
         VALUES (@nodeNum, @recordedAt, @latitude, @longitude, @altitude)`,
      )
      .run({ nodeNum, ...point });
  }

  positionsFor(nodeNum: number, limit: number): PositionPoint[] {
    return this.db
      .prepare<[number, number], PositionPoint>(
        `SELECT recorded_at AS recordedAt, latitude, longitude, altitude
         FROM positions WHERE node_num = ?
         ORDER BY recorded_at DESC LIMIT ?`,
      )
      .all(nodeNum, limit);
  }

  /**
   * Replaces a node's settings snapshot wholesale.
   *
   * A whole-row replace rather than a field-wise merge, because the
   * snapshot's `fetchedAt` has to mean something: merging a fresh LoRa read
   * over month-old telemetry intervals would produce a row that never
   * existed on any node, stamped with today's date. A read that only
   * partially answered therefore leaves the fields it could not get null,
   * and the UI says which.
   */
  saveConfig(nodeNum: number, config: NodeRadioConfig): void {
    this.db
      .prepare(
        `INSERT INTO node_config (
           node_num, fetched_at, region, modem_preset, uses_preset, bandwidth,
           spread_factor, coding_rate, frequency_slot, hop_limit, tx_power,
           tx_enabled, node_info_interval, position_interval,
           gps_update_interval, device_metrics_interval,
           environment_interval, environment_enabled, air_quality_interval,
           air_quality_enabled, power_interval, power_enabled, health_interval,
           health_enabled
         ) VALUES (
           @nodeNum, @fetchedAt, @region, @modemPreset, @usesPreset, @bandwidth,
           @spreadFactor, @codingRate, @frequencySlot, @hopLimit, @txPower,
           @txEnabled, @nodeInfoInterval, @positionInterval,
           @gpsUpdateInterval, @deviceMetricsInterval,
           @environmentInterval, @environmentEnabled, @airQualityInterval,
           @airQualityEnabled, @powerInterval, @powerEnabled, @healthInterval,
           @healthEnabled
         )
         ON CONFLICT(node_num) DO UPDATE SET
           fetched_at = excluded.fetched_at,
           region = excluded.region,
           modem_preset = excluded.modem_preset,
           uses_preset = excluded.uses_preset,
           bandwidth = excluded.bandwidth,
           spread_factor = excluded.spread_factor,
           coding_rate = excluded.coding_rate,
           frequency_slot = excluded.frequency_slot,
           hop_limit = excluded.hop_limit,
           tx_power = excluded.tx_power,
           tx_enabled = excluded.tx_enabled,
           node_info_interval = excluded.node_info_interval,
           position_interval = excluded.position_interval,
           gps_update_interval = excluded.gps_update_interval,
           device_metrics_interval = excluded.device_metrics_interval,
           environment_interval = excluded.environment_interval,
           environment_enabled = excluded.environment_enabled,
           air_quality_interval = excluded.air_quality_interval,
           air_quality_enabled = excluded.air_quality_enabled,
           power_interval = excluded.power_interval,
           power_enabled = excluded.power_enabled,
           health_interval = excluded.health_interval,
           health_enabled = excluded.health_enabled`,
      )
      .run({
        nodeNum,
        fetchedAt: config.fetchedAt,
        region: config.region,
        modemPreset: config.modemPreset,
        usesPreset: asInt(config.usesPreset),
        bandwidth: config.bandwidth,
        spreadFactor: config.spreadFactor,
        codingRate: config.codingRate,
        frequencySlot: config.frequencySlot,
        hopLimit: config.hopLimit,
        txPower: config.txPower,
        txEnabled: asInt(config.txEnabled),
        nodeInfoInterval: config.nodeInfoInterval,
        positionInterval: config.positionInterval,
        gpsUpdateInterval: config.gpsUpdateInterval,
        deviceMetricsInterval: config.deviceMetricsInterval,
        environmentInterval: config.environmentInterval,
        environmentEnabled: asInt(config.environmentEnabled),
        airQualityInterval: config.airQualityInterval,
        airQualityEnabled: asInt(config.airQualityEnabled),
        powerInterval: config.powerInterval,
        powerEnabled: asInt(config.powerEnabled),
        healthInterval: config.healthInterval,
        healthEnabled: asInt(config.healthEnabled),
      });
  }

  /** The stored settings snapshot, or null when nobody has read them. */
  configFor(nodeNum: number): NodeRadioConfig | null {
    const row = this.db
      .prepare<[number], NodeConfigRow>(
        "SELECT * FROM node_config WHERE node_num = ?",
      )
      .get(nodeNum);
    return row ? toRadioConfig(row) : null;
  }

  /** Drops history older than `retention` seconds. Node rows are kept. */
  pruneHistory(retention: number): number {
    const cutoff = nowSeconds() - retention;
    const telemetry = this.db
      .prepare("DELETE FROM telemetry WHERE recorded_at < ?")
      .run(cutoff);
    const positions = this.db
      .prepare("DELETE FROM positions WHERE recorded_at < ?")
      .run(cutoff);
    return telemetry.changes + positions.changes;
  }
}
