import type { FastifyBaseLogger } from "fastify";
import type { NodeRepository } from "../db/repositories/nodes.js";
import type { AdminClient } from "./admin.js";
import type { MeshListener } from "./listener.js";
import { logNode } from "./nodeId.js";
import { TaskCancelledError, type RadioTaskRegistry } from "./tasks.js";

/**
 * Periodically re-establishes which nodes the local node may administer.
 *
 * Probes are deliberately slow and serialized. Each one is a real round
 * trip over LoRa, and the duty cycle is shared with everything else on the
 * mesh -- hammering it to fill in a UI badge faster would degrade the
 * network we are supposed to be monitoring.
 *
 * **The sweep takes the radio lock for each individual probe, and yields.**
 * Holding it for a whole sweep would lock an operator out for a minute at a
 * time; not taking it at all would let a background probe and a user's probe
 * transmit over each other, which is the collision this is all meant to
 * prevent. So: one probe, one lock, released between each. If anything else
 * wants the radio the sweep abandons the rest of its batch rather than racing
 * for the lock after every gap -- nobody is waiting on a sweep, and the nodes
 * it skipped are still due next time.
 */

/** Gap between individual probes within a sweep. */
const PROBE_SPACING_MS = 5_000;

/** Nodes probed per sweep, so one sweep cannot monopolize the radio. */
const PROBE_BATCH_SIZE = 5;

export interface CapabilityProberOptions {
  nodes: NodeRepository;
  admin: AdminClient;
  listener: MeshListener;
  /** The radio lock; a sweep takes it per probe and yields to anything else. */
  tasks: RadioTaskRegistry;
  logger: FastifyBaseLogger;
  /** Seconds before a verdict is considered worth rechecking. */
  interval: number;
}

export class CapabilityProber {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(private readonly options: CapabilityProberOptions) {}

  start(): void {
    this.stopped = false;
    // A sweep every quarter-interval keeps newly discovered nodes from
    // waiting a full interval for their first verdict.
    const period = Math.max(60, Math.floor(this.options.interval / 4)) * 1000;
    this.timer = setInterval(() => void this.sweep(), period);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async sweep(): Promise<void> {
    if (this.running || this.stopped) return;
    if (!this.options.listener.getDevice()) return;

    this.running = true;
    try {
      const due = this.options.nodes.needingAdminProbe(
        this.options.interval,
        PROBE_BATCH_SIZE,
      );

      for (const node of due) {
        if (this.stopped) break;
        // The radio can vanish mid-sweep; stop rather than log a run of
        // misleading "unreachable" verdicts caused by our own end.
        if (!this.options.listener.getDevice()) break;

        const started = this.options.tasks.start({
          kind: "probe",
          label: "Checking admin access",
          nodeNum: node.nodeNum,
          nodeName: node.longName ?? node.shortName ?? null,
          timeoutSeconds: this.options.interval,
          // Occupies the radio, but stays out of the task banner: a banner
          // appearing on its own schedule teaches people to ignore banners.
          background: true,
        });

        // Something else has the radio -- almost certainly a person waiting on
        // it. Give up the rest of the batch rather than contending for the lock
        // between every probe; these nodes are still due on the next sweep.
        if (!started) {
          this.options.logger.debug(
            "radio busy; deferring the rest of the capability sweep",
          );
          break;
        }

        try {
          const capability = await this.options.admin.probe(
            node.nodeNum,
            started.signal,
          );
          this.options.nodes.setAdminCapability(node.nodeNum, capability);
          this.options.logger.info(
            { ...logNode(node.nodeNum), capability },
            "admin capability probed",
          );
        } catch (cause) {
          // A cancelled background probe establishes nothing and is not worth
          // a warning -- `cancelAll` on a vanishing radio hits these too.
          if (!(cause instanceof TaskCancelledError)) throw cause;
        } finally {
          this.options.tasks.finish(started.task.id);
        }

        await delay(PROBE_SPACING_MS);
      }
    } catch (cause) {
      this.options.logger.warn(
        { err: (cause as Error).message },
        "capability sweep failed",
      );
    } finally {
      this.running = false;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
