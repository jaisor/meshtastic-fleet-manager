import type { DiscoveryRules } from "../config.js";

/**
 * Decides which nodes are allowed into the fleet.
 *
 * Two decisions shape everything here.
 *
 * **The rules gate admission, not updates.** Once a node is in the fleet it
 * is tracked normally, whatever arrives next. A node admitted by sending
 * "JOIN" on channel 2 would otherwise never record telemetry or a position,
 * since those are not messages and carry no matching text -- the filter
 * would admit nodes and then refuse to learn anything about them.
 *
 * **The radio's NodeDB dump is filtered too.** On connect the radio hands
 * over every node it has ever heard, and letting that through unchecked
 * would admit the whole mesh the first time the service starts, making a
 * restrictive policy pointless exactly when it matters.
 */

/** What a single packet tells us about the node that sent it. */
export interface DiscoveryEvidence {
  /**
   * Channel index, when it is actually known.
   *
   * Left undefined rather than defaulted to 0, because a zero in the
   * protobuf means "primary" and "no idea" alike, and the difference is the
   * whole policy. Only a packet the radio **decoded with one of our channel
   * keys** is evidence of that channel, since holding the key is the thing
   * being tested. Three sources look like evidence and are not:
   * a NodeInfo's `channel` ("only populated if it is not the default
   * channel"), an encrypted packet's (that field carries a channel *hash*
   * while the payload is encrypted), and a PKI-encrypted packet's (it used
   * no channel at all). `ingest.ts` passes undefined for each.
   */
  channel?: number;
  /** Text content, for a message packet only. */
  message?: string;
  /** The radio saw this over MQTT rather than hearing it on the air. */
  viaMqtt?: boolean;
}

export function describeRules(rules: DiscoveryRules): string {
  const parts: string[] = [];
  parts.push(
    rules.channel === null
      ? "any channel"
      : `channel ${rules.channel}${rules.channel === 0 ? " (primary)" : ""}`,
  );
  if (rules.messageContains !== null) {
    parts.push(`message containing "${rules.messageContains}"`);
  } else if (rules.requireMessage) {
    parts.push("a text message");
  }
  if (!rules.includeMqtt) parts.push("heard on the air, not via MQTT");
  return parts.join(", ");
}

/** True when the rules admit nothing by default -- i.e. they are narrowed. */
export function isRestricted(rules: DiscoveryRules): boolean {
  return rules.channel !== null || rules.requireMessage || !rules.includeMqtt;
}

/**
 * Whether this packet is enough to admit a node not already in the fleet.
 *
 * A missing channel on the evidence is treated as *not matching* when a
 * channel is required. Admitting on absent information would quietly widen
 * the policy, and the packets that carry no channel are exactly the ones a
 * narrow policy is meant to exclude.
 */
export function admits(
  rules: DiscoveryRules,
  evidence: DiscoveryEvidence,
): boolean {
  // A node witnessed over MQTT was never heard on the air, so it cannot
  // have transmitted on the local radio's channel -- whatever channel
  // index the record happens to carry.
  if (!rules.includeMqtt && evidence.viaMqtt === true) {
    return false;
  }

  if (rules.channel !== null && evidence.channel !== rules.channel) {
    return false;
  }

  if (rules.requireMessage && evidence.message === undefined) {
    return false;
  }

  if (rules.messageContains !== null) {
    const text = evidence.message?.toLowerCase();
    if (text === undefined || !text.includes(rules.messageContains)) {
      return false;
    }
  }

  return true;
}
