import type { Db } from "../index.js";
import type { ChannelRole, RadioChannel } from "../../../shared/types.js";
import { pskKind, type StoredChannel } from "../../mesh/radioConfig.js";

interface ChannelRow {
  idx: number;
  role: string;
  name: string;
  psk: Buffer | null;
  uplink_enabled: number;
  downlink_enabled: number;
  position_precision: number | null;
  fetched_at: number;
}

/**
 * The local radio's channel table.
 *
 * Keys are stored, and handed out only when the caller says the reader may
 * see them: `list` takes that decision as an argument rather than making it,
 * so the one place that knows who is asking -- the route -- has to.
 */
export class ChannelRepository {
  constructor(private readonly db: Db) {}

  /** Insert or replace one slot. Firmware always sends a channel whole. */
  save(nodeNum: number, channel: StoredChannel): void {
    this.db
      .prepare(
        `INSERT INTO channels (
           node_num, idx, role, name, psk, uplink_enabled, downlink_enabled,
           position_precision, fetched_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (node_num, idx) DO UPDATE SET
           role = excluded.role,
           name = excluded.name,
           psk = excluded.psk,
           uplink_enabled = excluded.uplink_enabled,
           downlink_enabled = excluded.downlink_enabled,
           position_precision = excluded.position_precision,
           fetched_at = excluded.fetched_at`,
      )
      .run(
        nodeNum,
        channel.index,
        channel.role,
        channel.name,
        Buffer.from(channel.psk),
        channel.uplinkEnabled ? 1 : 0,
        channel.downlinkEnabled ? 1 : 0,
        channel.positionPrecision,
        channel.fetchedAt,
      );
  }

  list(nodeNum: number, options: { includeKeys: boolean }): RadioChannel[] {
    return this.db
      .prepare<[number], ChannelRow>(
        "SELECT * FROM channels WHERE node_num = ? ORDER BY idx",
      )
      .all(nodeNum)
      .map((row) => {
        const psk = row.psk ?? Buffer.alloc(0);
        return {
          index: row.idx,
          role: row.role as ChannelRole,
          name: row.name,
          pskKind: pskKind(psk),
          psk: options.includeKeys ? psk.toString("base64") : null,
          uplinkEnabled: row.uplink_enabled === 1,
          downlinkEnabled: row.downlink_enabled === 1,
          positionPrecision: row.position_precision,
          fetchedAt: row.fetched_at,
        };
      });
  }
}
