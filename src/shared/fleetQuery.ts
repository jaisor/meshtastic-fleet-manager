/**
 * A structured question about the fleet, and the one function that answers it.
 *
 * This is what the assistant produces: a free-text question goes to the
 * configured LLM, comes back as a `FleetQuery`, and is applied here -- in the
 * browser, to the list it already holds, like the search box. The model never
 * sees a node and never decides which nodes match; it only translates words
 * into these fields. That keeps the answer deterministic and checkable, and it
 * keeps node names out of the prompt, which matters because anyone on the mesh
 * can set a node's name to whatever text they like.
 *
 * Imported by both halves, so nothing here may import from `server/` or `web/`.
 */

import type {
  AdminCapability,
  FleetNode,
  NodeState,
  SignalQuality,
} from "./types.js";

/** The fleet list's sort keys. The labels and default directions live in the UI. */
export const FLEET_SORT_KEYS = [
  "name",
  "lastHeard",
  "role",
  "battery",
  "admin",
  "signal",
  "hops",
] as const;
export type FleetSortKey = (typeof FLEET_SORT_KEYS)[number];

export const NODE_STATES: NodeState[] = ["online", "stale", "offline"];
export const ADMIN_CAPABILITIES: AdminCapability[] = [
  "capable",
  "unauthorized",
  "unreachable",
  "unknown",
];
export const SIGNAL_QUALITIES: SignalQuality[] = ["good", "medium", "bad", "unknown"];

/**
 * Every field narrows the result, and they compose with AND. An absent field
 * places no constraint. A field whose node value is unknown does not match:
 * a node that never reported a battery is not "below 20%".
 */
export interface FleetQuery {
  /** Matched like the search box: ID, names and role, every term required. */
  text?: string[];
  states?: NodeState[];
  /** Seconds. A node never heard at all counts as older than any threshold. */
  lastHeardOlderThan?: number;
  /** Seconds. */
  lastHeardWithin?: number;
  /** Percent. Excludes nodes on external power, which report above 100. */
  batteryBelow?: number;
  batteryAtLeast?: number;
  /** Firmware reports external power as a battery level above 100. */
  externallyPowered?: boolean;
  /** Firmware role names, e.g. `ROUTER`, `CLIENT_MUTE`. */
  roles?: string[];
  /** Fragments of the hardware model, e.g. `heltec`, `tbeam`. */
  hardware?: string[];
  adminCapability?: AdminCapability[];
  signal?: SignalQuality[];
  hopsAtMost?: number;
  hopsAtLeast?: number;
  /** Dotted version, e.g. `2.7`. Nodes with no reported firmware never match. */
  firmwareBelow?: string;
  sort?: { key: FleetSortKey; direction: "asc" | "desc" };
  /** Keep only the first N after sorting. */
  limit?: number;
}

/**
 * The search box's matching, shared so the assistant's `text` and the typed
 * search behave identically.
 *
 * Matches against node ID, both names, and the role in both its raw protobuf
 * spelling and its displayed one -- so `CLIENT_MUTE`, `client mute` and plain
 * `mute` all find the same node. Terms are ANDed rather than matched as one
 * substring, so `grg router` finds a node whose short name and role are
 * nowhere near each other in the text.
 */
export function matchesTerms(node: FleetNode, terms: string[]): boolean {
  if (terms.length === 0) return true;

  const haystack = [
    node.nodeId,
    node.shortName,
    node.longName,
    node.role,
    node.role?.replace(/_/g, " "),
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .toLowerCase();

  return terms.every((term) => haystack.includes(term.toLowerCase()));
}

/** `HELTEC_V3`, `heltec v3` and `Heltec-V3` all compare equal. */
function squash(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Leading numeric parts only: `2.7.26.54e0d8d` -> [2, 7, 26]. */
function versionParts(value: string): number[] {
  const parts: number[] = [];
  for (const piece of value.split(".")) {
    if (!/^\d+$/.test(piece)) break;
    parts.push(Number(piece));
  }
  return parts;
}

function versionBelow(version: string, ceiling: string): boolean {
  const a = versionParts(version);
  const b = versionParts(ceiling);
  if (a.length === 0 || b.length === 0) return false;
  for (let i = 0; i < b.length; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right;
  }
  return false;
}

/** `now` is UTC epoch seconds, passed in so the function stays pure. */
export function matchesFleetQuery(
  node: FleetNode,
  query: FleetQuery,
  now: number,
): boolean {
  if (query.text && !matchesTerms(node, query.text)) return false;
  if (query.states && !query.states.includes(node.state)) return false;

  if (query.lastHeardOlderThan !== undefined) {
    if (node.lastHeardAt !== null && now - node.lastHeardAt <= query.lastHeardOlderThan) {
      return false;
    }
  }
  if (query.lastHeardWithin !== undefined) {
    if (node.lastHeardAt === null || now - node.lastHeardAt > query.lastHeardWithin) {
      return false;
    }
  }

  const battery = node.batteryLevel;
  if (query.batteryBelow !== undefined) {
    if (battery === null || battery > 100 || battery >= query.batteryBelow) return false;
  }
  if (query.batteryAtLeast !== undefined) {
    if (battery === null || battery > 100 || battery < query.batteryAtLeast) return false;
  }
  if (query.externallyPowered !== undefined) {
    if (battery === null) return false;
    if (battery > 100 !== query.externallyPowered) return false;
  }

  if (query.roles) {
    if (node.role === null || !query.roles.includes(node.role)) return false;
  }
  if (query.hardware) {
    const model = node.hwModel === null ? null : squash(node.hwModel);
    if (model === null || !query.hardware.some((part) => model.includes(squash(part)))) {
      return false;
    }
  }
  if (query.adminCapability && !query.adminCapability.includes(node.adminCapability)) {
    return false;
  }
  if (query.signal && !query.signal.includes(node.signal)) return false;

  if (query.hopsAtMost !== undefined) {
    if (node.hopsAway === null || node.hopsAway > query.hopsAtMost) return false;
  }
  if (query.hopsAtLeast !== undefined) {
    if (node.hopsAway === null || node.hopsAway < query.hopsAtLeast) return false;
  }
  if (query.firmwareBelow !== undefined) {
    if (node.firmwareVersion === null || !versionBelow(node.firmwareVersion, query.firmwareBelow)) {
      return false;
    }
  }

  return true;
}

/** `172800` -> `2 days`. Whole units only; the model is asked for those. */
export function describeDuration(seconds: number): string {
  const units: [number, string][] = [
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [size, name] of units) {
    if (seconds >= size && seconds % size === 0) {
      const amount = seconds / size;
      return `${amount} ${name}${amount === 1 ? "" : "s"}`;
    }
  }
  return `${seconds} seconds`;
}

function list(values: string[], joiner = "or"): string {
  if (values.length <= 1) return values.join("");
  return `${values.slice(0, -1).join(", ")} ${joiner} ${values.at(-1)}`;
}

/**
 * The query in plain words, one clause per constraint.
 *
 * Built from the structured query, never from anything the model wrote, so
 * what the operator reads is exactly what is being applied. The model's own
 * prose travels separately as a note.
 */
export function describeFleetQuery(query: FleetQuery): string[] {
  const clauses: string[] = [];
  if (query.text?.length) clauses.push(`matching “${query.text.join(" ")}”`);
  if (query.states?.length) clauses.push(list(query.states));
  if (query.lastHeardOlderThan !== undefined) {
    clauses.push(`not heard for over ${describeDuration(query.lastHeardOlderThan)}`);
  }
  if (query.lastHeardWithin !== undefined) {
    clauses.push(`heard within ${describeDuration(query.lastHeardWithin)}`);
  }
  if (query.batteryBelow !== undefined) clauses.push(`battery below ${query.batteryBelow}%`);
  if (query.batteryAtLeast !== undefined) {
    clauses.push(`battery at least ${query.batteryAtLeast}%`);
  }
  if (query.externallyPowered !== undefined) {
    clauses.push(query.externallyPowered ? "on external power" : "on battery");
  }
  if (query.roles?.length) {
    clauses.push(`role ${list(query.roles.map((role) => role.replace(/_/g, " ").toLowerCase()))}`);
  }
  if (query.hardware?.length) clauses.push(`hardware ${list(query.hardware)}`);
  if (query.adminCapability?.length) {
    clauses.push(`remote admin ${list(query.adminCapability)}`);
  }
  if (query.signal?.length) clauses.push(`signal ${list(query.signal)}`);
  if (query.hopsAtMost !== undefined) {
    clauses.push(query.hopsAtMost === 0 ? "heard directly" : `at most ${query.hopsAtMost} hops away`);
  }
  if (query.hopsAtLeast !== undefined) clauses.push(`at least ${query.hopsAtLeast} hops away`);
  if (query.firmwareBelow !== undefined) clauses.push(`firmware older than ${query.firmwareBelow}`);
  if (query.limit !== undefined) clauses.push(`first ${query.limit}`);
  return clauses;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string" && item !== "");
  return strings.length > 0 ? strings : undefined;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T[] | undefined {
  const strings = stringArray(value);
  if (!strings) return undefined;
  const kept = strings.filter((item): item is T => (allowed as readonly string[]).includes(item));
  return kept.length > 0 ? kept : undefined;
}

function count(value: unknown, max: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max
    ? Math.floor(value)
    : undefined;
}

/**
 * Rebuilds a query from untrusted input, keeping only well-typed fields.
 *
 * The browser restores the last answer from sessionStorage, which can hold
 * anything a previous build wrote. A stored sort key that no longer exists
 * would reach the comparator's exhaustive switch and sort by NaN, so every
 * field is checked rather than trusted, as in `fleetView.ts`.
 */
export function sanitizeFleetQuery(value: unknown): FleetQuery {
  if (typeof value !== "object" || value === null) return {};
  const raw = value as Record<string, unknown>;
  const query: FleetQuery = {};

  const text = stringArray(raw.text);
  if (text) query.text = text;
  const states = oneOf(raw.states, NODE_STATES);
  if (states) query.states = states;
  const older = count(raw.lastHeardOlderThan, 10 * 365 * 86400);
  if (older !== undefined) query.lastHeardOlderThan = older;
  const within = count(raw.lastHeardWithin, 10 * 365 * 86400);
  if (within !== undefined) query.lastHeardWithin = within;
  const below = count(raw.batteryBelow, 100);
  if (below !== undefined) query.batteryBelow = below;
  const atLeast = count(raw.batteryAtLeast, 100);
  if (atLeast !== undefined) query.batteryAtLeast = atLeast;
  if (typeof raw.externallyPowered === "boolean") {
    query.externallyPowered = raw.externallyPowered;
  }
  const roles = stringArray(raw.roles);
  if (roles) query.roles = roles;
  const hardware = stringArray(raw.hardware);
  if (hardware) query.hardware = hardware;
  const admin = oneOf(raw.adminCapability, ADMIN_CAPABILITIES);
  if (admin) query.adminCapability = admin;
  const signal = oneOf(raw.signal, SIGNAL_QUALITIES);
  if (signal) query.signal = signal;
  const hopsAtMost = count(raw.hopsAtMost, 15);
  if (hopsAtMost !== undefined) query.hopsAtMost = hopsAtMost;
  const hopsAtLeast = count(raw.hopsAtLeast, 15);
  if (hopsAtLeast !== undefined) query.hopsAtLeast = hopsAtLeast;
  if (typeof raw.firmwareBelow === "string" && versionParts(raw.firmwareBelow).length > 0) {
    query.firmwareBelow = raw.firmwareBelow;
  }

  const sort = raw.sort as Record<string, unknown> | null | undefined;
  if (
    sort &&
    typeof sort === "object" &&
    (FLEET_SORT_KEYS as readonly unknown[]).includes(sort.key) &&
    (sort.direction === "asc" || sort.direction === "desc")
  ) {
    query.sort = { key: sort.key as FleetSortKey, direction: sort.direction };
  }
  const limit = count(raw.limit, 1000);
  if (limit !== undefined && limit > 0) query.limit = limit;

  return query;
}

/** True when the query constrains nothing and orders nothing. */
export function isEmptyFleetQuery(query: FleetQuery): boolean {
  return Object.keys(query).length === 0;
}
