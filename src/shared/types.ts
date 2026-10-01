/**
 * The HTTP contract between the server and the web UI. Imported by both
 * sides so a change to a response shape breaks the build rather than the
 * browser. Nothing here may import from `server/` or `web/`.
 */

import type { UserRole } from "./roles.js";

/** Who is signed in, as every authenticated response reports it. */
export interface SessionUser {
  username: string;
  role: UserRole;
  /** True for the config-defined `admin`, which has no database row. */
  builtIn: boolean;
}

export interface SessionResponse {
  authenticated: boolean;
  user: SessionUser | null;
}

/** A database-backed account, as the admin page lists it. */
export interface ManagedUser {
  id: number;
  username: string;
  role: UserRole;
  createdAt: number;
  lastLoginAt: number | null;
}

/** Row counts returned after a destructive maintenance action. */
export interface MaintenanceResult {
  nodes: number;
  telemetry: number;
  positions: number;
  operations: number;
}

/**
 * Whether the local node is allowed to administer a given remote node.
 *
 * This is the result of a probe, not an inspection: authorization lives in
 * the remote's `SecurityConfig.adminKey`, which cannot be read without
 * already holding admin rights. So `unknown` genuinely means "not yet
 * established" and must never be rendered as a denial.
 */
export type AdminCapability =
  | "capable"
  | "unauthorized"
  | "unreachable"
  | "unknown";

/** Derived from `lastHeardAt` against the configured `stale_after`. */
export type NodeState = "online" | "stale" | "offline";

/**
 * Link quality, derived from the last SNR and RSSI measured on a packet
 * that arrived **directly** from the node.
 *
 * `unknown` means no direct measurement, which is the normal state for a
 * node only ever heard through a relay — not a sign of a bad link. Both
 * figures describe the last hop, so recording them from a relayed packet
 * would describe the relay's link rather than this node's.
 */
export type SignalQuality = "good" | "medium" | "bad" | "unknown";

export interface FleetNode {
  /** Meshtastic node number. Primary key everywhere on the server. */
  nodeNum: number;
  /** Display form of `nodeNum`, e.g. `!a4c138f0`. */
  nodeId: string;
  shortName: string | null;
  longName: string | null;
  hwModel: string | null;
  role: string | null;
  firmwareVersion: string | null;
  /** UTC epoch seconds. Null until we have heard the node at least once. */
  lastHeardAt: number | null;
  firstSeenAt: number;
  state: NodeState;
  isLocal: boolean;
  /** Last SNR in dB measured on a direct packet from this node. */
  snr: number | null;
  /** Last RSSI in dBm measured on a direct packet from this node. */
  rssi: number | null;
  /** Derived from snr + rssi; see SignalQuality. */
  signal: SignalQuality;
  /** Relay count between the local radio and this node. 0 means direct. */
  hopsAway: number | null;
  batteryLevel: number | null;
  voltage: number | null;
  adminCapability: AdminCapability;
  adminCheckedAt: number | null;
}

export interface TelemetryPoint {
  recordedAt: number;
  batteryLevel: number | null;
  voltage: number | null;
  channelUtilization: number | null;
  airUtilTx: number | null;
  uptimeSeconds: number | null;
  temperature: number | null;
  relativeHumidity: number | null;
  barometricPressure: number | null;
}

export interface PositionPoint {
  recordedAt: number;
  latitude: number | null;
  longitude: number | null;
  altitude: number | null;
}

/**
 * A node's radio and module settings.
 *
 * Unlike everything else about a node, none of this arrives on its own:
 * nothing on the mesh broadcasts a LoRa preset or a telemetry interval. The
 * local radio's values come from its config dump over USB; a remote node's
 * come from admin reads, so they exist only for nodes the local node may
 * administer and only once someone has asked.
 *
 * Every field is nullable and null means **not read**, never "off" or
 * "zero" -- rendering an unread interval as 0 would invent a setting. That
 * is why `fetchedAt` belongs to the whole snapshot rather than each field.
 */
export interface NodeRadioConfig {
  /** When this snapshot was taken. */
  fetchedAt: number;

  region: string | null;
  /**
   * Named preset, e.g. `LONG_FAST`. Meaningless when `usesPreset` is false:
   * the node is then running the explicit bandwidth/spread/coding values
   * below and the preset field is left at whatever it last held.
   */
  modemPreset: string | null;
  usesPreset: boolean | null;
  bandwidth: number | null;
  spreadFactor: number | null;
  codingRate: number | null;
  /**
   * LoRa frequency slot within the region's band. Nodes must agree on this
   * *and* the preset to hear each other at all.
   */
  frequencySlot: number | null;
  hopLimit: number | null;
  txPower: number | null;
  txEnabled: boolean | null;

  /** Seconds between NodeInfo broadcasts. */
  nodeInfoInterval: number | null;
  /** Seconds between position broadcasts. */
  positionInterval: number | null;
  gpsUpdateInterval: number | null;

  /**
   * Device-metrics cadence. There is no companion enable flag here, unlike
   * the other sensor classes: firmware's is `deviceTelemetryEnabled`, which
   * `@meshtastic/core`'s bundled protobufs predate, so the decoder that
   * actually runs drops it. See CLAUDE.md section 4.
   */
  deviceMetricsInterval: number | null;
  environmentInterval: number | null;
  environmentEnabled: boolean | null;
  airQualityInterval: number | null;
  airQualityEnabled: boolean | null;
  powerInterval: number | null;
  powerEnabled: boolean | null;
  healthInterval: number | null;
  healthEnabled: boolean | null;
}

/**
 * Modem presets the decoder in `@meshtastic/core` knows. Newer firmware has
 * more, but a preset the decoder cannot name would be read back as nothing,
 * so offering one would be a write we could never confirm.
 */
export const MODEM_PRESETS = [
  "LONG_FAST",
  "LONG_MODERATE",
  "LONG_SLOW",
  "VERY_LONG_SLOW",
  "MEDIUM_FAST",
  "MEDIUM_SLOW",
  "SHORT_FAST",
  "SHORT_SLOW",
  "SHORT_TURBO",
] as const;
export type ModemPreset = (typeof MODEM_PRESETS)[number];

export type ChannelRole = "PRIMARY" | "SECONDARY" | "DISABLED";

/**
 * What kind of key a channel uses, which is safe to show anyone. The key
 * itself is not.
 *
 * - `none`: no encryption.
 * - `default`: the well-known public key -- encrypted on the air, but
 *   readable by anyone running Meshtastic.
 * - `simple`: one of the well-known variants of the default key (2-10).
 * - `aes128` / `aes256`: a private key.
 */
export type PskKind = "none" | "default" | "simple" | "aes128" | "aes256" | "invalid";

export interface RadioChannel {
  /** 0-7. Index 0 is always the primary. */
  index: number;
  role: ChannelRole;
  name: string;
  pskKind: PskKind;
  /** Base64. Sent to admins only; null for every other role. */
  psk: string | null;
  /** MQTT uplink / downlink. */
  uplinkEnabled: boolean;
  downlinkEnabled: boolean;
  /**
   * Bits of position precision shared on this channel: 0 shares no
   * position, 32 is exact. Null when the channel carries no setting.
   */
  positionPrecision: number | null;
  fetchedAt: number;
}

/** Everything the Radio page shows. Served from the database. */
export interface LocalRadioDetail {
  /** Null until the radio has connected at least once. */
  node: FleetNode | null;
  publicKey: string | null;
  config: NodeRadioConfig | null;
  /** All eight slots once read, disabled ones included. */
  channels: RadioChannel[];
  telemetry: TelemetryPoint[];
  operations: AdminOperation[];
}

/** A LoRa change. Selecting a preset also turns on preset mode. */
export interface LoRaUpdate {
  modemPreset?: ModemPreset;
  /** 0 derives the slot from the primary channel's name; otherwise 1-based. */
  frequencySlot?: number;
}

/** A whole channel, as written. Firmware replaces the channel entirely. */
export interface ChannelUpdate {
  role: ChannelRole;
  name: string;
  /** Base64 of 0, 1, 16 or 32 bytes. */
  psk: string;
  uplinkEnabled: boolean;
  downlinkEnabled: boolean;
  positionPrecision: number;
}

/** Which of the four config reads answered, for reporting a partial result. */
export interface ConfigReadOutcome {
  lora: boolean;
  device: boolean;
  position: boolean;
  telemetry: boolean;
}

export interface NodeDetail {
  node: FleetNode;
  telemetry: TelemetryPoint[];
  positions: PositionPoint[];
  /** Null when nobody has read this node's settings yet. */
  config: NodeRadioConfig | null;
}

/**
 * Connection state of the local USB-attached radio.
 *
 * The server runs perfectly well without one: reads are served from SQLite
 * either way. This is what the UI needs to say so, and to disable the
 * handful of controls that do need the mesh.
 */
export interface RadioStatus {
  connected: boolean;
  configured: boolean;
  /**
   * False when `serial.enabled` is off in config. Distinct from
   * `connected: false`, which means we are trying and failing -- one is a
   * deliberate choice, the other is a fault, and they need different words.
   */
  enabled: boolean;
  portPath: string;
  localNodeNum: number | null;
  lastErrorText: string | null;
  lastConnectedAt: number | null;
  /**
   * Frames the radio sent that could not be decoded as protobuf, since this
   * connection opened.
   *
   * Individually harmless -- the library drops the frame and carries on --
   * but the rate is the useful signal. A handful right after connect is
   * normal resynchronization. A steadily climbing count means real packets
   * are being lost, and the usual cause is the node emitting debug log text
   * over the same serial link (`security.debug_log_api_enabled`).
   */
  decodeErrors: number;
  lastDecodeErrorAt: number | null;
  /**
   * Last packet the radio heard over the air from another node, decodable
   * or not, excluding MQTT. The only evidence available here that the LoRa
   * receiver still works: the watchdog's self-check proves the USB link and
   * the firmware, and says nothing about the transceiver.
   */
  lastAirPacketAt: number | null;
  /** Null when `watchdog.enabled` is off. */
  watchdog: RadioWatchdogStatus | null;
}

/**
 * The radio watchdog's view of the local node.
 *
 * An open serial port is not a working radio. The firmware can close its end
 * of the API session while the port stays open, and from the host side that
 * looks exactly like a quiet mesh. The watchdog asks the node a question
 * with a known answer, on a schedule, and restarts the link when it stops
 * answering.
 *
 * - `pending`: no self-check has completed on this connection yet.
 * - `ok`: the last self-check answered, and matched the connection's baseline.
 * - `failing`: one or more self-checks in a row went unanswered or answered
 *   wrongly. The link is restarted after `failures_before_restart`.
 */
export type WatchdogState = "pending" | "ok" | "failing";

export interface RadioWatchdogStatus {
  state: WatchdogState;
  lastCheckAt: number | null;
  lastOkAt: number | null;
  /** Round trip of the last successful self-check, over USB only. */
  lastLatencyMs: number | null;
  consecutiveFailures: number;
  failuresBeforeRestart: number;
  lastFailureText: string | null;
  /** Serial restarts the watchdog forced since the server started. */
  restarts: number;
  lastRestartAt: number | null;
  lastRestartReason: string | null;
  /**
   * Nothing heard over the air for longer than `silence_after`. Reported,
   * not acted on: a quiet mesh and a deaf transceiver are indistinguishable
   * from here, and only one of them is a fault.
   */
  silent: boolean;
  /** Seconds; null when silence detection is off. */
  silenceAfter: number | null;
  /** What the node reported on this connection's first self-check. */
  firmwareVersion: string | null;
}

/**
 * A user-initiated operation currently occupying the radio.
 *
 * These are mesh round trips measured in tens of seconds, so the UI
 * surfaces them globally and offers a way to stop waiting. Extend
 * `RadioTaskKind` as new operations are added -- traceroute is the obvious
 * next one.
 */
export type RadioTaskKind = "probe" | "config" | "refresh" | "readConfig";

/**
 * What the discovery policy currently admits. Surfaced so an empty fleet
 * can say "nothing has matched yet" rather than the misleading "no nodes
 * have been heard" -- the difference between a quiet mesh and a filter
 * that is excluding everything.
 */
export interface DiscoverySummary {
  /** False when the default "admit anything heard" policy is in force. */
  restricted: boolean;
  /** Human phrasing of the criteria, e.g. `channel 2, message containing "join"`. */
  description: string;
}

/**
 * What is currently holding the radio, if anything.
 *
 * The radio is exclusive — one operation at a time — so this is what lets the
 * UI disable a control *and say why* instead of letting someone click into a
 * 409. It reports **background work too**, which `tasks` deliberately omits:
 * the capability prober's sweeps occupy the radio without anyone waiting on
 * them, and a button that looks available while the server would refuse it is
 * the worst of both worlds.
 */
export interface RadioOccupancy {
  /** Short description, e.g. "Checking admin access". */
  label: string;
  nodeId: string;
  nodeName: string | null;
  startedAt: number;
  /** True for work no one is waiting on, which the task banner does not show. */
  background: boolean;
}

export interface RadioTask {
  id: number;
  kind: RadioTaskKind;
  /** Short human description for the banner, e.g. "Checking admin access". */
  label: string;
  nodeNum: number;
  nodeId: string;
  nodeName: string | null;
  startedAt: number;
  /** How long the server will wait before giving up on its own. */
  timeoutSeconds: number;
}

/**
 * The bounded set of remotely writable settings. Deliberately small: every
 * field here is reversible and non-destructive. Widening this type is a
 * decision, not a detail.
 */
export interface NodeConfigUpdate {
  longName?: string;
  shortName?: string;
}

/**
 * A remote write's lifecycle.
 *
 * `unconfirmed` is not a softer `failed`: the write was sent, nothing
 * acknowledged it, and a read-back went unanswered too, so whether it landed
 * is genuinely unknown. Reporting that as a failure invites a retry of
 * something that may already be done.
 */
export type AdminOperationState =
  | "pending"
  | "confirmed"
  | "unconfirmed"
  | "failed";

export interface AdminOperation {
  id: number;
  nodeNum: number;
  kind: string;
  state: AdminOperationState;
  detail: string | null;
  errorText: string | null;
  createdAt: number;
  settledAt: number | null;
}

export interface ApiError {
  error: string;
}
