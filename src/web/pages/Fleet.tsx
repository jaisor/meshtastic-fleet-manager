import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  LoaderCircle,
  RotateCw,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import type {
  AssistantStatus,
  DiscoverySummary,
  FleetNode,
  RadioOccupancy,
} from "../../shared/types";
import { describeFleetQuery, matchesFleetQuery } from "../../shared/fleetQuery";
import { api, ApiError } from "../api";
import { nodePath } from "../router";
import { BatteryLevel } from "../components/BatteryLevel";
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
import { loadFleetView, saveFleetView, type FleetAnswer } from "./fleetView";

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
  assistant,
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
  /** Null hides the question box: no assistant configured, or a viewer. */
  assistant: AssistantStatus | null;
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
  const { query, sortKey, direction, answer } = view;

  useEffect(() => {
    saveFleetView(view);
  }, [view]);

  const setQuery = (value: string) =>
    setView((current) => ({ ...current, query: value }));

  const clearAnswer = () => setView((current) => ({ ...current, answer: null }));

  /**
   * Applies an answer. An ordering in it is adopted into the sort controls
   * rather than held separately, so the controls always say what the list
   * is doing and the operator can change it from there.
   */
  const applyAnswer = (next: FleetAnswer) =>
    setView((current) => {
      const sort = next.query?.sort;
      return sort
        ? { ...current, answer: next, sortKey: sort.key, direction: sort.direction }
        : { ...current, answer: next };
    });

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
  //
  // An answer's time windows are measured from now on every recompute, so a
  // node heard since the question was asked drops out at the next poll.
  const answerQuery = answer?.query ?? null;
  const visible = useMemo(() => {
    if (!nodes) return [];
    const terms = parseQuery(query);
    const now = Date.now() / 1000;
    const sorted = sortNodes(
      nodes.filter(
        (node) =>
          matchesQuery(node, terms) &&
          (answerQuery === null || matchesFleetQuery(node, answerQuery, now)),
      ),
      sortKey,
      direction,
    );
    // After sorting, so "the 5 weakest" is the five weakest. If the operator
    // re-sorts, the limit follows the new order, which is what they see.
    return answerQuery?.limit !== undefined ? sorted.slice(0, answerQuery.limit) : sorted;
  }, [nodes, query, answerQuery, sortKey, direction]);

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

  const searching = query.trim().length > 0;
  const filtering = searching || answerQuery !== null;

  return (
    <section aria-label="Managed nodes">
      {assistant && (
        <AskBar
          assistant={assistant}
          answer={answer}
          onAnswer={applyAnswer}
          onClear={clearAnswer}
        />
      )}

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
            {answerQuery !== null && searching
              ? `No node answers the question and also matches “${query.trim()}”.`
              : answerQuery !== null
                ? "No node in the fleet answers the question right now."
                : `Nothing matches “${query.trim()}”. Search covers node ID, short and long name, and role.`}
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {searching && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="rounded-lg border border-neutral-800 px-3 py-1.5 text-sm text-neutral-400 transition [corner-shape:bevel] hover:border-amber-500/40 hover:text-amber-400"
              >
                Clear search
              </button>
            )}
            {answerQuery !== null && (
              <button
                type="button"
                onClick={clearAnswer}
                className="rounded-lg border border-neutral-800 px-3 py-1.5 text-sm text-neutral-400 transition [corner-shape:bevel] hover:border-amber-500/40 hover:text-amber-400"
              >
                Clear question
              </button>
            )}
          </div>
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
                        <span className="data">
                          <BatteryLevel level={node.batteryLevel} />
                        </span>
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

/** Matches the server's `MAX_PROMPT_LENGTH`. */
const MAX_QUESTION_LENGTH = 500;

/**
 * The assistant's question box, and the answer it is currently applying.
 *
 * An answer is a filter over this list and nothing more: the server sends
 * the question to the configured LLM, which can only fill in filter fields,
 * and the nodes shown are picked here by `matchesFleetQuery`. Any change to
 * a node is still made from its own page, by a role allowed to make it.
 *
 * What the filter does is described from the query itself, never from the
 * model's prose, so the operator reads exactly what is being applied. The
 * model's own words appear separately, labelled as such.
 */
function AskBar({
  assistant,
  answer,
  onAnswer,
  onClear,
}: {
  assistant: AssistantStatus;
  answer: FleetAnswer | null;
  onAnswer: (answer: FleetAnswer) => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask() {
    const prompt = draft.trim();
    if (!prompt || asking) return;
    setAsking(true);
    setError(null);
    try {
      const result = await api.ask(prompt);
      onAnswer({ prompt, query: result.query, note: result.note });
      setDraft("");
    } catch (cause) {
      // The draft stays, so a rate limit or a timeout costs a click rather
      // than retyping the question.
      setError(
        cause instanceof ApiError ? cause.message : "The question did not reach the server.",
      );
    } finally {
      setAsking(false);
    }
  }

  const clauses = answer?.query ? describeFleetQuery(answer.query) : [];
  const sort = answer?.query?.sort;

  return (
    <div className="mb-4 space-y-2">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void ask();
        }}
        className="flex gap-2"
      >
        <div className="relative min-w-0 flex-1">
          <Sparkles
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-amber-500/60"
          />
          <input
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setDraft("");
            }}
            disabled={asking}
            maxLength={MAX_QUESTION_LENGTH}
            aria-label="Ask a question about the fleet"
            placeholder="Ask about the fleet, e.g. routers not heard in 2 days"
            autoComplete="off"
            className="w-full rounded-lg border border-neutral-800 bg-neutral-950/60 py-2 pr-3 pl-9 text-sm text-neutral-100 placeholder-neutral-600 [corner-shape:bevel] focus:border-amber-500/50 disabled:opacity-60"
          />
        </div>
        <button
          type="submit"
          disabled={asking || draft.trim().length === 0}
          title={`Answered by ${assistant.model} (${assistant.provider}). Finds nodes; changes nothing.`}
          className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-neutral-800 px-3 py-2 text-sm text-neutral-300 transition [corner-shape:bevel] hover:border-amber-500/40 hover:text-amber-400 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-neutral-800 disabled:hover:text-neutral-300"
        >
          {asking && <LoaderCircle aria-hidden className="h-4 w-4 animate-spin" />}
          {asking ? "Asking…" : "Ask"}
        </button>
      </form>

      {error && (
        <p role="alert" className="text-xs text-amber-200/90">
          {error}
        </p>
      )}

      {answer && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2.5 text-sm [corner-shape:bevel]"
        >
          <div className="min-w-0 flex-1 space-y-1">
            <p className="truncate text-neutral-400" title={answer.prompt}>
              “{answer.prompt}”
            </p>
            {answer.query === null ? (
              <p className="text-neutral-500">Not answered. The list is unfiltered.</p>
            ) : (
              <p className="text-neutral-200">
                {clauses.length > 0
                  ? `Showing nodes ${clauses.join(" · ")}`
                  : "Showing every node"}
                {sort && (
                  <span className="text-neutral-500">
                    {" "}
                    — sorted by {sortOption(sort.key).label.toLowerCase()},{" "}
                    {directionLabel(sort.key, sort.direction).toLowerCase()}
                  </span>
                )}
              </p>
            )}
            {answer.note && (
              <p className="text-xs text-neutral-500">
                <span className="text-neutral-400">Assistant:</span> {answer.note}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClear}
            className="shrink-0 rounded p-1 text-neutral-500 transition hover:text-amber-400"
          >
            <X aria-hidden className="h-4 w-4" />
            <span className="sr-only">Clear the question</span>
          </button>
        </div>
      )}
    </div>
  );
}
