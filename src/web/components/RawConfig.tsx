import { useEffect, useMemo, useState } from "react";
import { Check, Copy, FileJson } from "lucide-react";
import { api, ApiError } from "../api";
import {
  RAW_CONFIG_GROUP_LABELS,
  RAW_CONFIG_SECTIONS,
  rawConfigReads,
  type RawConfigGroup,
  type RawConfigReadResult,
  type RawConfigSection,
  type RawConfigSectionId,
} from "../../shared/rawConfig";
import { ACTION_BUTTON } from "./NodeFields";
import { absoluteTime, relativeTime } from "./format";

const GROUPS: RawConfigGroup[] = ["config", "module", "identity"];

/** Sections this close were read by one query, however slow the mesh was. */
const READ_TOGETHER_SECONDS = 120;

/**
 * A node's configuration as the JSON it answers with.
 *
 * The structured panel above it shows the settings this console understands;
 * this shows everything, including what it has no opinion on. Stored sections
 * load from the database, so the view works offline and for viewers. Querying is
 * the part that needs the radio.
 *
 * Over the mesh each section is a round trip on a duty-cycled band, so the
 * sections are chosen rather than always fetched, and the button states the
 * cost. Over USB nothing is transmitted, so everything is selected to begin with.
 */
export function RawConfig({
  nodeId,
  overUsb,
  canQuery,
  notQueryableHint,
  blockedReason,
  query,
  runExclusive,
}: {
  nodeId: string;
  /** Reached over the cable, costing no airtime. */
  overUsb: boolean;
  /** False shows the stored sections with no query controls at all. */
  canQuery: boolean;
  /** Said when nothing is stored and this person cannot ask for it. */
  notQueryableHint: string;
  /** Why the radio cannot be used right now, or null. */
  blockedReason: string | null;
  query: (sections: RawConfigSectionId[]) => Promise<RawConfigReadResult>;
  runExclusive?: <T>(call: () => Promise<T>) => Promise<T>;
}) {
  const [sections, setSections] = useState<RawConfigSection[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<RawConfigSectionId>>(
    () =>
      new Set(
        RAW_CONFIG_SECTIONS.filter(
          (section) => overUsb || section.group === "config",
        ).map((section) => section.id),
      ),
  );
  const [reading, setReading] = useState(false);
  const [note, setNote] = useState<{ text: string; tone: "ok" | "warn" | "error" } | null>(null);
  const [copied, setCopied] = useState(false);
  // The Clipboard API exists only in a secure context, and this console is
  // routinely served over plain HTTP on a LAN. The JSON is selectable either way.
  const canCopy = typeof navigator !== "undefined" && navigator.clipboard !== undefined;

  useEffect(() => {
    let current = true;
    api
      .getRawConfig(nodeId)
      .then((response) => {
        if (current) setSections(response.sections);
      })
      .catch((cause: unknown) => {
        if (current) setNote({ text: (cause as Error).message, tone: "error" });
      });
    return () => {
      current = false;
    };
  }, [nodeId]);

  const json = useMemo(
    () =>
      JSON.stringify(
        Object.fromEntries(sections.map((entry) => [entry.section, entry.data])),
        null,
        2,
      ),
    [sections],
  );

  /**
   * "2 minutes ago: device, lora" -- sections may date from different queries.
   * Grouped by closeness rather than by the printed age, or one query would
   * read as several, its sections being seconds apart.
   */
  const readTimes = useMemo(() => {
    const groups: RawConfigSection[][] = [];
    for (const entry of sections.toSorted((a, b) => b.fetchedAt - a.fetchedAt)) {
      const group = groups.at(-1);
      const previous = group?.at(-1);
      if (group && previous && previous.fetchedAt - entry.fetchedAt <= READ_TOGETHER_SECONDS) {
        group.push(entry);
      } else {
        groups.push([entry]);
      }
    }
    return groups;
  }, [sections]);

  const chosen = [...selected];
  const reads = rawConfigReads(chosen);

  function toggle(id: RawConfigSectionId) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  async function run() {
    setReading(true);
    setNote(null);
    try {
      const call = () => query(chosen);
      const result = await (runExclusive ? runExclusive(call) : call());
      setSections(result.sections);
      setNote(describeResult(result));
    } catch (cause) {
      setNote({
        text: cause instanceof ApiError ? cause.message : "the request did not complete",
        tone: "error",
      });
      // A cancel or a dropped link keeps what arrived before it.
      api
        .getRawConfig(nodeId)
        .then((response) => setSections(response.sections))
        .catch(() => undefined);
    } finally {
      setReading(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Permission refused: the text is still selectable, which is enough.
    }
  }

  return (
    <section className="card p-6" aria-label="Raw configuration">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium tracking-wide text-neutral-500 uppercase">
          Raw configuration
        </h2>
        {canQuery && (
          <button
            type="button"
            onClick={() => void run()}
            disabled={reading || chosen.length === 0 || blockedReason !== null}
            title={
              blockedReason ??
              (overUsb
                ? "Ask the radio for these sections over USB. Nothing is transmitted."
                : "Ask the node for these sections over the mesh. One round trip per read, so this is slow.")
            }
            className={ACTION_BUTTON}
          >
            <FileJson
              aria-hidden
              className={`h-3.5 w-3.5 ${reading ? "animate-pulse" : ""}`}
            />
            {reading
              ? "Querying…"
              : overUsb
                ? "Query radio"
                : `Query node (${reads} ${reads === 1 ? "read" : "reads"})`}
          </button>
        )}
      </div>

      {canQuery && (
        <div className="mt-4 space-y-3">
          {GROUPS.map((group) => (
            <fieldset key={group} disabled={reading}>
              <legend className="text-xs tracking-wide text-neutral-500 uppercase">
                {RAW_CONFIG_GROUP_LABELS[group]}
              </legend>
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
                {RAW_CONFIG_SECTIONS.filter((section) => section.group === group).map(
                  (section) => (
                    <label
                      key={section.id}
                      className="flex items-center gap-1.5 text-sm text-neutral-300"
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(section.id)}
                        onChange={() => toggle(section.id)}
                        className="accent-amber-500"
                      />
                      {section.label}
                    </label>
                  ),
                )}
              </div>
            </fieldset>
          ))}
        </div>
      )}

      {note && (
        <p
          role="status"
          className={`mt-4 text-sm ${note.tone === "ok" ? "text-emerald-300" : note.tone === "warn" ? "text-amber-300" : "text-red-400"}`}
        >
          {note.text}
        </p>
      )}

      {sections.length === 0 ? (
        <p className="mt-4 rounded-lg border border-neutral-800 bg-neutral-950/60 p-3 text-sm text-neutral-400 [corner-shape:bevel]">
          {canQuery
            ? "Not queried yet. Choose the sections to ask for."
            : notQueryableHint}
        </p>
      ) : (
        <>
          <div className="mt-4 flex items-start justify-between gap-3">
            <ul className="min-w-0 space-y-0.5 text-xs text-neutral-500">
              {readTimes.map((entries) => (
                <li
                  key={entries[0]?.section}
                  title={absoluteTime(entries[0]?.fetchedAt ?? null)}
                >
                  Read {relativeTime(entries[0]?.fetchedAt ?? null)}:{" "}
                  {entries.map((entry) => entry.section).join(", ")}
                </li>
              ))}
            </ul>
            {canCopy && (
              <button
                type="button"
                onClick={() => void copy()}
                title="Copy the JSON"
                className="shrink-0 rounded p-0.5 text-neutral-600 transition hover:text-amber-400"
              >
                {copied ? (
                  <Check aria-hidden className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Copy aria-hidden className="h-3.5 w-3.5" />
                )}
                <span className="sr-only">{copied ? "Copied" : "Copy the JSON"}</span>
              </button>
            )}
          </div>
          <pre className="data mt-2 max-h-[32rem] overflow-auto rounded-lg border border-neutral-800 bg-neutral-950/60 p-3 text-xs text-neutral-300 [corner-shape:bevel]">
            {json}
          </pre>
          <p className="mt-2 text-xs text-neutral-500">
            Private keys, passwords, PINs and channel keys are removed on the
            server before this is stored or shown.
          </p>
        </>
      )}
    </section>
  );
}

/** Names what did not arrive: an absent section looks like nothing otherwise. */
function describeResult(result: RawConfigReadResult): {
  text: string;
  tone: "ok" | "warn";
} {
  const parts = [`Read ${result.read.length} ${result.read.length === 1 ? "section" : "sections"}.`];
  for (const { section, error } of result.failed) {
    parts.push(`${section}: ${error}.`);
  }
  if (result.skipped.length > 0) {
    parts.push(`Stopped before asking for: ${result.skipped.join(", ")}.`);
  }
  return {
    text: parts.join(" "),
    tone: result.failed.length + result.skipped.length > 0 ? "warn" : "ok",
  };
}
