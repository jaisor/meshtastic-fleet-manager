import type { Db } from "../index.js";
import type { AdminOperation, AdminOperationState } from "../../../shared/types.js";

/**
 * Audit log for every remote write. Mesh writes are slow and lossy, so an
 * operation is a row with a lifecycle (pending -> confirmed | failed)
 * rather than a function that either returns or throws.
 */
export class AdminOperationRepository {
  constructor(private readonly db: Db) {}

  create(nodeNum: number, kind: string, detail: string | null): number {
    const result = this.db
      .prepare(
        `INSERT INTO admin_operations (node_num, kind, state, detail, created_at)
         VALUES (?, ?, 'pending', ?, ?)`,
      )
      .run(nodeNum, kind, detail, Math.floor(Date.now() / 1000));
    return Number(result.lastInsertRowid);
  }

  settle(
    id: number,
    state: Exclude<AdminOperationState, "pending">,
    errorText: string | null,
  ): void {
    this.db
      .prepare(
        `UPDATE admin_operations
         SET state = ?, error_text = ?, settled_at = ?
         WHERE id = ? AND state = 'pending'`,
      )
      .run(state, errorText, Math.floor(Date.now() / 1000), id);
  }

  attachPacketId(id: number, packetId: number): void {
    this.db
      .prepare("UPDATE admin_operations SET packet_id = ? WHERE id = ?")
      .run(packetId, id);
  }

  recentFor(nodeNum: number, limit: number): AdminOperation[] {
    return this.db
      .prepare<[number, number], AdminOperation>(
        `SELECT id, node_num AS nodeNum, kind, state, detail,
                error_text AS errorText, created_at AS createdAt,
                settled_at AS settledAt
         FROM admin_operations WHERE node_num = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(nodeNum, limit);
  }

  /**
   * Marks operations abandoned when the process restarts. A pending row
   * with no in-memory waiter would otherwise spin forever in the UI.
   */
  failAllPending(reason: string): number {
    return this.db
      .prepare(
        `UPDATE admin_operations
         SET state = 'failed', error_text = ?, settled_at = ?
         WHERE state = 'pending'`,
      )
      .run(reason, Math.floor(Date.now() / 1000)).changes;
  }
}
