/**
 * The HTTP contract between the server and the web UI. Imported by both
 * sides so a change to a response shape breaks the build rather than the
 * browser. Nothing here may import from `server/` or `web/`.
 */

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
  snr: number | null;
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

export interface NodeDetail {
  node: FleetNode;
  telemetry: TelemetryPoint[];
  positions: PositionPoint[];
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

export type AdminOperationState = "pending" | "confirmed" | "failed";

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
