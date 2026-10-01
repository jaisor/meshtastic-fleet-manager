import { useState } from "react";
import { Check, Copy, Pencil, X } from "lucide-react";
import { ApiError } from "../api";
import type {
  AdminOperation,
  RadioOccupancy,
  TelemetryPoint,
} from "../../shared/types";
import { absoluteTime, metric, relativeTime } from "./format";

/**
 * Fields shared by the node page and the Radio page: a labeled value, the
 * in-place editor for the writable names, the public key row, telemetry
 * history and the operation log.
 */

export const MAX_LONG_NAME = 39;
export const MAX_SHORT_NAME = 4;

export function Field({
  label,
  children,
  title,
  mono,
}: {
  label: string;
  children: React.ReactNode;
  title?: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs tracking-wide text-neutral-500 uppercase">
        {label}
      </dt>
      <dd
        title={title}
        className={`mt-1 text-sm text-neutral-200 ${mono ? "data" : ""}`}
      >
        {children}
      </dd>
    </div>
  );
}

/**
 * A field that flips to an input when its pencil is clicked.
 *
 * Every save here is a mesh round trip to another device, not a form post, so
 * the editor stays open until the remote confirms. On failure it keeps the
 * typed value and shows why: closing the editor and restoring the old name
 * would both lose the edit and imply the change had gone through, and with
 * remote writes "it may or may not have been applied" is a state the operator
 * has to be able to see.
 */
export function EditableField({
  label,
  value,
  mono,
  maxLength,
  canEdit,
  disabledReason,
  onSave,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
  maxLength: number;
  /** False renders a plain field with no affordance at all. */
  canEdit: boolean;
  /**
   * Non-null shows the pencil but disabled, with this as the reason — no
   * radio, or the radio busy with something else. An editor already open
   * stays open; only its save button goes dead, so a half-typed name is not
   * thrown away because a background sweep started.
   */
  disabledReason: string | null;
  onSave: (next: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{
    text: string;
    /** Sent but unverifiable: may have landed, so not styled as an error. */
    uncertain: boolean;
  } | null>(null);

  // Seeded on open rather than synced from props. The page reloads after every
  // save and the status poll runs on its own schedule, so a value arriving
  // mid-edit would otherwise overwrite what someone is in the middle of typing.
  function open() {
    setDraft(value ?? "");
    setFailure(null);
    setEditing(true);
  }

  async function commit() {
    const next = draft.trim();
    if (next === (value ?? "")) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await onSave(next);
      setEditing(false);
    } catch (cause) {
      setFailure({
        text:
          cause instanceof ApiError ? cause.message : "the change did not go through",
        // 504 is the server's "sent, unconfirmed" -- see the config route.
        uncertain: cause instanceof ApiError && cause.status === 504,
      });
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <div>
        <dt className="text-xs tracking-wide text-neutral-500 uppercase">
          {label}
        </dt>
        <dd
          className={`mt-1 flex items-center gap-1.5 text-sm text-neutral-200 ${mono ? "data" : ""}`}
        >
          <span className="truncate">{value ?? "—"}</span>
          {canEdit && (
            <button
              type="button"
              onClick={open}
              disabled={disabledReason !== null}
              title={disabledReason ?? `Edit ${label.toLowerCase()} on the node`}
              className="shrink-0 rounded p-0.5 text-neutral-600 transition hover:text-amber-400 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-neutral-600"
            >
              <Pencil aria-hidden className="h-3.5 w-3.5" />
              <span className="sr-only">Edit {label.toLowerCase()}</span>
            </button>
          )}
        </dd>
        {failure && <FailureNote failure={failure} />}
      </div>
    );
  }

  return (
    <div>
      <dt className="text-xs tracking-wide text-neutral-500 uppercase">
        {label}
      </dt>
      <dd className="mt-1 flex items-center gap-1">
        <input
          autoFocus
          value={draft}
          maxLength={maxLength}
          disabled={busy}
          aria-label={label}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter must respect the same gate as the button, or the keyboard
            // path would sail straight past it into a 409.
            if (event.key === "Enter" && disabledReason === null) void commit();
            if (event.key === "Escape") setEditing(false);
          }}
          className={`w-full min-w-0 rounded border border-neutral-700 bg-neutral-950/80 px-2 py-1 text-sm text-neutral-100 [corner-shape:bevel] focus:border-amber-500/60 focus:outline-none disabled:text-neutral-500 ${mono ? "data" : ""}`}
        />
        <button
          type="button"
          onClick={() => void commit()}
          disabled={busy || disabledReason !== null}
          title={disabledReason ?? "Send this change to the node over the mesh"}
          className="shrink-0 rounded p-1 text-emerald-400 transition hover:text-emerald-300 disabled:opacity-40"
        >
          <Check aria-hidden className="h-4 w-4" />
          <span className="sr-only">Save {label.toLowerCase()}</span>
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          disabled={busy}
          title="Discard"
          className="shrink-0 rounded p-1 text-neutral-500 transition hover:text-neutral-300 disabled:opacity-40"
        >
          <X aria-hidden className="h-4 w-4" />
          <span className="sr-only">Cancel</span>
        </button>
      </dd>
      <p className="mt-1 text-xs text-neutral-500">
        {busy
          ? "Sending over the mesh…"
          : (disabledReason ?? "Enter to send, Escape to discard.")}
      </p>
      {failure && <FailureNote failure={failure} />}
    </div>
  );
}

export function FailureNote({
  failure,
}: {
  failure: { text: string; uncertain: boolean };
}) {
  return (
    <p
      className={`mt-1 text-xs ${failure.uncertain ? "text-amber-300" : "text-red-400"}`}
    >
      {failure.text}
    </p>
  );
}

/**
 * The node's PKI public key, on a row of its own: 44 characters of base64
 * do not fit a grid cell at phone width, and wrapping one mid-key makes it
 * hard to compare by eye against what another app shows.
 *
 * On the local node it carries one line of advice, because there it is the
 * key that matters most: adding it to a remote node's admin keys is exactly
 * what lets this console administer that node.
 */
export function PublicKey({ value, isLocal }: { value: string | null; isLocal: boolean }) {
  const [copied, setCopied] = useState(false);
  // The Clipboard API exists only in a secure context, and this console is
  // routinely served over plain HTTP on a LAN. There the button is omitted
  // and the key is select-all on click instead.
  const canCopy = typeof navigator !== "undefined" && navigator.clipboard !== undefined;

  async function copy(): Promise<void> {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Permission refused: the key is still select-all, which is enough.
    }
  }

  return (
    <dl className="mt-4">
      <dt className="text-xs tracking-wide text-neutral-500 uppercase">
        Public key
      </dt>
      <dd className="mt-1 flex items-start gap-1.5 text-sm text-neutral-200">
        {value ? (
          <>
            <span className="data min-w-0 break-all select-all">{value}</span>
            {canCopy && (
              <button
                type="button"
                onClick={() => void copy()}
                title="Copy public key"
                className="shrink-0 rounded p-0.5 text-neutral-600 transition hover:text-amber-400"
              >
                {copied ? (
                  <Check aria-hidden className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Copy aria-hidden className="h-3.5 w-3.5" />
                )}
                <span className="sr-only">
                  {copied ? "Copied" : "Copy public key"}
                </span>
              </button>
            )}
          </>
        ) : (
          <span className="text-neutral-500">
            Not received yet. It arrives with the node&rsquo;s NodeInfo, and
            firmware older than 2.5 has none.
          </span>
        )}
      </dd>
      {value && isLocal && (
        <dd className="mt-1 text-xs text-neutral-500">
          Add this key to a node&rsquo;s Security &rarr; Admin keys to let this
          console administer it.
        </dd>
      )}
    </dl>
  );
}

/**
 * Recent readings as a plain table.
 *
 * A chart would be nicer and is the obvious next step, but a table is
 * honest about gaps: a node that went silent for six hours shows six
 * missing rows rather than a line drawn straight through the outage.
 */
export function TelemetryHistory({
  points,
}: {
  points: TelemetryPoint[];
}) {
  if (points.length <= 1) return null;

  return (
    <section className="card overflow-hidden" aria-label="Telemetry history">
      <h2 className="border-b border-neutral-800 px-6 py-4 text-sm font-medium tracking-wide text-neutral-500 uppercase">
        History — last {points.length} readings
      </h2>
      <div className="max-h-96 overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-neutral-950/95 text-xs tracking-wide text-neutral-500 uppercase backdrop-blur">
            <tr>
              <th scope="col" className="px-6 py-2 text-left font-medium">When</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Batt</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Volts</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Ch util</th>
              <th scope="col" className="px-6 py-2 text-right font-medium">Air TX</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800/60">
            {points.map((point) => (
              <tr key={point.recordedAt}>
                <td
                  className="px-6 py-2 text-neutral-400"
                  title={absoluteTime(point.recordedAt)}
                >
                  {relativeTime(point.recordedAt)}
                </td>
                <td className="data px-3 py-2 text-right text-neutral-300">
                  {point.batteryLevel === null ? "—" : `${point.batteryLevel}%`}
                </td>
                <td className="data px-3 py-2 text-right text-neutral-300">
                  {metric(point.voltage, "", 2)}
                </td>
                <td className="data px-3 py-2 text-right text-neutral-300">
                  {metric(point.channelUtilization, "%")}
                </td>
                <td className="data px-6 py-2 text-right text-neutral-300">
                  {metric(point.airUtilTx, "%")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Every write to a node is a row with an outcome; this lists the recent ones. */
export function OperationLog({
  operations,
  standalone = false,
}: {
  operations: AdminOperation[];
  /** The card's only content: no divider separating it from what is above. */
  standalone?: boolean;
}) {
  if (operations.length === 0) return null;
  return (
    <div className={standalone ? "" : "mt-6 border-t border-neutral-800 pt-4"}>
      <h3 className="mb-2 text-xs tracking-wide text-neutral-500 uppercase">
        Recent operations
      </h3>
      <ul className="space-y-1 text-xs">
        {operations.map((operation) => (
          <li key={operation.id} className="flex flex-wrap gap-x-3">
            <span
              className={
                operation.state === "confirmed"
                  ? "text-emerald-400"
                  : operation.state === "failed"
                    ? "text-red-400"
                    : "text-amber-400"
              }
            >
              {operation.state}
            </span>
            <span className="text-neutral-500">{operation.kind}</span>
            <span className="text-neutral-600">{operation.detail}</span>
            <span
              className="text-neutral-600"
              title={absoluteTime(operation.createdAt)}
            >
              {relativeTime(operation.createdAt)}
            </span>
            {operation.errorText && (
              <span
                className={
                  operation.state === "failed"
                    ? "text-red-500/80"
                    : operation.state === "unconfirmed"
                      ? "text-amber-400/80"
                      : "text-neutral-500"
                }
              >
                {operation.errorText}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Explains who has the radio, for the `title` of a disabled control.
 *
 * Background work is worded differently on purpose: there is no banner to
 * cancel it from, so telling someone to go and cancel it would send them
 * looking for a control that is not there. It is also brief and self-clearing,
 * which is the useful thing to say.
 */
export function describeOccupancy(busy: RadioOccupancy): string {
  const where = busy.nodeName ?? busy.nodeId;
  if (busy.background) {
    return `The radio is busy in the background: ${busy.label.toLowerCase()} on ${where}. This clears on its own in a few seconds.`;
  }
  return `The radio is busy: ${busy.label.toLowerCase()} on ${where}. Wait for it to finish, or cancel it from the banner at the top of the page.`;
}
