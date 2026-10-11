import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronRight, RotateCw, Search, X } from "lucide-react";
import type {
  DiscoverySummary,
  FleetNode,
  RadioOccupancy,
} from "../../shared/types";
import { api, ApiError } from "../api";
import { nodePath } from "../router";
import { CapabilityBadge } from "../components/CapabilityBadge";
import { describeOccupancy, NO_RADIO_HINT } from "../components/NodeFields";
import { SignalDot } from "../components/SignalDot";
import { StatusDot } from "../components/StatusDot";
import { absoluteTime, metric, relativeTime } from "../components/format";
import {
  directionLabel,
  matchesQuery,
  parseQuery,
  sortNodes,
  sortOption,
  SORT_OPTIONS,
  type SortDirection,
  type SortKey,
} from "./fleetOrdering";
import { loadFleetView, saveFleetView } from "./fleetView";

/** Poll cadence. The mesh is slow; refreshing faster would show nothing new. */
const REFRESH_MS = 20_000;

/** How long a row's refresh result stays on screen. */
const REFRESH_NOTE_MS = 10_000;

export function Fleet({
  onOpen,
  discovery,
  radioConnected,
  canOperate,
  radioBusy,
}: {
  onOpen: (path: string) => void;
  /** Null until the first status poll lands. */
  discovery: DiscoverySummary | null;
  /** Connected and identified: an open port with a silent radio is not. */
  radioConnected: boolean;
  /** Viewers get no refresh control at all, as on the node page. */
  canOperate: boolean;
  /** Anything holding the radio, background sweeps included. */
  radioBusy: RadioOccupancy | null;
}) {
  const [nodes, setNodes] = useState<FleetNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * The node this page is refreshing, if any. The server's `radioBusy`
   * arrives by poll, so between a click and the next poll every other row
   * would still look available; this closes that window locally.
   */
  const [refreshing, setRefreshing] = useState<number | null>(null);
  /** The last refresh's outcome, shown under its row for a few seconds. */
  const [note, setNote] = useState<{ nodeNum: number; text: string; ok: boolean } | null>(
    null,
  );

  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(null), REFRESH_NOTE_MS);
    return () => clearTimeout(timer);
  }, [note]);

  /**
   * Why every row's refresh is disabled, or null. One value for one radio,
   * as on the node page: whatever the reason, it applies to every row.
   */
  const blockedReason = !radioConnected
    ? NO_RADIO_HINT
    : refreshing !== null
      ? "Waiting for the refresh you just started. The radio handles one node at a time."
      : radioBusy
        ? describeOccupancy(radioBusy)
        : null;

  async function refresh(node: FleetNode) {
    setRefreshing(node.nodeNum);
    setNote(null);
    try {
      const { received, node: updated } = await api.refreshNode(node.nodeId);
      // Swap the row in place rather than refetching the list: the server
      // read it back after the replies landed, so it is already current.
      setNodes((current) =>
        current?.map((n) => (n.nodeNum === updated.nodeNum ? updated : n)) ?? current,
      );
      const got = [
        received.identity && "identity",
        received.metrics && "metrics",
        received.position && "position",
      ].filter(Boolean);
      // Say what came back: a node that answered nothing would otherwise
      // look exactly like one that did.
      setNote({
        nodeNum: node.nodeNum,
        ok: got.length > 0,
        text:
          got.length === 0
            ? "No answer. The node may be asleep or out of range."
            : `Updated: ${got.join(", ")}.`,
      });
    } catch (cause) {
      setNote({
        nodeNum: node.nodeNum,
        ok: false,
        text: cause instanceof ApiError ? cause.message : "The request did not complete.",
      });
    } finally {
      setRefreshing(null);
    }
  }
  // Seeded from sessionStorage so the view survives a trip into a node's
  // detail page, which unmounts this component entirely.
  const [view, setView] = useState(loadFleetView);
  const { query, sortKey, direction } = view;

  useEffect(() => {
    saveFleetView(view);
  }, [view]);

  const setQuery = (value: string) =>
    setView((current) => ({ ...current, query: value }));

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const result = await api.listNodes();
        if (!cancelled) {
          setNodes(result.nodes);
          setError(null);
        }
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message);
      }
    }

    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // Recomputed only when the data or the controls change, so typing does not
  // re-sort on unrelated renders. At a few hundred nodes this is cheap either
  // way; it keeps the 20s poll from doing needless work.
  const visible = useMemo(() => {
    if (!nodes) return [];
    const terms = parseQuery(query);
    return sortNodes(
      nodes.filter((node) => matchesQuery(node, terms)),
      sortKey,
      direction,
    );
  }, [nodes, query, sortKey, direction]);

  if (error) {
    return <p className="card p-6 text-red-400">{error}</p>;
  }

  if (nodes === null) {
    return <p className="p-6 text-neutral-500">Loading fleet…</p>;
  }

  if (nodes.length === 0) {
    return (
      <div className="card p-8 text-center">
        <h2 className="text-lg font-semibold text-white">No nodes yet</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-neutral-500">
          Discovery is passive: nodes appear here as the local radio hears
          them. A quiet mesh can take a while — nodes broadcast their
          identity roughly every few hours.
        </p>
        {discovery?.restricted && (
          // Without this an active filter is indistinguishable from a quiet
          // mesh, and the obvious conclusion is that the radio is broken.
          <p className="mx-auto mt-4 max-w-md rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200/90 [corner-shape:bevel]">
            Discovery is narrowed to{" "}
            <span className="font-medium">{discovery.description}</span>.
            Anything else the radio hears is ignored and never recorded.
          </p>
        )}
      </div>
    );
  }

  const filtering = query.trim().length > 0;

  return (
    <section aria-label="Managed nodes">
      <FleetToolbar
        query={query}
        onQueryChange={setQuery}
        sortKey={sortKey}
        direction={direction}
        onSortKeyChange={(key) =>
          setView((current) => ({
            ...current,
            sortKey: key,
            // Each key has a direction that answers the usual question
            // first, so adopt it rather than carrying the previous one over.
            direction: sortOption(key).defaultDirection,
          }))
        }
        onToggleDirection={() =>
          setView((current) => ({
            ...current,
            direction: current.direction === "asc" ? "desc" : "asc",
          }))
        }
      />

      <h2
        aria-live="polite"
        className="mb-4 text-sm font-medium tracking-wide text-neutral-500 uppercase"
      >
        {filtering
          ? `${visible.length} of ${nodes.length} nodes`
          : `${nodes.length} ${nodes.length === 1 ? "node" : "nodes"}`}
      </h2>

      {visible.length === 0 ? (
        <div className="card p-8 text-center">
          <h3 className="text-base font-semibold text-white">No matches</h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-neutral-500">
            Nothing matches “{query.trim()}”. Search covers node ID, short and
            long name, and role.
          </p>
          <button
            type="button"
            onClick={() => setQuery("")}
            className="mt-4 rounded-lg border border-neutral-800 px-3 py-1.5 text-sm text-neutral-400 transition [corner-shape:bevel] hover:border-amber-500/40 hover:text-amber-400"
          >
            Clear search
          </button>
        </div>
      ) : (
        <ul className="space-y-2">
          {visible.map((node) => (
            // The card is the <li>, not the link, because the refresh button
            // cannot live inside an <a>: nested interactive content is
            // invalid, and a click on it would also navigate.
            <li key={node.nodeNum} className="card card-link">
              <div className="flex items-stretch">
                <a
                  href={nodePath(node.nodeId)}
                  onClick={(event) => {
                    // Let modified clicks open a new tab as usual.
                    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                    event.preventDefault();
                    onOpen(nodePath(node.nodeId));
                  }}
                  className="flex min-w-0 flex-1 flex-col gap-3 rounded-xl p-4 [corner-shape:bevel] focus-visible:outline-2 focus-visible:outline-amber-500/60 sm:min-h-16 sm:flex-row sm:items-center sm:gap-4"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="truncate font-semibold text-white">
                        {node.longName ?? node.nodeId}
                      </span>
                      {node.shortName && (
                        <span className="data rounded border border-neutral-800 px-1.5 py-0.5 text-xs text-amber-500/80 [corner-shape:bevel]">
                          {node.shortName}
                        </span>
                      )}
                      {node.isLocal && (
                        <span className="text-xs font-medium text-amber-400">
                          local
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-500">
                      <span className="data">{node.nodeId}</span>
                      <span title={absoluteTime(node.lastHeardAt)}>
                        Heard {relativeTime(node.lastHeardAt)}
                      </span>
                      {node.batteryLevel !== null && (
                        <span className="data">{node.batteryLevel}%</span>
                      )}
                      {node.snr !== null && (
                        <span className="data" title="Signal-to-noise ratio of the last direct packet">
                          {metric(node.snr, " dB")}
                        </span>
                      )}
                      {node.rssi !== null && (
                        <span className="data" title="Signal strength of the last direct packet">
                          {metric(node.rssi, " dBm", 0)}
                        </span>
                      )}
                      {node.hopsAway !== null && (
                        <span title="Relays between the local radio and this node">
                          {node.hopsAway === 0
                            ? "direct"
                            : `${node.hopsAway} hop${node.hopsAway === 1 ? "" : "s"}`}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Side by side on a phone, stacked in a fixed column above it,
                      so the badges cannot crowd the metadata line. */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2 sm:w-44 sm:shrink-0 sm:flex-col sm:items-end sm:gap-1.5">
                    {/* Reachability and link quality read together, so they
                        share a line; the admin badge is a different kind of
                        fact and sits under them. */}
                    <span className="flex items-center gap-3">
                      <StatusDot state={node.state} />
                      {!node.isLocal && <SignalDot signal={node.signal} />}
                    </span>
                    {!node.isLocal && (
                      <CapabilityBadge capability={node.adminCapability} />
                    )}
                  </div>

                  <ChevronRight
                    aria-hidden
                    className="hidden h-5 w-5 shrink-0 text-neutral-700 sm:block"
                  />
                </a>
                {canOperate && (
                  <button
                    type="button"
                    onClick={() => void refresh(node)}
                    disabled={blockedReason !== null}
                    title={
                      refreshing === node.nodeNum
                        ? "Asking the node…"
                        : (blockedReason ??
                          "Ask the node for its current identity, metrics and position")
                    }
                    className="flex shrink-0 items-center border-l border-neutral-800 px-4 text-neutral-500 transition hover:text-amber-400 focus-visible:outline-2 focus-visible:outline-amber-500/60 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-neutral-500"
                  >
                    <RotateCw
                      aria-hidden
                      className={`h-4 w-4 ${refreshing === node.nodeNum ? "animate-spin" : ""}`}
                    />
                    <span className="sr-only">
                      Refresh {node.longName ?? node.shortName ?? node.nodeId} from the node
                    </span>
                  </button>
                )}
              </div>
              {note?.nodeNum === node.nodeNum && (
                <p
                  role="status"
                  className={`border-t border-neutral-800 px-4 py-2 text-xs ${note.ok ? "text-emerald-300/90" : "text-amber-200/90"}`}
                >
                  {note.text}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FleetToolbar({
  query,
  onQueryChange,
  sortKey,
  direction,
  onSortKeyChange,
  onToggleDirection,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  sortKey: SortKey;
  direction: SortDirection;
  onSortKeyChange: (key: SortKey) => void;
  onToggleDirection: () => void;
}) {
  const meaning = directionLabel(sortKey, direction);

  return (
    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
      <div className="relative flex-1">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-neutral-600"
        />
        <input
          type="text"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          // Escape clears without reaching for the mouse, the convention for
          // a filter field.
          onKeyDown={(event) => {
            if (event.key === "Escape") onQueryChange("");
          }}
          aria-label="Search nodes by ID, name or role"
          placeholder="Search ID, name or role…"
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded-lg border border-neutral-800 bg-neutral-950/60 py-2 pr-9 pl-9 text-sm text-neutral-100 placeholder-neutral-600 [corner-shape:bevel] focus:border-amber-500/50"
        />
        {query && (
          <button
            type="button"
            onClick={() => onQueryChange("")}
            aria-label="Clear search"
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-neutral-600 transition hover:text-amber-400"
          >
            <X aria-hidden className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="flex items-center gap-2">
        <label htmlFor="fleet-sort" className="sr-only">
          Sort nodes by
        </label>
        <select
          id="fleet-sort"
          value={sortKey}
          onChange={(event) => onSortKeyChange(event.target.value as SortKey)}
          className="rounded-lg border border-neutral-800 bg-neutral-950/60 px-3 py-2 text-sm text-neutral-200 [corner-shape:bevel] focus:border-amber-500/50 [&>option]:bg-neutral-900"
        >
          {SORT_OPTIONS.map((option) => (
            <option key={option.key} value={option.key}>
              Sort: {option.label}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={onToggleDirection}
          // The arrow alone cannot say what "ascending" means for battery or
          // admin capability, so the meaning is spelled out where it fits and
          // lives in the tooltip where it does not.
          title={`Sorted ${meaning.toLowerCase()} — click to reverse`}
          className="inline-flex items-center gap-2 rounded-lg border border-neutral-800 px-3 py-2 text-xs text-neutral-400 transition [corner-shape:bevel] hover:border-amber-500/40 hover:text-amber-400"
        >
          {direction === "asc" ? (
            <ArrowUp aria-hidden className="h-4 w-4" />
          ) : (
            <ArrowDown aria-hidden className="h-4 w-4" />
          )}
          <span className="hidden whitespace-nowrap sm:inline">{meaning}</span>
          <span className="sr-only">
            Sorted {meaning.toLowerCase()}. Activate to reverse the order.
          </span>
        </button>
      </div>
    </div>
  );
}
