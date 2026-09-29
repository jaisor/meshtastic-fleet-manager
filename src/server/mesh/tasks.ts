import type { RadioTask, RadioTaskKind } from "../../shared/types.js";
import { toNodeId } from "./nodeId.js";

/**
 * Tracks the user-initiated operations currently occupying the radio.
 *
 * Every one of these is a round trip over LoRa that can take tens of
 * seconds, and the operator who started it may well have navigated
 * somewhere else since. The registry exists so the UI can say what the
 * radio is busy with from any page, and offer a way out of it.
 *
 * Background work -- the capability prober's sweeps -- is deliberately not
 * registered. It is not something a person is waiting on, and a banner
 * that appeared on its own schedule would train people to ignore banners.
 */

export interface StartTaskInput {
  kind: RadioTaskKind;
  label: string;
  nodeNum: number;
  nodeName: string | null;
  timeoutSeconds: number;
}

export interface StartedTask {
  task: RadioTask;
  /** Aborts when the task is cancelled; pass it into the mesh call. */
  signal: AbortSignal;
}

/** Thrown in place of a result when an operation is cancelled. */
export class TaskCancelledError extends Error {
  constructor(message = "task cancelled") {
    super(message);
    this.name = "TaskCancelledError";
  }
}

export class RadioTaskRegistry {
  private readonly entries = new Map<
    number,
    { task: RadioTask; controller: AbortController }
  >();
  private nextId = 1;

  start(input: StartTaskInput): StartedTask {
    const controller = new AbortController();
    const task: RadioTask = {
      id: this.nextId++,
      kind: input.kind,
      label: input.label,
      nodeNum: input.nodeNum,
      nodeId: toNodeId(input.nodeNum),
      nodeName: input.nodeName,
      startedAt: Math.floor(Date.now() / 1000),
      timeoutSeconds: input.timeoutSeconds,
    };
    this.entries.set(task.id, { task, controller });
    return { task, signal: controller.signal };
  }

  /** Always call this, cancelled or not, or the banner never goes away. */
  finish(id: number): void {
    this.entries.delete(id);
  }

  /**
   * Returns false if the task already finished, which is a race the UI can
   * lose honestly: the banner is polled, so the operation may have
   * completed between the poll and the click.
   */
  cancel(id: number): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    entry.controller.abort();
    return true;
  }

  list(): RadioTask[] {
    return [...this.entries.values()]
      .map((entry) => entry.task)
      .toSorted((a, b) => a.startedAt - b.startedAt || a.id - b.id);
  }

  /** Used when the radio goes away underneath everything still waiting. */
  cancelAll(): number {
    let cancelled = 0;
    for (const entry of this.entries.values()) {
      entry.controller.abort();
      cancelled += 1;
    }
    return cancelled;
  }
}
