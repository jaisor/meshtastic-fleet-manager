import { connect, type MqttClient } from "mqtt";
import { Protobuf } from "@meshtastic/core";
import type { FastifyBaseLogger } from "fastify";
import type { DiscoveryRules, MqttConfig } from "../config.js";
import type { NodeRepository } from "../db/repositories/nodes.js";
import type { MqttStatus } from "../../shared/types.js";
import type { AdmissionGate, RecentPackets } from "./admission.js";
import { enumName, resolveTime, zeroAsNull } from "./ingest.js";
import { refusalReason } from "./discovery.js";
import { parseMqttJson, type MqttContent, type MqttPacket } from "./mqttJson.js";
import { logNode } from "./nodeId.js";

/**
 * Listens to an MQTT broker for JSON packets from the fleet's nodes, and
 * records them like the radio's ingest does.
 *
 * Strictly a listener: it subscribes and never publishes, so it cannot put
 * anything on the mesh, and it needs neither the radio nor the radio lock.
 * That makes it a source of state in degraded mode as well -- with the radio
 * unplugged, nodes the gateways hear keep checking in.
 *
 * What it does not record, on purpose: `rssi`, `snr` and `hops_away`. They
 * describe the *gateway's* reception, and the fleet's link figures mean
 * "how well the local radio hears this node" (CLAUDE.md, section 11).
 * Writing a gateway's -32 dBm there would show a strong link to a node the
 * radio may not hear at all. For the same reason nothing here touches
 * `RadioStatus.lastAirPacketAt`.
 */

/** Fixed rather than a backoff: one TCP connect every 10s costs nothing. */
const RECONNECT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 30_000;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** The URL as it is safe to log and show: no username or password in it. */
function redact(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * What became of one message, for its log line. `admitted` is a node joining
 * the fleet on this message; `recorded` is an update to one already in it.
 */
type Outcome =
  | { outcome: "admitted" | "recorded" | "duplicate" }
  | { outcome: "not admitted"; reason: string };

/** The broker half of the discovery rules, for the startup log. */
function describeBrokerDiscovery(rules: DiscoveryRules): string {
  if (!rules.brokerDiscovery) return "off: only nodes already in the fleet are updated";
  if (rules.messageContains !== null) {
    return `on: a node joins by sending a text message containing "${rules.messageContains}"`;
  }
  if (rules.requireMessage) return "on: a node joins by sending a text message";
  return "on: any node reported on these topics joins";
}

/** A short, human summary of what a packet carried, for its log line. */
function summarize(content: MqttContent): string | undefined {
  switch (content.type) {
    case "nodeinfo": {
      const name = [content.longName, content.shortName && `(${content.shortName})`]
        .filter(Boolean)
        .join(" ");
      return name || "no names";
    }
    case "telemetry":
      return content.device
        ? "device metrics"
        : content.environment
          ? "environment metrics"
          : "other metrics";
    case "position":
      return content.latitudeI || content.longitudeI ? "with a fix" : "no fix";
    case "text":
      // The length, not the text: messages are the one thing here people
      // write to each other.
      return `${content.text.length} characters`;
    case "other":
      return undefined;
  }
}

export class MqttFeed {
  private client: MqttClient | null = null;
  private readonly displayUrl: string;
  /** Warned once per connection, rather than once per message. */
  private warnedNotJson = false;
  /** Connection attempts since the link was last up; reset on connect. */
  private attempts = 0;
  private readonly status: Omit<MqttStatus, "url" | "topics" | "discovery"> = {
    connected: false,
    lastConnectedAt: null,
    lastErrorText: null,
    lastMessageAt: null,
    received: 0,
    duplicates: 0,
    ignored: 0,
    lastIgnoredReason: null,
  };

  constructor(
    private readonly options: {
      config: MqttConfig;
      /** For explaining refusals and the status; the gate enforces them. */
      rules: DiscoveryRules;
      nodes: NodeRepository;
      admitted: AdmissionGate;
      recent: RecentPackets;
      logger: FastifyBaseLogger;
    },
  ) {
    this.displayUrl = redact(options.config.url);
  }

  getStatus(): MqttStatus {
    return {
      ...this.status,
      url: this.displayUrl,
      topics: this.options.config.topics,
      discovery: this.options.rules.brokerDiscovery,
    };
  }

  /**
   * Fire-and-forget, like the serial listener: startup never waits on the
   * broker, and a broker that is down, unknown or refusing us is retried
   * forever and reported in the status, never fatal.
   */
  start(): void {
    if (this.client) return;
    const { config, logger } = this.options;

    const client = connect(config.url, {
      clientId: config.clientId,
      username: config.username ?? undefined,
      password: config.password ?? undefined,
      rejectUnauthorized: config.rejectUnauthorized,
      reconnectPeriod: RECONNECT_MS,
      connectTimeout: CONNECT_TIMEOUT_MS,
      // Nothing to resume: a missed packet is a missed check-in, and the
      // node sends another.
      clean: true,
      // The `connect` handler below subscribes on every connection itself.
      // Left on, the library re-subscribes first and then answers ours as
      // already done -- with an empty grant and no error, so a denied topic
      // read as subscribed after the first reconnect.
      resubscribe: false,
    });
    this.client = client;

    logger.info(
      {
        url: this.displayUrl,
        clientId: config.clientId,
        // Who we sign in as, which is half of diagnosing a refusal. The
        // URL's user when it carries one; never the password.
        username: config.username ?? (decodeURIComponent(new URL(config.url).username) || null),
        topics: config.topics,
        discovery: describeBrokerDiscovery(this.options.rules),
        logMessages: config.logMessages,
      },
      "connecting to MQTT broker",
    );

    client.on("connect", (connack) => {
      this.status.connected = true;
      this.status.lastConnectedAt = nowSeconds();
      this.status.lastErrorText = null;
      this.warnedNotJson = false;
      logger.info(
        { url: this.displayUrl, clientId: config.clientId, attempts: this.attempts + 1, sessionPresent: connack.sessionPresent },
        "MQTT broker connected",
      );
      this.attempts = 0;

      // One SUBSCRIBE per topic. A broker refuses a topic inside an
      // otherwise successful SUBACK, with code 128 -- usually an ACL -- and
      // unchecked that looks exactly like a quiet mesh. mqtt.js 5 reports
      // it as `err` without saying which topic, so one topic per request is
      // what lets the message name the right one.
      for (const topic of config.topics) {
        client.subscribe(topic, { qos: 0 }, (err, granted) => {
          if (err || granted?.some((g) => g.qos === 128)) {
            this.status.lastErrorText = `The broker refused the subscription to ${topic}${
              err ? `: ${err.message}` : ""
            }`;
            logger.warn({ url: this.displayUrl, topic }, this.status.lastErrorText);
            return;
          }
          logger.info(
            { topic, qos: granted?.[0]?.qos },
            "subscribed to MQTT topic; waiting for messages",
          );
        });
      }
    });

    client.on("close", () => {
      if (this.status.connected) {
        logger.warn(
          { url: this.displayUrl, retryInSeconds: RECONNECT_MS / 1000 },
          "MQTT broker connection lost; reconnecting",
        );
      } else {
        // A failed attempt, not a lost link: the error, if any, was already
        // logged once, so this stays out of the way.
        logger.debug(
          { url: this.displayUrl, attempts: this.attempts + 1, err: this.status.lastErrorText },
          "MQTT connection attempt failed",
        );
      }
      this.status.connected = false;
    });

    // Info on the first retry of a spell and every tenth after it, so a
    // broker that is down for an hour is visible in the log without filling
    // it: one attempt every 10s is 360 lines an hour.
    client.on("reconnect", () => {
      this.attempts++;
      const level = this.attempts === 1 || this.attempts % 10 === 0 ? "info" : "debug";
      logger[level](
        { url: this.displayUrl, attempt: this.attempts, lastError: this.status.lastErrorText },
        "reconnecting to MQTT broker",
      );
    });

    // Must stay attached: an `error` with no listener is an uncaught
    // exception. Logged only when it changes, since a broker refusing our
    // credentials says so again on every reconnect.
    client.on("error", (err) => {
      const text = err.message || String(err);
      if (text !== this.status.lastErrorText) {
        logger.warn({ url: this.displayUrl, err: text }, "MQTT broker error");
      }
      this.status.lastErrorText = text;
    });

    client.on("message", (topic, payload) => this.handle(topic, payload));
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.status.connected = false;
    if (!client) return;
    await client.endAsync(true);
    this.options.logger.info(
      { url: this.displayUrl, received: this.status.received },
      "MQTT feed stopped",
    );
  }

  /**
   * One message off the broker, and one log line saying what became of it.
   * Public so it can be driven without a broker.
   */
  handle(topic: string, payload: Buffer): void {
    const { logger } = this.options;
    this.status.received++;
    this.status.lastMessageAt = nowSeconds();

    const parsed = parseMqttJson(payload.toString("utf8"));
    if (!parsed.ok) {
      this.status.ignored++;
      this.status.lastIgnoredReason = `${parsed.reason}, on ${topic}`;
      // The likely cause of a wall of these is subscribing to the protobuf
      // topics (`.../2/e/...`), which is worth one plain sentence on top of
      // the per-message line.
      if (parsed.reason === "not JSON" && !this.warnedNotJson) {
        this.warnedNotJson = true;
        logger.warn(
          { topic },
          "MQTT payload is not JSON and was ignored; only the JSON format is supported. " +
            "Subscribe to the .../2/json/... topics, not .../2/e/..., and enable JSON output on the gateways",
        );
      }
      this.logMessage({ topic, bytes: payload.length, outcome: "ignored", reason: parsed.reason });
      return;
    }

    const { packet } = parsed;
    const { content } = packet;
    this.logMessage({
      topic,
      bytes: payload.length,
      ...logNode(packet.from),
      type: content.type === "other" ? content.name : content.type,
      detail: summarize(content),
      gateway: packet.gateway,
      packetId: packet.id,
      ...this.record(packet),
    });
  }

  /**
   * Info by default, because watching messages arrive is how an operator
   * finds out whether the feed and its discovery rules do what they meant.
   * `mqtt.log_messages: false` moves it to debug for a busy broker.
   */
  private logMessage(fields: Record<string, unknown>): void {
    const level = this.options.config.logMessages ? "info" : "debug";
    this.options.logger[level](fields, "MQTT message received");
  }

  private record(packet: MqttPacket): Outcome {
    const { nodes, admitted, recent, rules } = this.options;
    const { from, content } = packet;

    // Every gateway that heard the packet publishes its own copy.
    if (recent.has(from, packet.id)) {
      this.status.duplicates++;
      return { outcome: "duplicate" };
    }

    const evidence = {
      viaBroker: true,
      message: content.type === "text" ? content.text : undefined,
    };
    const known = nodes.exists(from);
    if (!admitted(from, evidence)) {
      return {
        outcome: "not admitted",
        reason: refusalReason(rules, evidence) ?? "does not meet the discovery criteria",
      };
    }
    // Only once admitted, so a copy turned away cannot stop the radio's own
    // copy of the same packet being recorded.
    recent.add(from, packet.id);

    this.write(packet);
    return { outcome: known ? "recorded" : "admitted" };
  }

  private write(packet: MqttPacket): void {
    const { nodes } = this.options;
    const { from, content } = packet;

    // Proof of life whatever the packet says, and the row the history
    // inserts below need for their foreign key.
    const heardAt = resolveTime(packet.timestamp);
    nodes.upsert({ nodeNum: from, lastHeardAt: heardAt });

    switch (content.type) {
      case "nodeinfo":
        nodes.upsert({
          nodeNum: from,
          shortName: content.shortName,
          longName: content.longName,
          hwModel: enumName(Protobuf.Mesh.HardwareModel, content.hwModel),
          role: enumName(Protobuf.Config.Config_DeviceConfig_Role, content.role),
        });
        return;

      case "telemetry": {
        const { device, environment } = content;
        if (device) {
          nodes.upsert({
            nodeNum: from,
            batteryLevel: zeroAsNull(device.batteryLevel),
            voltage: zeroAsNull(device.voltage),
          });
          nodes.recordTelemetry(from, {
            recordedAt: heardAt,
            batteryLevel: zeroAsNull(device.batteryLevel),
            voltage: zeroAsNull(device.voltage),
            channelUtilization: zeroAsNull(device.channelUtilization),
            airUtilTx: zeroAsNull(device.airUtilTx),
            uptimeSeconds: zeroAsNull(device.uptimeSeconds),
            temperature: null,
            relativeHumidity: null,
            barometricPressure: null,
          });
        } else if (environment) {
          nodes.recordTelemetry(from, {
            recordedAt: heardAt,
            batteryLevel: null,
            voltage: zeroAsNull(environment.voltage),
            channelUtilization: null,
            airUtilTx: null,
            uptimeSeconds: null,
            temperature: zeroAsNull(environment.temperature),
            relativeHumidity: zeroAsNull(environment.relativeHumidity),
            barometricPressure: zeroAsNull(environment.barometricPressure),
          });
        }
        // Other variants are a check-in only, as on the radio path.
        return;
      }

      case "position": {
        // 0/0 is a node with no fix, not a place to plot.
        const latitude = content.latitudeI ? content.latitudeI / 1e7 : null;
        const longitude = content.longitudeI ? content.longitudeI / 1e7 : null;
        if (latitude === null && longitude === null) return;
        nodes.recordPosition(from, {
          recordedAt: content.time ? resolveTime(content.time) : heardAt,
          latitude,
          longitude,
          altitude: zeroAsNull(content.altitude),
        });
        return;
      }

      case "text":
      case "other":
        return;
    }
  }
}
