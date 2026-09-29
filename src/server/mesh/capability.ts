import type { FastifyBaseLogger } from "fastify";
import type { NodeRepository } from "../db/repositories/nodes.js";
import type { AdminClient } from "./admin.js";
import type { MeshListener } from "./listener.js";
import { logNode } from "./nodeId.js";

/**
 * Periodically re-establishes which nodes the local node may administer.
 *
 * Probes are deliberately slow and serialized. Each one is a real round
 * trip over LoRa, and the duty cycle is shared with everything else on the
 * mesh -- hammering it to fill in a UI badge faster would degrade the
 * network we are supposed to be monitoring.
 */

/** Gap between individual probes within a sweep. */
const PROBE_SPACING_MS = 5_000;

/** Nodes probed per sweep, so one sweep cannot monopolize the radio. */
const PROBE_BATCH_SIZE = 5;

export interface CapabilityProberOptions {
  nodes: NodeRepository;
  admin: AdminClient;
  listener: MeshListener;
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

        const capability = await this.options.admin.probe(node.nodeNum);
        this.options.nodes.setAdminCapability(node.nodeNum, capability);
        this.options.logger.info(
          { ...logNode(node.nodeNum), capability },
          "admin capability probed",
        );

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
