import type {
  AdminCapability,
  FleetNode,
  SignalQuality,
} from "../../shared/types";
import { humanizeEnum } from "../components/format";

/**
 * Filtering and ordering for the fleet list, done entirely in the browser.
 *
 * The fleet is expected to stay under a few hundred nodes, and the list is
 * already fetched in full for rendering, so pushing this to SQLite would
 * add query surface and a round trip per keystroke to save work that a
 * loop over a few hundred objects does imperceptibly.
 *
 * Kept as pure functions, separate from the component, because the
 * interesting part is the comparator edge cases rather than the markup.
 */

export type SortKey =
  | "name"
  | "lastHeard"
  | "role"
  | "battery"
  | "admin"
  | "signal"
  | "hops";

export type SortDirection = "asc" | "desc";

export interface SortOption {
  key: SortKey;
  label: string;
  /**
   * Which direction to apply when this key is first selected. Chosen so the
   * first click lands on the answer someone is usually after: the most
   * recent check-ins, the batteries about to die, the weakest links.
   */
  defaultDirection: SortDirection;
  ascLabel: string;
  descLabel: string;
}

export const SORT_OPTIONS: SortOption[] = [
  {
    key: "name",
    label: "Short name",
    defaultDirection: "asc",
    ascLabel: "A → Z",
    descLabel: "Z → A",
  },
  {
    key: "lastHeard",
    label: "Last heard",
    defaultDirection: "desc",
    ascLabel: "Oldest first",
    descLabel: "Newest first",
  },
  {
    key: "role",
    label: "Role",
    defaultDirection: "asc",
    ascLabel: "A → Z",
    descLabel: "Z → A",
  },
  {
    key: "battery",
    label: "Battery",
    defaultDirection: "asc",
    ascLabel: "Lowest first",
    descLabel: "Highest first",
  },
  {
    key: "admin",
    label: "Remote admin",
    defaultDirection: "asc",
    ascLabel: "Capable first",
    descLabel: "Capable last",
  },
  {
    key: "signal",
    label: "Signal",
    defaultDirection: "asc",
    ascLabel: "Weakest first",
    descLabel: "Strongest first",
  },
  {
    key: "hops",
    label: "Hops away",
    defaultDirection: "asc",
    ascLabel: "Nearest first",
    descLabel: "Furthest first",
  },
];

export function sortOption(key: SortKey): SortOption {
  // The list is exhaustive over SortKey, so the fallback is unreachable;
  // it exists so this returns a value rather than `| undefined`.
  return SORT_OPTIONS.find((option) => option.key === key) ?? SORT_OPTIONS[0]!;
}

export function directionLabel(key: SortKey, direction: SortDirection): string {
  const option = sortOption(key);
  return direction === "asc" ? option.ascLabel : option.descLabel;
}

/**
 * Ordering for the admin badge: the states an operator can act on come
 * first. `capable` is the useful set, `unauthorized` is the actionable
 * problem (add a key), `unreachable` may just be out of range, and
 * `unknown` is merely "not yet probed".
 */
const ADMIN_RANK: Record<AdminCapability, number> = {
  capable: 0,
  unauthorized: 1,
  unreachable: 2,
  unknown: 3,
};

/**
 * Worst first, so ascending surfaces the links in trouble — the same
 * direction convention as battery. `unknown` maps to null rather than a
 * rank so it falls to the bottom in *both* directions: an unmeasured link
 * is an absence, not a degree of badness, and sorting it next to the weak
 * ones would misrepresent it.
 */
const SIGNAL_RANK: Record<Exclude<SignalQuality, "unknown">, number> = {
  bad: 0,
  medium: 1,
  good: 2,
};

/** Splits the raw input into terms; every term must match (AND, not OR). */
export function parseQuery(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Matches against node ID, both names, and the role in both its raw
 * protobuf spelling and its displayed one — so `CLIENT_MUTE`, `client mute`
 * and plain `mute` all find the same node.
 *
 * Terms are ANDed rather than matched as one substring, so `grg router`
 * finds a node whose short name and role are nowhere near each other in the
 * text. The `!` on a node ID is part of the haystack, so both `!a4c1` and
 * `a4c1` match.
 */
export function matchesQuery(node: FleetNode, terms: string[]): boolean {
  if (terms.length === 0) return true;

  const haystack = [
    node.nodeId,
    node.shortName,
    node.longName,
    node.role,
    humanizeEnum(node.role),
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .toLowerCase();

  return terms.every((term) => haystack.includes(term));
}

function valueFor(node: FleetNode, key: SortKey): string | number | null {
  switch (key) {
    case "name":
      return node.shortName;
    case "lastHeard":
      return node.lastHeardAt;
    case "role":
      return humanizeEnum(node.role);
    case "battery":
      return node.batteryLevel;
    case "admin":
      return ADMIN_RANK[node.adminCapability];
    case "signal":
      return node.signal === "unknown" ? null : SIGNAL_RANK[node.signal];
    case "hops":
      return node.hopsAway;
  }
}

/**
 * Compares two possibly-null values.
 *
 * Nulls sort last in *both* directions, so reversing is deliberately not a
 * pure reversal. Sorting by battery ascending to find the flat ones is
 * useless if it opens with a wall of nodes that never reported a battery at
 * all, and the same goes for SNR and unnamed nodes.
 */
function compare(
  a: string | number | null,
  b: string | number | null,
  direction: SortDirection,
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;

  const raw =
    typeof a === "string" && typeof b === "string"
      ? // `numeric` so Node2 precedes Node10; `base` so case never decides.
        a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
      : Number(a) - Number(b);

  return direction === "asc" ? raw : -raw;
}

export function sortNodes(
  nodes: FleetNode[],
  key: SortKey,
  direction: SortDirection,
): FleetNode[] {
  // `toSorted` rather than a copy plus `sort`: the caller's array is React
  // state and must not be reordered in place.
  return nodes.toSorted((a, b) => {
    const primary = compare(valueFor(a, key), valueFor(b, key), direction);
    if (primary !== 0) return primary;

    // Stable tie-break. The list is refetched every 20s and the server's own
    // ordering shifts as nodes are heard, so equal rows would otherwise swap
    // places under the pointer on each poll.
    return a.nodeNum - b.nodeNum;
  });
}
