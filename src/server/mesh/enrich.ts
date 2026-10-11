import { Protobuf } from "@meshtastic/core";
import type { FastifyBaseLogger } from "fastify";
import type { NodeRepository } from "../db/repositories/nodes.js";
import { buildToRadio, newPacketId } from "./admin.js";
import type { MeshListener } from "./listener.js";
import { logNode } from "./nodeId.js";
import { TaskCancelledError, type RadioTaskRegistry } from "./tasks.js";

/**
 * Asks a newly discovered node to introduce itself.
 *
 * Discovery can admit a node on evidence that carries nothing but its
 * number — a text message says who sent it and no more. The names, hardware
 * model, role and battery would otherwise arrive whenever the node next
 * broadcasts a NodeInfo, which is a matter of hours. A new row that reads
 * `!7c5b2a10 — — —` for the rest of the afternoon is not much of a
 * discovery, so we ask.
 *
 * The requests follow the pattern the library already uses for
 * `requestPosition`: an empty payload on the relevant port with
 * `wantResponse`, which firmware answers with its own record. Nothing here
 * correlates the reply — it arrives as an ordinary NodeInfo or Telemetry
 * packet and the normal ingest path records it. That is why this module has
 * no response handling at all.
 */

/**
 * Gap between transmissions. Each one costs airtime on a duty-cycled band
 * shared with everything else on the mesh, and nothing here is urgent.
 */
const SEND_SPACING_MS = 5_000;

/**
 * Discovering a burst of nodes at once -- the usual case when the radio
 * reconnects and replays its node database -- must not turn into an
 * unbounded backlog of transmissions. Past this, later arrivals are
 * dropped; they will be filled in by their own next broadcast.
 */
const MAX_PENDING = 50;

/**
 * How long to wait before re-checking whether the radio has come free.
 *
 * The automatic pass **defers** to anything else using the radio rather than
 * taking the lock itself. Two reasons for the asymmetry: LoRa is half-duplex,
 * so transmitting while an admin exchange is waiting for its reply can make us
 * miss that reply -- and nothing of ours is at risk in the other direction,
 * since these are one-shot requests with no correlated response to lose. And
 * holding the lock would be worse than useless here: a discovery burst can
 * queue fifty nodes, so locking the radio for each in turn would leave the
 * console refusing an operator's clicks for several minutes.
 */
const BUSY_RETRY_MS = 3_000;

/** Gap between the sends of a manual refresh, where someone is waiting. */
const MANUAL_SPACING_MS = 1_200;

/** How long a manual refresh waits for answers before reporting what it got. */
const MANUAL_WAIT_MS = 20_000;

/**
 * Longest a request may sit in the library's send queue before we stop
 * watching for it to be written. The queue writes one packet per 200 ms, so
 * this is only reached when the link itself has stopped taking writes.
 */
const WRITE_WAIT_MS = 5_000;

/** What a manual refresh managed to collect. */
export interface RefreshOutcome {
  identity: boolean;
  metrics: boolean;
  position: boolean;
}

export interface NodeEnricherOptions {
  listener: MeshListener;
  nodes: NodeRepository;
  logger: FastifyBaseLogger;
  enabled: boolean;
  /**
   * The radio lock, consulted but never taken -- see `BUSY_RETRY_MS`. The
   * manual `refresh` path does not check it, because its caller already holds
   * it and would be waiting on itself.
   */
  tasks: RadioTaskRegistry;
}

export class NodeEnricher {
  private readonly pending: number[] = [];
  private readonly queued = new Set<number>();
  private draining = false;
  private stopped = false;

  constructor(private readonly options: NodeEnricherOptions) {}

  /** Called by the ingest the first time a node is admitted to the fleet. */
  enqueue(nodeNum: number): void {
    if (!this.options.enabled || this.stopped) return;
    if (this.queued.has(nodeNum)) return;

    if (this.pending.length >= MAX_PENDING) {
      this.options.logger.debug(
        logNode(nodeNum),
        "enrichment backlog full; skipping",
      );
      return;
    }

    this.queued.add(nodeNum);
    this.pending.push(nodeNum);

    // Deferred, not started inline. The ingest admits a node *before* it
    // writes the row, so draining synchronously would look the node up,
    // find nothing, and drop it. Yielding a tick lets the discovering
    // packet finish being recorded first.
    setTimeout(() => void this.drain(), 0);
  }

  stop(): void {
    this.stopped = true;
    this.pending.length = 0;
    this.queued.clear();
  }

  private async drain(): Promise<void> {
    if (this.draining || this.stopped) return;
    this.draining = true;

    try {
      while (this.pending.length > 0 && !this.stopped) {
        // Somebody else has the radio. Hold the queue rather than dropping
        // nodes from it: they are newly discovered and nothing else will fill
        // their details in until their own next broadcast.
        if (this.options.tasks.isBusy()) {
          await delay(BUSY_RETRY_MS);
          continue;
        }

        const nodeNum = this.pending.shift() as number;
        this.queued.delete(nodeNum);
        await this.enrich(nodeNum);
      }
    } finally {
      this.draining = false;
    }
  }

  private async enrich(nodeNum: number): Promise<void> {
    const device = this.options.listener.getIdentifiedDevice();
    if (!device) return;

    // Re-read rather than trusting what was true at discovery: by the time
    // a node's turn comes round the details may have arrived on their own,
    // and asking again would spend airtime to learn nothing.
    const node = this.options.nodes.get(nodeNum);
    if (!node || node.isLocal) return;

    const wantIdentity = node.shortName === null && node.longName === null;
    const wantMetrics = node.batteryLevel === null;
    if (!wantIdentity && !wantMetrics) return;

    this.options.logger.info(
      { ...logNode(node.nodeNum), wantIdentity, wantMetrics },
      "asking newly discovered node to introduce itself",
    );

    if (wantIdentity) {
      await this.request(nodeNum, Protobuf.Portnums.PortNum.NODEINFO_APP);
      if (wantMetrics) await delay(SEND_SPACING_MS);
    }
    if (wantMetrics) {
      await this.request(nodeNum, Protobuf.Portnums.PortNum.TELEMETRY_APP);
    }

    await delay(SEND_SPACING_MS);
  }

  /**
   * Forced refresh of everything a node will tell us: identity, metrics and
   * sensor readings, and position.
   *
   * Unlike the automatic pass this asks regardless of what is already
   * stored — the point of pressing refresh is to find out what is true
   * *now*, not to fill blanks. It also waits for the answers rather than
   * firing and forgetting, so the button can report what actually came
   * back; the replies land through the normal ingest path, and this only
   * watches for them so it knows when to stop waiting.
   *
   * Resolves as soon as everything asked for has arrived, so a responsive
   * node does not hold the caller for the full window.
   */
  async refresh(nodeNum: number, signal?: AbortSignal): Promise<RefreshOutcome> {
    const outcome: RefreshOutcome = {
      identity: false,
      metrics: false,
      position: false,
    };

    const listener = this.options.listener;
    let settle: (() => void) | null = null;

    const seen = (kind: keyof RefreshOutcome) => {
      outcome[kind] = true;
      if (outcome.identity && outcome.metrics && outcome.position) settle?.();
    };

    // `nodeInfo` also fires for the radio's own database entries, so match
    // on the node number rather than assuming the next one is ours.
    const onNodeInfo = (info: { num: number }) =>
      info.num === nodeNum && seen("identity");
    const onUser = (p: { from: number }) => p.from === nodeNum && seen("identity");
    const onTelemetry = (p: { from: number }) =>
      p.from === nodeNum && seen("metrics");
    const onPosition = (p: { from: number }) =>
      p.from === nodeNum && seen("position");

    listener.on("nodeInfo", onNodeInfo);
    listener.on("user", onUser);
    listener.on("telemetry", onTelemetry);
    listener.on("position", onPosition);

    try {
      await this.request(nodeNum, Protobuf.Portnums.PortNum.NODEINFO_APP, signal);
      await delay(MANUAL_SPACING_MS, signal);
      await this.request(nodeNum, Protobuf.Portnums.PortNum.TELEMETRY_APP, signal);
      await delay(MANUAL_SPACING_MS, signal);
      await this.request(nodeNum, Protobuf.Portnums.PortNum.POSITION_APP, signal);

      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new TaskCancelledError());
          return;
        }
        const timer = setTimeout(resolve, MANUAL_WAIT_MS);
        settle = () => {
          clearTimeout(timer);
          resolve();
        };
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new TaskCancelledError());
          },
          { once: true },
        );
      });

      this.options.logger.info(
        { ...logNode(nodeNum), ...outcome },
        "manual refresh finished",
      );
      return outcome;
    } finally {
      listener.off("nodeInfo", onNodeInfo);
      listener.off("user", onUser);
      listener.off("telemetry", onTelemetry);
      listener.off("position", onPosition);
    }
  }

  /**
   * An empty payload with `wantResponse` — the same shape the library's own
   * `requestPosition` uses. `wantAck` is off: an acknowledgement would cost
   * another transmission to tell us something we do not act on, since a
   * node that never answers is simply left as it was.
   *
   * **Not sent with `sendPacket`.** That resolves only when the library's
   * queue sees a routing ACK for the packet, and with `wantAck` off none ever
   * comes: the node answers with data, not an ACK. Each request then sat out
   * the queue's 60s timeout, so a manual refresh held the radio lock for
   * about three and a half minutes against a 25s budget, even after the node
   * had answered. Instead the id is chosen here, the send is not awaited,
   * and the queue entry is released once written -- as `AdminClient` and the
   * watchdog already do, for the same reason.
   */
  private async request(
    nodeNum: number,
    portNum: Protobuf.Portnums.PortNum,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) throw new TaskCancelledError();
    const device = this.options.listener.getIdentifiedDevice();
    const local = this.options.listener.getStatus().localNodeNum;
    if (!device || local === null) return;

    const id = newPacketId();
    const bytes = buildToRadio({
      from: local,
      to: nodeNum,
      id,
      portnum: portNum,
      payload: new Uint8Array(),
      wantAck: false,
      wantResponse: true,
    });

    let written = false;
    device.sendRaw(bytes, id).catch((cause: unknown) => {
      // Releasing the entry below makes the queue's own wait throw, and its
      // 60s timeout rejects with a plain object; neither is news. A write
      // that never happened is, and is never fatal: the node keeps what it
      // had and its next broadcast fills the gaps.
      if (written || !(cause instanceof Error)) return;
      this.options.logger.warn(
        { ...logNode(nodeNum), port: Protobuf.Portnums.PortNum[portNum], err: cause.message },
        "enrichment request failed",
      );
    });

    // Wait only until it is on the wire, then drop it from the queue so the
    // library neither holds it for a minute nor logs a timeout for it.
    const deadline = Date.now() + WRITE_WAIT_MS;
    while (Date.now() < deadline) {
      const entry = device.queue.getState().find((item) => item.id === id);
      if (!entry || entry.sent) {
        written = true;
        device.queue.remove(id);
        return;
      }
      await delay(50, signal);
    }
    this.options.logger.warn(
      { ...logNode(nodeNum), port: Protobuf.Portnums.PortNum[portNum] },
      "enrichment request not written to the radio in time",
    );
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // An already-aborted signal never fires "abort" again, so without this a
    // cancel that landed mid-request was ignored until the next timeout ran out.
    if (signal?.aborted) {
      reject(new TaskCancelledError());
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new TaskCancelledError());
      },
      { once: true },
    );
  });
}