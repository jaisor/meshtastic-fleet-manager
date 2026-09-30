import type {
  RadioOccupancy,
  RadioTask,
  RadioTaskKind,
} from "../../shared/types.js";
import { toNodeId } from "./nodeId.js";

/**
 * Tracks the user-initiated operations currently occupying the radio.
 *
 * Every one of these is a round trip over LoRa that can take tens of
 * seconds, and the operator who started it may well have navigated
 * somewhere else since. The registry exists so the UI can say what the
 * radio is busy with from any page, and offer a way out of it.
 *
 * **The radio is exclusive: one operation at a time.** There is one LoRa
 * transceiver and a duty cycle shared with the whole mesh, so two admin
 * exchanges in flight together contend for airtime, stretch each other's
 * timeouts, and make a slow link look like a broken one. `start` refuses
 * rather than queueing: a queue would leave someone watching a button that
 * did nothing for a minute, and the honest answer -- "the radio is busy
 * doing X" -- is more useful than a silent wait.
 *
 * Background work -- the capability prober's sweeps -- still takes the lock,
 * because colliding with a sweep is just as bad as colliding with a person.
 * It is **not** listed by `list()`, so it never reaches the task banner: it
 * is not something anyone is waiting on, and a banner appearing on its own
 * schedule would train people to ignore banners. It does show up in
 * `occupancy()`, which is what the UI uses to explain a disabled button --
 * otherwise the buttons would look available and the server would refuse.
 */

export interface StartTaskInput {
  kind: RadioTaskKind;
  label: string;
  nodeNum: number;
  nodeName: string | null;
  timeoutSeconds: number;
  /**
   * Work nobody is waiting on. Takes the lock like anything else, but stays
   * out of `list()` and so out of the task banner.
   */
  background?: boolean;
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
    { task: RadioTask; controller: AbortController; background: boolean }
  >();
  private nextId = 1;

  /**
   * Takes the radio, or returns null because something else already has it.
   *
   * Callers must handle null -- for an HTTP route that means 409 naming the
   * occupant, never an exception, because "busy" is an ordinary outcome and
   * not a fault. The check and the insert happen together in one synchronous
   * block, which is what makes this a lock at all: Node runs one thing at a
   * time, so no two requests can both observe it free.
   */
  start(input: StartTaskInput): StartedTask | null {
    if (this.entries.size > 0) return null;

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
    this.entries.set(task.id, {
      task,
      controller,
      background: input.background === true,
    });
    return { task, signal: controller.signal };
  }

  /** True while anything holds the radio, background work included. */
  isBusy(): boolean {
    return this.entries.size > 0;
  }

  /**
   * What the radio is doing, for explaining a disabled control.
   *
   * Reports background work too, unlike `list()`. A button that looks
   * available while the server would refuse it is the exact failure this
   * exists to prevent.
   */
  occupancy(): RadioOccupancy | null {
    const entry = [...this.entries.values()][0];
    if (!entry) return null;
    return {
      label: entry.task.label,
      nodeId: entry.task.nodeId,
      nodeName: entry.task.nodeName,
      background: entry.background,
      startedAt: entry.task.startedAt,
    };
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

  /** User-initiated work only; background work is deliberately excluded. */
  list(): RadioTask[] {
    return [...this.entries.values()]
      .filter((entry) => !entry.background)
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
