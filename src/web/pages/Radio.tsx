import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, Pencil, Plus, RotateCw } from "lucide-react";
import { api, ApiError } from "../api";
import {
  MODEM_PRESETS,
  type ChannelRole,
  type ChannelUpdate,
  type LocalRadioDetail,
  type ModemPreset,
  type NodeConfigUpdate,
  type PskKind,
  type RadioChannel,
  type RadioOccupancy,
  type RadioStatus,
} from "../../shared/types";
import {
  EditableField,
  Field,
  MAX_LONG_NAME,
  MAX_SHORT_NAME,
  OperationLog,
  PublicKey,
  TelemetryHistory,
  describeOccupancy,
} from "../components/NodeFields";
import { BatteryLevel } from "../components/BatteryLevel";
import { RadioSettings } from "../components/RadioSettings";
import { StatusDot } from "../components/StatusDot";
import { absoluteTime, humanizeEnum, relativeTime } from "../components/format";

/**
 * The USB-attached radio: what it is, how it is set up, and -- for admins --
 * the controls to change that.
 *
 * Separate from the fleet because it is not a fleet member. It is the
 * instrument everything else is observed through, reached over a cable
 * rather than the air, so it can be read freely and written without the risk
 * that makes remote preset changes off-limits: a bad setting here moves the
 * console onto the wrong mesh, but the radio stays one USB cable away.
 *
 * Re-reading is open to every role, since it never transmits. Writing is
 * admin-only and the server enforces that; the page just does not offer it.
 */

const NO_RADIO_HINT = "Unavailable while the local radio is disconnected.";
const UNIDENTIFIED_HINT =
  "The radio is connected but has not identified itself yet.";

const BUTTON =
  "inline-flex items-center gap-2 rounded-lg border border-neutral-800 px-3 py-1.5 text-xs text-neutral-400 transition [corner-shape:bevel] hover:border-amber-500/40 hover:text-amber-400 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-neutral-800 disabled:hover:text-neutral-400";
const PRIMARY_BUTTON =
  "inline-flex items-center gap-2 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-medium text-neutral-950 transition [corner-shape:bevel] hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40";
const INPUT =
  "w-full rounded-lg border border-neutral-800 bg-neutral-950 px-2.5 py-1.5 text-sm text-neutral-200 [corner-shape:bevel] focus:border-amber-500/60 focus:outline-none disabled:opacity-50";

export function Radio({
  onBack,
  onOpenNode,
  radio,
  canAdminister,
  radioBusy,
}: {
  onBack: () => void;
  onOpenNode: (nodeId: string) => void;
  /** Null until the first status poll answers; treated as not connected. */
  radio: RadioStatus | null;
  /** Admins may change the radio; everyone may read it back. */
  canAdminister: boolean;
  radioBusy: RadioOccupancy | null;
}) {
  const radioConnected = radio?.connected ?? false;
  /**
   * The node number the connected radio reported, or null until it does.
   * Connected is not the same thing: the port can be open with nothing
   * answering, and only this number says which node is on the cable.
   */
  const radioNodeNum = radioConnected ? (radio?.localNodeNum ?? null) : null;
  const [detail, setDetail] = useState<LocalRadioDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [readNote, setReadNote] = useState<string | null>(null);
  /** A write of ours is in flight; closes the gap before the next poll. */
  const [ownRequest, setOwnRequest] = useState(false);

  const load = useCallback(async () => {
    try {
      setDetail(await api.getRadio());
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, []);

  // Reloaded when the radio identifies itself, so the page swaps from the
  // remembered record to the radio actually attached without a refresh.
  useEffect(() => {
    void load();
  }, [load, radioNodeNum]);

  /** Runs one write, holding the local busy flag and reloading after. */
  const runWrite = useCallback(
    async function <T>(call: () => Promise<T>): Promise<T> {
      setOwnRequest(true);
      try {
        return await call();
      } finally {
        setOwnRequest(false);
        // After a failure too: the operation log gains a row either way.
        await load();
      }
    },
    [load],
  );

  // One reason string for every write control, as on the node page, so a
  // new control cannot be left enabled by omission. "No radio" outranks
  // "busy" because it is the more fundamental problem.
  const blockedReason = !radioConnected
    ? NO_RADIO_HINT
    : radioNodeNum === null
      ? UNIDENTIFIED_HINT
      : ownRequest
      ? "Another change to the radio is still in progress."
      : radioBusy
        ? describeOccupancy(radioBusy)
        : null;

  async function reRead() {
    setReading(true);
    setReadNote(null);
    try {
      const { outcome, channelsRead } = await api.readRadio();
      const missing = [
        !outcome.lora && "LoRa",
        !outcome.device && "device",
        !outcome.position && "position",
        !outcome.telemetry && "telemetry",
        channelsRead < 8 && `${8 - channelsRead} channel slot${channelsRead === 7 ? "" : "s"}`,
      ].filter(Boolean);
      setReadNote(
        missing.length === 0
          ? "Everything re-read from the radio."
          : `Re-read, but the radio did not answer for: ${missing.join(", ")}.`,
      );
      await load();
    } catch (cause) {
      setReadNote(
        cause instanceof ApiError ? cause.message : "the request did not complete",
      );
    } finally {
      setReading(false);
    }
  }

  if (error) return <p className="card p-6 text-red-400">{error}</p>;
  if (!detail) return <p className="p-6 text-neutral-500">Loading radio…</p>;

  // The server sends only the radio identified on this connection. Checked
  // here too, because the status poll and this page's own fetch can disagree
  // for a moment around a reconnect, and that moment is exactly when the
  // wrong radio would be shown.
  const node =
    detail.node !== null && detail.node.nodeNum === radioNodeNum ? detail.node : null;

  return (
    <div className="space-y-6">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-2 text-sm text-neutral-500 transition hover:text-amber-400"
      >
        <ArrowLeft aria-hidden className="h-4 w-4" />
        All nodes
      </button>

      <header className="card p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs tracking-wide text-amber-500/80 uppercase">
              Local radio
            </p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight text-white">
              {node
                ? (node.longName ?? node.nodeId)
                : !radio?.enabled && radio !== null
                  ? "Radio support off"
                  : radioConnected
                    ? "Radio not responding"
                    : "No radio connected"}
            </h1>
            {node && (
              <p className="data mt-1 text-sm text-neutral-500">
                {node.nodeId}
                {node.shortName && ` · ${node.shortName}`}
              </p>
            )}
          </div>
          <div className="flex flex-col items-end gap-2">
            <button
              type="button"
              onClick={() => void reRead()}
              disabled={reading || !radioConnected || radioNodeNum === null}
              title={
                !radioConnected
                  ? NO_RADIO_HINT
                  : radioNodeNum === null
                    ? UNIDENTIFIED_HINT
                    : "Read identity, settings and channels back from the radio over USB. Nothing is transmitted."
              }
              className={BUTTON}
            >
              <RotateCw
                aria-hidden
                className={`h-3.5 w-3.5 ${reading ? "animate-spin" : ""}`}
              />
              {reading ? "Reading…" : "Re-read from radio"}
            </button>
            {node && <StatusDot state={node.state} />}
          </div>
        </div>

        {readNote && (
          <p role="status" className="mt-4 text-sm text-amber-200/90">
            {readNote}
          </p>
        )}

        {node === null ? (
          <NoRadio
            radio={radio}
            lastIdentified={detail.lastIdentified}
            onOpenNode={onOpenNode}
          />
        ) : (
          <>
            <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-4">
              <EditableField
                label="Long name"
                value={node.longName}
                maxLength={MAX_LONG_NAME}
                canEdit={canAdminister}
                disabledReason={blockedReason}
                onSave={(longName) => saveNames({ longName })}
              />
              <EditableField
                label="Short name"
                value={node.shortName}
                mono
                maxLength={MAX_SHORT_NAME}
                canEdit={canAdminister}
                disabledReason={blockedReason}
                onSave={(shortName) => saveNames({ shortName })}
              />
              <Field label="Last heard" title={absoluteTime(node.lastHeardAt)}>
                {relativeTime(node.lastHeardAt)}
              </Field>
              <Field label="Hardware">{humanizeEnum(node.hwModel) ?? "—"}</Field>
              <Field label="Role">{humanizeEnum(node.role) ?? "—"}</Field>
              <Field label="Firmware" mono>
                {node.firmwareVersion ?? "—"}
              </Field>
              <Field label="Battery" mono>
                {node.batteryLevel === null ? "—" : <BatteryLevel level={node.batteryLevel} />}
              </Field>
            </dl>
            <PublicKey value={detail.publicKey} isLocal />
          </>
        )}
      </header>

      {node && (
        <>
          <RadioSettings
            config={detail.config}
            nodeId={node.nodeId}
            isLocal
            canOperate={false}
            adminCapability="capable"
            blockedReason={blockedReason}
            runExclusive={runWrite}
            onRead={() => void load()}
          />

          {canAdminister && (
            <LoRaEditor
              preset={detail.config?.usesPreset === false ? null : (detail.config?.modemPreset ?? null)}
              slot={detail.config?.frequencySlot ?? null}
              blockedReason={blockedReason}
              runWrite={runWrite}
            />
          )}

          <Channels
            channels={detail.channels}
            canAdminister={canAdminister}
            blockedReason={blockedReason}
            runWrite={runWrite}
          />

          <TelemetryHistory points={detail.telemetry} />

          {detail.operations.length > 0 && (
            <section className="card p-6" aria-label="Recent operations">
              <OperationLog operations={detail.operations} standalone />
            </section>
          )}
        </>
      )}
    </div>
  );

  async function saveNames(update: NodeConfigUpdate): Promise<void> {
    await runWrite(() => api.updateRadioOwner(update));
  }
}

/**
 * Preset and frequency slot, the two settings that decide which mesh the
 * radio is on at all.
 *
 * Confirmed in two steps because the consequences are not visible from the
 * form: the radio restarts, and if the rest of the mesh is not on the same
 * preset and slot, it stops hearing every node in the fleet.
 */

/**
 * What the page says while no radio has identified itself on this
 * connection. It names the state of the link and stops there: no stored
 * name, settings or channels, because any of those would describe a radio
 * that may not be the one attached -- the failure this replaced presented an
 * NRF52 unplugged ten days earlier as the radio on the cable.
 *
 * The last radio that did identify itself is offered as history, dated and
 * linked to its ordinary node page, never as the current one.
 */
function NoRadio({
  radio,
  lastIdentified,
  onOpenNode,
}: {
  radio: RadioStatus | null;
  lastIdentified: LocalRadioDetail["lastIdentified"];
  onOpenNode: (nodeId: string) => void;
}) {
  const port = radio?.portPath ? (
    <span className="data">{radio.portPath}</span>
  ) : (
    "the configured port"
  );

  let explanation: ReactNode;
  if (radio === null) {
    explanation = "Checking the radio’s status…";
  } else if (!radio.enabled) {
    explanation = (
      <>
        <span className="data">serial.enabled</span> is false in config.yaml, so
        no radio is used.
      </>
    );
  } else if (radio.connected) {
    explanation = (
      <>
        {port} was opened {relativeTime(radio.lastConnectedAt)}, but the radio on
        it has not identified itself. Until it does, nothing is known
        about it &mdash; not its name, its settings, or that it is a working
        Meshtastic node at all &mdash; and nothing it hears reaches this console.
        {radio.watchdog?.lastFailureText && (
          <> Watchdog: {radio.watchdog.lastFailureText}.</>
        )}
      </>
    );
  } else {
    explanation = (
      <>
        Nothing could be opened on {port}; retrying automatically.
        {radio.lastErrorText && <> Last error: {radio.lastErrorText}</>}
      </>
    );
  }

  return (
    <div className="mt-4 space-y-3 text-sm">
      <p className="text-neutral-400">{explanation}</p>
      {lastIdentified && (
        <p className="text-xs text-neutral-500">
          The last radio to identify itself here was{" "}
          <button
            type="button"
            onClick={() => onOpenNode(lastIdentified.node.nodeId)}
            className="text-neutral-300 underline decoration-neutral-700 underline-offset-2 transition hover:text-amber-400"
          >
            {[lastIdentified.node.shortName, lastIdentified.node.longName]
              .filter(Boolean)
              .join(" / ") || lastIdentified.node.nodeId}{" "}
            <span className="data">({lastIdentified.node.nodeId})</span>
          </button>
          , <span title={absoluteTime(lastIdentified.at)}>{relativeTime(lastIdentified.at)}</span>.
          That is history: it is listed in the fleet like any other node.
        </p>
      )}
    </div>
  );
}

function LoRaEditor({
  preset,
  slot,
  blockedReason,
  runWrite,
}: {
  /** Null when the radio runs custom modem settings or none were read. */
  preset: string | null;
  slot: number | null;
  blockedReason: string | null;
  runWrite: <T>(call: () => Promise<T>) => Promise<T>;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [draftPreset, setDraftPreset] = useState<string>("");
  const [draftSlot, setDraftSlot] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; tone: "ok" | "warn" | "error" } | null>(null);

  function open() {
    setDraftPreset(preset ?? "");
    setDraftSlot(slot === null ? "" : String(slot));
    setConfirming(false);
    setNote(null);
    setEditing(true);
  }

  const slotNumber = draftSlot.trim() === "" ? null : Number(draftSlot);
  const slotValid =
    slotNumber === null || (Number.isInteger(slotNumber) && slotNumber >= 0 && slotNumber <= 1000);
  const update = {
    ...(draftPreset !== "" && draftPreset !== preset
      ? { modemPreset: draftPreset as ModemPreset }
      : {}),
    ...(slotNumber !== null && slotNumber !== slot ? { frequencySlot: slotNumber } : {}),
  };
  const changed = Object.keys(update).length > 0;

  async function apply() {
    setBusy(true);
    setNote(null);
    try {
      await runWrite(() => api.updateRadioLoRa(update));
      setEditing(false);
      setNote({
        tone: "ok",
        text: "Applied. The radio restarts to put it into effect; the console is read-only until it reconnects, usually within half a minute.",
      });
    } catch (cause) {
      setConfirming(false);
      setNote({
        tone: cause instanceof ApiError && cause.status === 504 ? "warn" : "error",
        text: cause instanceof ApiError ? cause.message : "the change did not go through",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card p-6" aria-label="Change LoRa settings">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium tracking-wide text-neutral-500 uppercase">
          Change LoRa settings
        </h2>
        {!editing && (
          <button
            type="button"
            onClick={open}
            disabled={blockedReason !== null}
            title={blockedReason ?? "Change the modem preset or frequency slot"}
            className={BUTTON}
          >
            <Pencil aria-hidden className="h-3.5 w-3.5" />
            Change
          </button>
        )}
      </div>

      {note && (
        <p
          role="status"
          className={`mt-3 text-sm ${note.tone === "ok" ? "text-emerald-300" : note.tone === "warn" ? "text-amber-300" : "text-red-400"}`}
        >
          {note.text}
        </p>
      )}

      {editing && (
        <div className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-xs tracking-wide text-neutral-500 uppercase">
              Modem preset
              <select
                value={draftPreset}
                disabled={busy || confirming}
                onChange={(event) => setDraftPreset(event.target.value)}
                className={`${INPUT} mt-1 normal-case`}
              >
                {draftPreset === "" && <option value="">Custom (unchanged)</option>}
                {MODEM_PRESETS.map((name) => (
                  <option key={name} value={name}>
                    {humanizeEnum(name)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs tracking-wide text-neutral-500 uppercase">
              Frequency slot
              <input
                type="number"
                min={0}
                max={1000}
                value={draftSlot}
                disabled={busy || confirming}
                onChange={(event) => setDraftSlot(event.target.value)}
                className={`${INPUT} data mt-1`}
              />
              <span className="mt-1 block text-xs normal-case tracking-normal text-neutral-600">
                0 derives the slot from the primary channel&rsquo;s name.
              </span>
            </label>
          </div>

          {confirming ? (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200/90 [corner-shape:bevel]">
              <p>
                The radio restarts to apply this. If the rest of the mesh is not
                on the same preset and frequency slot, it will stop hearing
                every node in the fleet until it is changed back.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void apply()}
                  disabled={busy || blockedReason !== null}
                  title={blockedReason ?? undefined}
                  className={PRIMARY_BUTTON}
                >
                  {busy ? "Applying…" : "Apply and restart radio"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  disabled={busy}
                  className={BUTTON}
                >
                  Back
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setConfirming(true)}
                disabled={!changed || !slotValid}
                title={
                  !slotValid
                    ? "The slot must be a whole number from 0 to 1000"
                    : changed
                      ? undefined
                      : "Nothing has changed"
                }
                className={PRIMARY_BUTTON}
              >
                Review change
              </button>
              <button type="button" onClick={() => setEditing(false)} className={BUTTON}>
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

const KEY_LABELS: Record<PskKind, string> = {
  none: "No encryption",
  default: "Default key (public)",
  simple: "Well-known key (public)",
  aes128: "AES-128 (private)",
  aes256: "AES-256 (private)",
  invalid: "Invalid key",
};

/**
 * The channel table, with an editor per slot for admins.
 *
 * Disabled slots are summarized rather than listed: eight rows of which six
 * say "disabled" bury the two that matter. An admin adds a channel by
 * opening the editor on the first free slot.
 */
function Channels({
  channels,
  canAdminister,
  blockedReason,
  runWrite,
}: {
  channels: RadioChannel[];
  canAdminister: boolean;
  blockedReason: string | null;
  runWrite: <T>(call: () => Promise<T>) => Promise<T>;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const active = channels.filter((channel) => channel.role !== "DISABLED");
  const free = channels.find((channel) => channel.role === "DISABLED");
  const editingChannel = channels.find((channel) => channel.index === editing);

  return (
    <section className="card p-6" aria-label="Channels">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium tracking-wide text-neutral-500 uppercase">
          Channels
          {channels[0] && (
            <span className="ml-2 normal-case" title={absoluteTime(channels[0].fetchedAt)}>
              (read {relativeTime(channels[0].fetchedAt)})
            </span>
          )}
        </h2>
        {canAdminister && free && editing === null && (
          <button
            type="button"
            onClick={() => setEditing(free.index)}
            disabled={blockedReason !== null}
            title={blockedReason ?? `Set up channel ${free.index}`}
            className={BUTTON}
          >
            <Plus aria-hidden className="h-3.5 w-3.5" />
            Add channel
          </button>
        )}
      </div>

      {channels.length === 0 ? (
        <p className="text-sm text-neutral-400">
          No channels recorded yet. The radio reports them when it connects, or
          use Re-read from radio above.
        </p>
      ) : (
        <ul className="divide-y divide-neutral-800/60">
          {active.map((channel) => (
            <li key={channel.index} className="py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-neutral-200">
                    <span className="data mr-2 text-neutral-500">{channel.index}</span>
                    {channel.name || (
                      <span className="text-neutral-500">
                        {channel.role === "PRIMARY" ? "Unnamed (named after the preset)" : "Unnamed"}
                      </span>
                    )}
                    {channel.role === "PRIMARY" && (
                      <span className="ml-2 text-xs text-amber-500/80">Primary</span>
                    )}
                  </p>
                  <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-500">
                    <span>{KEY_LABELS[channel.pskKind]}</span>
                    <span>
                      Position:{" "}
                      {channel.positionPrecision === null
                        ? "—"
                        : channel.positionPrecision === 0
                          ? "not shared"
                          : channel.positionPrecision >= 32
                            ? "exact"
                            : `${channel.positionPrecision} bits`}
                    </span>
                    <span>
                      MQTT: {channel.uplinkEnabled ? "up" : "—"} / {channel.downlinkEnabled ? "down" : "—"}
                    </span>
                  </p>
                </div>
                {canAdminister && editing === null && (
                  <button
                    type="button"
                    onClick={() => setEditing(channel.index)}
                    disabled={blockedReason !== null}
                    title={blockedReason ?? `Edit channel ${channel.index}`}
                    className={BUTTON}
                  >
                    <Pencil aria-hidden className="h-3.5 w-3.5" />
                    Edit
                  </button>
                )}
              </div>
              {editing === channel.index && (
                <ChannelEditor
                  channel={channel}
                  blockedReason={blockedReason}
                  runWrite={runWrite}
                  onDone={() => setEditing(null)}
                />
              )}
            </li>
          ))}
          {editingChannel?.role === "DISABLED" && (
            <li className="py-3">
              <p className="text-sm text-neutral-300">
                New channel in slot <span className="data">{editingChannel.index}</span>
              </p>
              <ChannelEditor
                channel={editingChannel}
                blockedReason={blockedReason}
                runWrite={runWrite}
                onDone={() => setEditing(null)}
              />
            </li>
          )}
        </ul>
      )}

      {channels.length > 0 && (
        <p className="mt-3 text-xs text-neutral-600">
          {channels.length - active.length} of {channels.length} slots unused.
        </p>
      )}
    </section>
  );
}

/** A random AES-256 key. `getRandomValues` works on plain HTTP; `subtle` would not. */
function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes));
}

function ChannelEditor({
  channel,
  blockedReason,
  runWrite,
  onDone,
}: {
  channel: RadioChannel;
  blockedReason: string | null;
  runWrite: <T>(call: () => Promise<T>) => Promise<T>;
  onDone: () => void;
}) {
  const isPrimary = channel.index === 0;
  const isNew = channel.role === "DISABLED";
  const [draft, setDraft] = useState<ChannelUpdate>(() => ({
    role: isNew ? "SECONDARY" : channel.role,
    name: channel.name,
    // A new channel gets a private key by default: the alternative is the
    // public default key, which is a channel anyone can read.
    psk: isNew ? randomKey() : (channel.psk ?? ""),
    uplinkEnabled: channel.uplinkEnabled,
    downlinkEnabled: channel.downlinkEnabled,
    positionPrecision: channel.positionPrecision ?? 0,
  }));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ text: string; uncertain: boolean } | null>(null);

  const set = <K extends keyof ChannelUpdate>(key: K, value: ChannelUpdate[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  async function save() {
    setBusy(true);
    setFailure(null);
    try {
      await runWrite(() => api.updateRadioChannel(channel.index, draft));
      onDone();
    } catch (cause) {
      setConfirming(false);
      setFailure({
        text: cause instanceof ApiError ? cause.message : "the change did not go through",
        uncertain: cause instanceof ApiError && cause.status === 504,
      });
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || confirming;

  return (
    <div className="mt-3 space-y-4 rounded-lg border border-neutral-800 bg-neutral-950/60 p-4 [corner-shape:bevel]">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-xs tracking-wide text-neutral-500 uppercase">
          Name
          <input
            value={draft.name}
            maxLength={11}
            disabled={disabled}
            onChange={(event) => set("name", event.target.value)}
            placeholder={isPrimary ? "Empty: named after the preset" : ""}
            className={`${INPUT} mt-1 normal-case`}
          />
        </label>
        <label className="block text-xs tracking-wide text-neutral-500 uppercase">
          Role
          <select
            value={draft.role}
            disabled={disabled || isPrimary}
            title={isPrimary ? "Channel 0 is always the primary channel" : undefined}
            onChange={(event) => set("role", event.target.value as ChannelRole)}
            className={`${INPUT} mt-1 normal-case`}
          >
            {isPrimary ? (
              <option value="PRIMARY">Primary</option>
            ) : (
              <>
                <option value="SECONDARY">Secondary</option>
                <option value="DISABLED">Disabled</option>
              </>
            )}
          </select>
        </label>
      </div>

      <div>
        <label className="block text-xs tracking-wide text-neutral-500 uppercase">
          Key (base64)
          <input
            value={draft.psk}
            disabled={disabled}
            onChange={(event) => set("psk", event.target.value.trim())}
            spellCheck={false}
            autoComplete="off"
            className={`${INPUT} data mt-1 normal-case`}
          />
        </label>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" disabled={disabled} onClick={() => set("psk", randomKey())} className={BUTTON}>
            New AES-256 key
          </button>
          <button type="button" disabled={disabled} onClick={() => set("psk", "AQ==")} className={BUTTON}>
            Default (public) key
          </button>
          <button type="button" disabled={disabled} onClick={() => set("psk", "")} className={BUTTON}>
            No encryption
          </button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <label className="block text-xs tracking-wide text-neutral-500 uppercase">
          Position precision
          <input
            type="number"
            min={0}
            max={32}
            value={draft.positionPrecision}
            disabled={disabled}
            onChange={(event) => set("positionPrecision", Number(event.target.value))}
            className={`${INPUT} data mt-1`}
          />
          <span className="mt-1 block text-xs normal-case tracking-normal text-neutral-600">
            0 shares no position, 32 is exact.
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm text-neutral-300 sm:mt-6">
          <input
            type="checkbox"
            checked={draft.uplinkEnabled}
            disabled={disabled}
            onChange={(event) => set("uplinkEnabled", event.target.checked)}
            className="accent-amber-500"
          />
          MQTT uplink
        </label>
        <label className="flex items-center gap-2 text-sm text-neutral-300 sm:mt-6">
          <input
            type="checkbox"
            checked={draft.downlinkEnabled}
            disabled={disabled}
            onChange={(event) => set("downlinkEnabled", event.target.checked)}
            className="accent-amber-500"
          />
          MQTT downlink
        </label>
      </div>

      {failure && (
        <p className={`text-sm ${failure.uncertain ? "text-amber-300" : "text-red-400"}`}>
          {failure.text}
        </p>
      )}

      {confirming ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200/90 [corner-shape:bevel]">
          <p>
            {isPrimary
              ? "This is the primary channel. Nodes that do not share its name and key will stop hearing this radio, and with the frequency slot on 0, renaming it also moves the radio to a different frequency."
              : draft.role === "DISABLED"
                ? `Channel ${channel.index} will be switched off; messages on it will no longer reach this radio.`
                : `Channel ${channel.index} will be replaced with these settings. Nodes using the old name or key on it will no longer reach this radio there.`}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || blockedReason !== null}
              title={blockedReason ?? undefined}
              className={PRIMARY_BUTTON}
            >
              {busy ? "Saving…" : "Save channel"}
            </button>
            <button type="button" onClick={() => setConfirming(false)} disabled={busy} className={BUTTON}>
              Back
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setConfirming(true)} className={PRIMARY_BUTTON}>
            Review change
          </button>
          <button type="button" onClick={onDone} className={BUTTON}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
