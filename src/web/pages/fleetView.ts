import {
  SORT_OPTIONS,
  type SortDirection,
  type SortKey,
} from "./fleetOrdering";

/**
 * The fleet list's search and sort selections, remembered for the tab.
 *
 * `Fleet` unmounts whenever a node's detail page opens, so without this the
 * filter and sort reset every time someone drills into a node and comes
 * back — the exact moment they are most likely to want them kept.
 *
 * `sessionStorage`, not `localStorage`: this is a working view, scoped to
 * the tab and discarded when it closes. It also survives a hard refresh,
 * which matters because a deep link like `/nodes/!a4c138f0` reloads the
 * whole app through the SPA fallback.
 */

const STORAGE_KEY = "mfm.fleetView";

export interface FleetView {
  query: string;
  sortKey: SortKey;
  direction: SortDirection;
}

export const DEFAULT_FLEET_VIEW: FleetView = {
  query: "",
  sortKey: "name",
  direction: "asc",
};

function isSortKey(value: unknown): value is SortKey {
  return SORT_OPTIONS.some((option) => option.key === value);
}

function isDirection(value: unknown): value is SortDirection {
  return value === "asc" || value === "desc";
}

/**
 * Reads the stored view, falling back to defaults on anything unexpected.
 *
 * Every field is validated rather than trusted. A stored `sortKey` from a
 * build where that key existed under another name would otherwise reach the
 * comparator, which switches exhaustively over `SortKey` and would hand it
 * `undefined` — sorting the list by NaN. Storage is also allowed to be
 * missing or to throw outright: private windows and blocked site data both
 * do that, and the list must still render.
 */
export function loadFleetView(): FleetView {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_FLEET_VIEW;

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return DEFAULT_FLEET_VIEW;
    }

    const { query, sortKey, direction } = parsed as Partial<FleetView>;
    return {
      query: typeof query === "string" ? query : DEFAULT_FLEET_VIEW.query,
      sortKey: isSortKey(sortKey) ? sortKey : DEFAULT_FLEET_VIEW.sortKey,
      direction: isDirection(direction)
        ? direction
        : DEFAULT_FLEET_VIEW.direction,
    };
  } catch {
    return DEFAULT_FLEET_VIEW;
  }
}

/** Best-effort. A failure here costs a remembered filter, nothing more. */
export function saveFleetView(view: FleetView): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(view));
  } catch {
    // Storage unavailable or full; the view simply will not persist.
  }
}
