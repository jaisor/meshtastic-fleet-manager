import type { Db } from "../index.js";
import type {
  AdminCapability,
  FleetNode,
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
