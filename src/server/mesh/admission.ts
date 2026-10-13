import type { FastifyBaseLogger } from "fastify";
import type { NodeRepository } from "../db/repositories/nodes.js";
import type { DiscoveryRules } from "../config.js";
import {
  describeRules,
  isRestricted,
  refusalReason,
  type DiscoveryEvidence,
} from "./discovery.js";
import { logNode } from "./nodeId.js";

/**
 * The admission gate both ingests share: the radio's (`ingest.ts`) and the
 * MQTT broker feed's (`mqttFeed.ts`). One gate rather than one each, so a
 * node admitted by either is a member for both, and `onAdmitted` fires once
 * per node whichever source heard it first.
 *
 * Every handler funnels through this before touching the database, so a
 * node outside the discovery criteria leaves no trace at all -- not even a
 * bare row with a last-heard time.
 *
 * Already-known nodes always pass: the criteria decide who joins the fleet,
 * not what we are allowed to learn about members.
 */
export type AdmissionGate = (nodeNum: number, evidence: DiscoveryEvidence) => boolean;

export function createAdmissionGate(options: {
  nodes: NodeRepository;
  rules: DiscoveryRules;
  logger: FastifyBaseLogger;
  /** The radio identified on the current connection, if any. */
  localNodeNum: () => number | null;
  onAdmitted?: (nodeNum: number) => void;
}): AdmissionGate {
  const { nodes, rules, logger, localNodeNum, onAdmitted } = options;

  if (isRestricted(rules)) {
    logger.info(
      { discovery: describeRules(rules) },
      "discovery is narrowed; nodes outside the criteria will be ignored",
    );
  }

  return (nodeNum, evidence) => {
    // Our own radio is not a discovery candidate; it is the instrument.
    if (nodeNum === localNodeNum()) return true;
    if (nodes.exists(nodeNum)) return true;

    const refused = refusalReason(rules, evidence);
    if (refused !== null) {
      logger.debug(
        { ...logNode(nodeNum), evidence, reason: refused },
        "packet ignored; node does not meet discovery criteria",
      );
      return false;
    }

    logger.info(
      { ...logNode(nodeNum), evidence, source: evidence.viaBroker ? "mqtt" : "radio" },
      "node admitted to the fleet by discovery criteria",
    );
    // Fires only on first admission, so enrichment is asked for once per
    // node rather than on every packet it ever sends.
    onAdmitted?.(nodeNum);
    return true;
  };
}

/**
 * Packets already recorded, by sender and packet id.
 *
 * The same packet reaches us more than once as soon as there is a broker:
 * every gateway that hears it uplinks its own copy, and the radio may have
 * heard it too. Upserts are idempotent, but telemetry and position history
 * are plain inserts, so without this one broadcast becomes a row per
 * gateway. Ten minutes is far longer than any copy takes to arrive and far
 * shorter than a node takes to wrap its 32-bit packet ids.
 */
export class RecentPackets {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = 10 * 60 * 1000,
    private readonly maxEntries = 20_000,
  ) {}

  /** Packet id 0 means unset, and would make every such packet one packet. */
  has(from: number, id: number): boolean {
    if (id === 0) return false;
    const expires = this.seen.get(`${from}:${id}`);
    return expires !== undefined && expires > Date.now();
  }

  add(from: number, id: number): void {
    if (id === 0) return;
    const key = `${from}:${id}`;
    // Re-inserting moves the key to the end, keeping the map in expiry order.
    this.seen.delete(key);
    this.seen.set(key, Date.now() + this.ttlMs);
    this.evict();
  }

  private evict(): void {
    const now = Date.now();
    for (const [key, expires] of this.seen) {
      if (expires > now && this.seen.size <= this.maxEntries) break;
      this.seen.delete(key);
    }
  }
}
