import type { Db } from "../index.js";
import type { FleetQuery } from "../../../shared/fleetQuery.js";

export type AssistantOutcome = "answered" | "not_understood" | "failed";

export interface AssistantQueryRecord {
  username: string;
  prompt: string;
  provider: string;
  model: string;
  outcome: AssistantOutcome;
  query: FleetQuery | null;
  note: string | null;
  errorText: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
}

/**
 * Audit log for the assistant, and the source of its daily token budget.
 *
 * One row per question that reached the provider. A question refused before
 * that -- over budget, wrong role, assistant off -- cost nothing and is not
 * recorded here.
 */
export class AssistantQueryRepository {
  constructor(private readonly db: Db) {}

  record(entry: AssistantQueryRecord): number {
    const result = this.db
      .prepare(
        `INSERT INTO assistant_queries (
           created_at, username, prompt, provider, model, outcome, query_json,
           note, error_text, input_tokens, output_tokens, duration_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Math.floor(Date.now() / 1000),
        entry.username,
        entry.prompt,
        entry.provider,
        entry.model,
        entry.outcome,
        entry.query === null ? null : JSON.stringify(entry.query),
        entry.note,
        entry.errorText,
        entry.inputTokens,
        entry.outputTokens,
        entry.durationMs,
      );
    return Number(result.lastInsertRowid);
  }

  /**
   * Tokens spent since `since` (epoch seconds), input and output together.
   * Rows the provider reported no usage for count as zero, which can only
   * under-count; a local server is the usual case and costs nothing anyway.
   */
  tokensSince(since: number): number {
    const row = this.db
      .prepare<[number], { total: number | null }>(
        `SELECT SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) AS total
         FROM assistant_queries WHERE created_at >= ?`,
      )
      .get(since);
    return row?.total ?? 0;
  }
}
