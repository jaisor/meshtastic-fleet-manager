/**
 * Meshtastic's MQTT JSON payloads, parsed into what the ingest records.
 *
 * Firmware publishes these on `<root>/2/json/<channel>/<gateway>` when a
 * gateway has `mqtt.json_enabled`, one per packet it heard and could
 * decode. The shape (`MeshPacketSerializer.cpp`):
 *
 *   {"channel":0,"from":1759534147,"hop_start":0,"hops_away":0,
 *    "id":3161783767,"payload":{...},"rssi":-32,"sender":"!1bbec6f0",
 *    "snr":6,"timestamp":1791841556,"to":690275437,"type":"nodeinfo"}
 *
 * `from` is the originating node as a decimal node number, and that is the
 * node a packet is about. `sender` is the **gateway** that uplinked it, and
 * `rssi`, `snr` and `hops_away` describe the gateway's reception, not ours.
 *
 * Pure: no I/O, no logger, so the shapes can be exercised without a broker.
 * Anything malformed comes back as a reason rather than a throw, because a
 * broker carries whatever anyone publishes to it.
 */

export interface DeviceMetrics {
  batteryLevel: number | null;
  voltage: number | null;
  channelUtilization: number | null;
  airUtilTx: number | null;
  uptimeSeconds: number | null;
}

export interface EnvironmentMetrics {
  voltage: number | null;
  temperature: number | null;
  relativeHumidity: number | null;
  barometricPressure: number | null;
}

export type MqttContent =
  | {
      type: "nodeinfo";
      shortName: string | null;
      longName: string | null;
      /** `HardwareModel` number; null for UNSET (0) or absent. */
      hwModel: number | null;
      /** `Config.DeviceConfig.Role` number; null when the record carries no identity. */
      role: number | null;
    }
  | { type: "text"; text: string }
  | { type: "telemetry"; device: DeviceMetrics | null; environment: EnvironmentMetrics | null }
  | {
      type: "position";
      latitudeI: number | null;
      longitudeI: number | null;
      altitude: number | null;
      time: number | null;
    }
  /** Any other type: proof the node is alive, and nothing more. */
  | { type: "other"; name: string };

export interface MqttPacket {
  from: number;
  /** Packet id, for recognizing the same packet from another gateway. 0 when absent. */
  id: number;
  /** The gateway's receive time, epoch seconds; may be 0 or wrong. */
  timestamp: number | null;
  /** The gateway that uplinked it, `!hex`, for logs only. */
  gateway: string | null;
  content: MqttContent;
}

export type MqttParseResult =
  | { ok: true; packet: MqttPacket }
  | { ok: false; reason: string };

/**
 * Messages *to* the mesh, published by clients for a gateway to transmit.
 * They share the topic tree and the envelope, but `from` there is the
 * gateway being asked to send, so recording one would credit a check-in to
 * a node that did nothing.
 */
const DOWNLINK_TYPES = new Set(["sendtext", "sendposition"]);

const BROADCAST = 0xffffffff;

type Fields = Record<string, unknown>;

function isObject(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(fields: Fields, key: string): number | null {
  const value = fields[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Firmware's JSON writes an unset string as "", which is not a name. */
function str(fields: Fields, key: string): string | null {
  const value = fields[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function has(fields: Fields, keys: string[]): boolean {
  return keys.some((key) => num(fields, key) !== null);
}

/**
 * Telemetry carries no variant name in JSON, only the variant's fields, so
 * the variant is recognized by the fields only it has. `voltage` appears in
 * both and decides nothing.
 */
function parseTelemetry(payload: Fields): MqttContent {
  const device = has(payload, [
    "battery_level",
    "channel_utilization",
    "air_util_tx",
    "uptime_seconds",
  ])
    ? {
        batteryLevel: num(payload, "battery_level"),
        voltage: num(payload, "voltage"),
        channelUtilization: num(payload, "channel_utilization"),
        airUtilTx: num(payload, "air_util_tx"),
        uptimeSeconds: num(payload, "uptime_seconds"),
      }
    : null;
  const environment =
    !device && has(payload, ["temperature", "relative_humidity", "barometric_pressure"])
      ? {
          voltage: num(payload, "voltage"),
          temperature: num(payload, "temperature"),
          relativeHumidity: num(payload, "relative_humidity"),
          barometricPressure: num(payload, "barometric_pressure"),
        }
      : null;
  return { type: "telemetry", device, environment };
}

function parseNodeInfo(payload: Fields): MqttContent {
  const shortName = str(payload, "shortname");
  const longName = str(payload, "longname");
  const hardware = num(payload, "hardware");
  const hwModel = hardware === 0 ? null : hardware;
  // Role 0 is CLIENT, a real role -- but it is also what an empty record
  // reads as. A record with no names and no hardware says nothing about
  // the node, so its role is not believed either.
  const identified = shortName !== null || longName !== null || hwModel !== null;
  return {
    type: "nodeinfo",
    shortName,
    longName,
    hwModel,
    role: identified ? num(payload, "role") : null,
  };
}

export function parseMqttJson(text: string): MqttParseResult {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not JSON" };
  }
  if (!isObject(body)) return { ok: false, reason: "not a JSON object" };

  const type = typeof body.type === "string" ? body.type : "";
  if (DOWNLINK_TYPES.has(type)) {
    return { ok: false, reason: `downlink command "${type}"` };
  }

  const from = num(body, "from");
  if (from === null || !Number.isInteger(from) || from <= 0 || from >= BROADCAST) {
    return { ok: false, reason: "no valid \"from\" node number" };
  }

  const payload = isObject(body.payload) ? body.payload : {};
  let content: MqttContent;
  switch (type) {
    case "nodeinfo":
      content = parseNodeInfo(payload);
      break;
    case "text": {
      // Older firmware put the text straight in `payload` as a string.
      const message =
        typeof body.payload === "string" ? body.payload : (str(payload, "text") ?? "");
      content = { type: "text", text: message };
      break;
    }
    case "telemetry":
      content = parseTelemetry(payload);
      break;
    case "position":
      content = {
        type: "position",
        latitudeI: num(payload, "latitude_i"),
        longitudeI: num(payload, "longitude_i"),
        altitude: num(payload, "altitude"),
        time: num(payload, "time"),
      };
      break;
    default:
      content = { type: "other", name: type || "(none)" };
  }

  const id = num(body, "id");
  return {
    ok: true,
    packet: {
      from,
      id: id !== null && Number.isInteger(id) && id >= 0 ? id : 0,
      timestamp: num(body, "timestamp"),
      gateway: typeof body.sender === "string" ? body.sender : null,
      content,
    },
  };
}
