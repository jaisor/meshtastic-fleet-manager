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
  /**
   * Arrived on our own subscription to the MQTT broker (`mqtt` in config),
   * not through the radio at all. Distinct from `viaMqtt`, which is the
   * radio's record of something *it* learned over MQTT: this one is a
   * feed the operator configured, scoped by the topic they chose.
   */
  viaBroker?: boolean;
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
  const radio = parts.join(", ");
  // The broker feed widens rather than narrows, and the channel rule does
  // not reach it (see `refusalReason`), so it reads as its own clause.
  if (!rules.brokerDiscovery) return radio;
  const message =
    rules.messageContains !== null
      ? ` with a message containing "${rules.messageContains}"`
      : rules.requireMessage
        ? " sending a text message"
        : "";
  return `${radio}; or reported on the MQTT feed${message}`;
}

/** True when the rules admit nothing by default -- i.e. they are narrowed. */
export function isRestricted(rules: DiscoveryRules): boolean {
  return rules.channel !== null || rules.requireMessage || !rules.includeMqtt;
}

/**
 * Whether this packet is enough to admit a node not already in the fleet:
 * null when it is, otherwise why not, in words for a log line. The decision
 * and its explanation are one function so the log cannot drift from it.
 *
 * A missing channel on the evidence is treated as *not matching* when a
 * channel is required. Admitting on absent information would quietly widen
 * the policy, and the packets that carry no channel are exactly the ones a
 * narrow policy is meant to exclude.
 */
export function refusalReason(
  rules: DiscoveryRules,
  evidence: DiscoveryEvidence,
): string | null {
  if (evidence.viaBroker === true) {
    // The broker feed is scoped by the topic the operator subscribed to,
    // which already names the channel. The radio's channel rule cannot
    // apply: a JSON packet's `channel` is an index into the *gateway's*
    // channel table, not the local radio's, so comparing them would be the
    // category error `channelEvidence` exists to prevent. `include_mqtt`
    // does not apply either -- it concerns the radio's MQTT records.
    if (!rules.brokerDiscovery) {
      return "mqtt.discovery is off, so the broker only updates nodes already in the fleet";
    }
  } else {
    // A node witnessed over MQTT was never heard on the air, so it cannot
    // have transmitted on the local radio's channel -- whatever channel
    // index the record happens to carry.
    if (!rules.includeMqtt && evidence.viaMqtt === true) {
      return "the radio only witnessed it over MQTT (discovery.include_mqtt is off)";
    }

    if (rules.channel !== null && evidence.channel !== rules.channel) {
      return evidence.channel === undefined
        ? `discovery requires channel ${rules.channel} and this packet proves no channel`
        : `heard on channel ${evidence.channel}, discovery requires channel ${rules.channel}`;
    }
  }

  if (rules.requireMessage && evidence.message === undefined) {
    return rules.messageContains !== null
      ? `not a text message; discovery requires one containing "${rules.messageContains}"`
      : "not a text message; discovery requires one";
  }

  if (rules.messageContains !== null) {
    const text = evidence.message?.toLowerCase();
    if (text === undefined || !text.includes(rules.messageContains)) {
      return `the message does not contain "${rules.messageContains}"`;
    }
  }

  return null;
}
