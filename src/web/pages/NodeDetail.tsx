import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  Check,
  Pencil,
  RefreshCw,
  RotateCw,
  Settings2,
  X,
} from "lucide-react";
import { api, ApiError, type NodeDetailResponse } from "../api";
import type {
  AdminCapability,
  NodeConfigUpdate,
  NodeRadioConfig,
  RadioOccupancy,
} from "../../shared/types";
import { CapabilityBadge } from "../components/CapabilityBadge";
import { SignalDot } from "../components/SignalDot";
import { StatusDot } from "../components/StatusDot";
import {
  absoluteTime,
  flag,
  humanizeEnum,
  interval,
  metric,
  relativeTime,
  uptime,
} from "../components/format";

export function NodeDetail({
  nodeId,
  onBack,
  radioConnected,
  canOperate,
  radioBusy,
}: {
  nodeId: string;
  onBack: () => void;
  /** False disables everything that would have to go out over the mesh. */
  radioConnected: boolean;
  /**
   * Whether this role may use the radio at all (manager or admin).
   *
   * Separate from `radioConnected` because the two need different words. A
   * viewer is shown no editing affordances whatsoever -- a disabled pencil
   * would advertise a capability they do not have and invite them to go
   * looking for why. An operator whose radio is unplugged sees the pencil,
   * disabled, saying it is the radio.
   */
  canOperate: boolean;
  /**
   * What currently holds the radio, or null. Includes background sweeps, which
   * never reach the task banner but occupy the radio just the same.
   */
  radioBusy: RadioOccupancy | null;
}) {
  const [detail, setDetail] = useState<NodeDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  /**
   * A request of our own is in flight.
   *
   * Tracked separately from `radioBusy` because the server's view arrives by
   * poll: between clicking one button and the next poll there is a window in
   * which every other control still looks available, and clicking a second
   * one just earns a 409. This closes that window locally; the poll remains
   * the authority for work started anywhere else.
   */
  const [ownRequest, setOwnRequest] = useState(false);

  const load = useCallback(async () => {
    try {
      setDetail(await api.getNode(nodeId));
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, [nodeId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Runs one radio call, holding the local busy flag for its duration.
   *
   * Every radio action on this page goes through here, so adding one cannot
   * accidentally leave the rest of the controls enabled underneath it.
   */
  const runExclusive = useCallback(async function <T>(
    call: () => Promise<T>,
  ): Promise<T> {
    setOwnRequest(true);
    try {
      return await call();
    } finally {
      setOwnRequest(false);
    }
  }, []);

  async function refresh() {
    setRefreshing(true);
    setRefreshNote(null);
    try {
      const { received } = await runExclusive(() => api.refreshNode(nodeId));
      const got = [
        received.identity && "identity",
        received.metrics && "metrics",
        received.position && "position",
      ].filter(Boolean);
      // Say what came back rather than a bare "done": a node that answered
      // nothing looks identical to a successful refresh otherwise.
      setRefreshNote(
        got.length === 0
          ? "The node did not answer. It may be asleep or out of range."
          : `Updated: ${got.join(", ")}.`,
      );
      await load();
    } catch (cause) {
      setRefreshNote(
        cause instanceof ApiError ? cause.message : "the request did not complete",
      );
    } finally {
      setRefreshing(false);
    }
  }

  /**
   * Sends one renamed field to the node and reloads.
   *
   * Throws on failure so the editor that called it can stay open with the
   * typed value intact -- dropping back to the old name would lose the edit
   * and imply it had been applied.
   */
  async function saveNames(update: NodeConfigUpdate): Promise<void> {
    await runExclusive(() => api.updateNodeConfig(nodeId, update));
    await load();
  }

  if (error) return <p className="card p-6 text-red-400">{error}</p>;
  if (!detail) return <p className="p-6 text-neutral-500">Loading node…</p>;

  const { node, telemetry, positions } = detail;
  const latest = telemetry[0];
  const position = positions[0];
  /**
   * Renaming needs a *confirmed* admin verdict, not just the right role.
   *
   * A rename is an admin write, so without established rights it can only
   * fail — and it fails slowly, after a mesh round trip and a timeout, having
   * logged an operation that makes it look like something was attempted on the
   * node. Offering the pencil there invites a minute of waiting for a refusal.
   *
   * `capable` specifically, not "anything but unauthorized": `unknown` means
   * nobody has asked yet, and treating it as permission would reintroduce the
   * same slow failure. The route out is the probe, which the advice block in
   * Remote administration points at.
   */
  const canEditNames =
    canOperate && !node.isLocal && node.adminCapability === "capable";

  /**
   * Why every radio control on this page is disabled, or null if none is.
   *
   * One value for one radio: whichever reason applies, it applies to all of
   * them, so there is no way to disable the refresh button and forget the
   * rename. "No radio" wins over "busy" because it is the more fundamental
   * problem and the one with a different remedy.
   */
  const blockedReason = !radioConnected
    ? NO_RADIO_HINT
    : ownRequest
      ? "Waiting for the operation you just started. The radio handles one at a time."
      : radioBusy
        ? describeOccupancy(radioBusy)
        : null;

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
            <h1 className="text-2xl font-bold tracking-tight text-white">
              {node.longName ?? node.nodeId}
            </h1>
            <p className="data mt-1 text-sm text-neutral-500">
              {node.nodeId}
              {node.shortName && ` · ${node.shortName}`}
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            {!node.isLocal && (
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={refreshing || blockedReason !== null}
                title={
                  blockedReason ??
                  "Ask the node for its current identity, metrics and position"
                }
                className="mb-1 inline-flex items-center gap-2 rounded-lg border border-neutral-800 px-3 py-1.5 text-xs text-neutral-400 transition [corner-shape:bevel] hover:border-amber-500/40 hover:text-amber-400 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-neutral-800 disabled:hover:text-neutral-400"
              >
                <RotateCw
                  aria-hidden
                  className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
                />
                {refreshing ? "Asking the node…" : "Refresh from node"}
              </button>
            )}
            <StatusDot state={node.state} />
            {!node.isLocal && <SignalDot signal={node.signal} />}
            {!node.isLocal && <CapabilityBadge capability={node.adminCapability} />}
          </div>
        </div>

        {refreshNote && (
          <p role="status" className="mt-4 text-sm text-amber-200/90">
            {refreshNote}
          </p>
        )}

        <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-4">
          {/* The names are the only remotely writable settings, so they are
              the only fields carrying a pencil. The local node is excluded:
              it is configured over USB and the server refuses a remote write
              to it, so offering the control would be a dead end. */}
          <EditableField
            label="Long name"
            value={node.longName}
            maxLength={MAX_LONG_NAME}
            canEdit={canEditNames}
            disabledReason={blockedReason}
            onSave={(longName) => saveNames({ longName })}
          />
          <EditableField
            label="Short name"
            value={node.shortName}
            mono
            maxLength={MAX_SHORT_NAME}
            canEdit={canEditNames}
            disabledReason={blockedReason}
            onSave={(shortName) => saveNames({ shortName })}
          />
          <Field label="Last heard" title={absoluteTime(node.lastHeardAt)}>
            {relativeTime(node.lastHeardAt)}
          </Field>
          <Field label="First seen" title={absoluteTime(node.firstSeenAt)}>
            {relativeTime(node.firstSeenAt)}
          </Field>
          <Field label="Hardware">{humanizeEnum(node.hwModel) ?? "—"}</Field>
          <Field label="Role">{humanizeEnum(node.role) ?? "—"}</Field>
          <Field label="Firmware" mono>
            {node.firmwareVersion ?? "—"}
          </Field>
          <Field
            label="Hops away"
            mono
            title="Relays between the local radio and this node"
          >
            {node.hopsAway === null
              ? "—"
              : node.hopsAway === 0
                ? "0 (direct)"
                : node.hopsAway}
          </Field>
          <Field label="SNR" mono title="Last direct packet">
            {metric(node.snr, " dB")}
          </Field>
          <Field label="RSSI" mono title="Last direct packet">
            {metric(node.rssi, " dBm", 0)}
          </Field>
          <Field label="Battery" mono>
            {node.batteryLevel === null ? "—" : `${node.batteryLevel}%`}
          </Field>
        </dl>
      </header>

      <RadioSettings
        config={detail.config}
        nodeId={nodeId}
        isLocal={node.isLocal}
        canOperate={canOperate}
        adminCapability={node.adminCapability}
        blockedReason={blockedReason}
        runExclusive={runExclusive}
        onRead={() => void load()}
      />

      {latest && (
        <section className="card p-6" aria-label="Latest telemetry">
          <h2 className="mb-4 text-sm font-medium tracking-wide text-neutral-500 uppercase">
            Latest telemetry
            <span
              className="ml-2 normal-case"
              title={absoluteTime(latest.recordedAt)}
            >
              ({relativeTime(latest.recordedAt)})
            </span>
          </h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-4">
            <Field label="Voltage" mono>
              {metric(latest.voltage, " V", 2)}
            </Field>
            <Field label="Channel util" mono>
              {metric(latest.channelUtilization, "%")}
            </Field>
            <Field label="Air time TX" mono>
              {metric(latest.airUtilTx, "%")}
            </Field>
            <Field label="Uptime" mono>
              {uptime(latest.uptimeSeconds)}
            </Field>
            <Field label="Temperature" mono>
              {metric(latest.temperature, " °C")}
            </Field>
            <Field label="Humidity" mono>
              {metric(latest.relativeHumidity, "%")}
            </Field>
            <Field label="Pressure" mono>
              {metric(latest.barometricPressure, " hPa")}
            </Field>
          </dl>
        </section>
      )}

      {position && (
        <section className="card p-6" aria-label="Position">
          <h2 className="mb-4 text-sm font-medium tracking-wide text-neutral-500 uppercase">
            Position
            <span
              className="ml-2 normal-case"
              title={absoluteTime(position.recordedAt)}
            >
              ({relativeTime(position.recordedAt)})
            </span>
          </h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
            <Field label="Latitude" mono>
              {position.latitude?.toFixed(5) ?? "—"}
            </Field>
            <Field label="Longitude" mono>
              {position.longitude?.toFixed(5) ?? "—"}
            </Field>
            <Field label="Altitude" mono>
              {position.altitude === null ? "—" : `${position.altitude} m`}
            </Field>
          </dl>
        </section>
      )}

      <TelemetryHistory points={telemetry} />

      {!node.isLocal && (
        <RemoteConfig
          detail={detail}
          radioConnected={radioConnected}
          canOperate={canOperate}
          blockedReason={blockedReason}
          runExclusive={runExclusive}
          onChanged={() => void load()}
        />
      )}
    </div>
  );
}

function Field({
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

/** Firmware truncates over-long names silently; the server rejects instead. */
const MAX_LONG_NAME = 39;
const MAX_SHORT_NAME = 4;

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
function EditableField({
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
  const [failure, setFailure] = useState<string | null>(null);

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
      setFailure(
        cause instanceof ApiError ? cause.message : "the change did not go through",
      );
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
        {failure && <p className="mt-1 text-xs text-red-400">{failure}</p>}
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
      {failure && <p className="mt-1 text-xs text-red-400">{failure}</p>}
    </div>
  );
}

/**
 * The node's radio and module settings.
 *
 * None of this arrives on its own -- nothing on the mesh broadcasts a LoRa
 * preset or a telemetry interval. The local radio's values come free with its
 * config dump over USB; a remote node's take four admin round trips, so they
 * are read on request and then cached until someone asks again.
 *
 * Read-only on purpose. Changing a remote node's preset, frequency slot or
 * region is the one class of write that cannot be undone from here: the node
 * applies it, leaves the channel this console can reach, and is then beyond
 * recall without physical access. The intervals are harmless by comparison and
 * are the sensible place to widen writes first.
 */
function RadioSettings({
  config,
  nodeId,
  isLocal,
  canOperate,
  adminCapability,
  blockedReason,
  runExclusive,
  onRead,
}: {
  config: NodeRadioConfig | null;
  nodeId: string;
  isLocal: boolean;
  canOperate: boolean;
  /**
   * Reading settings is itself an admin read, so it needs the same confirmed
   * verdict a rename does — and rather more urgently: this is four round
   * trips, so on a node that will not answer it burns four timeouts before
   * reporting nothing at all.
   */
  adminCapability: AdminCapability;
  /** Why the radio cannot be used right now, or null. */
  blockedReason: string | null;
  runExclusive: <T>(call: () => Promise<T>) => Promise<T>;
  onRead: () => void;
}) {
  const [reading, setReading] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function read() {
    setReading(true);
    setNote(null);
    try {
      const { outcome } = await runExclusive(() => api.readNodeConfig(nodeId));
      const missing = [
        !outcome.lora && "LoRa",
        !outcome.device && "device",
        !outcome.position && "position",
        !outcome.telemetry && "telemetry",
      ].filter(Boolean);
      // Naming what did *not* answer matters more than a count: the blanks
      // left behind are otherwise indistinguishable from settings that are
      // genuinely unset on the node.
      setNote(
        missing.length === 0
          ? "All settings read."
          : `Read, but the node did not answer: ${missing.join(", ")}.`,
      );
      onRead();
    } catch (cause) {
      setNote(
        cause instanceof ApiError ? cause.message : "the request did not complete",
      );
    } finally {
      setReading(false);
    }
  }

  const canRead = canOperate && !isLocal && adminCapability === "capable";

  return (
    <section className="card p-6" aria-label="Radio settings">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium tracking-wide text-neutral-500 uppercase">
          Radio settings
          {config && (
            <span
              className="ml-2 normal-case"
              title={absoluteTime(config.fetchedAt)}
            >
              (read {relativeTime(config.fetchedAt)})
            </span>
          )}
        </h2>
        {canRead && (
          <button
            type="button"
            onClick={() => void read()}
            disabled={reading || blockedReason !== null}
            title={
              blockedReason ??
              "Ask the node for its LoRa and telemetry settings — four mesh round trips, so this is slow"
            }
            className="inline-flex items-center gap-2 rounded-lg border border-neutral-800 px-3 py-1.5 text-xs text-neutral-400 transition [corner-shape:bevel] hover:border-amber-500/40 hover:text-amber-400 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-neutral-800 disabled:hover:text-neutral-400"
          >
            <Settings2
              aria-hidden
              className={`h-3.5 w-3.5 ${reading ? "animate-spin" : ""}`}
            />
            {reading ? "Reading…" : config ? "Re-read settings" : "Read settings"}
          </button>
        )}
      </div>

      {note && (
        <p role="status" className="mb-4 text-sm text-amber-200/90">
          {note}
        </p>
      )}

      {config === null ? (
        <p className="rounded-lg border border-neutral-800 bg-neutral-950/60 p-3 text-sm text-neutral-400 [corner-shape:bevel]">
          {isLocal
            ? "The local radio reports its settings when it connects. Nothing has arrived yet — check the radio status above."
            : canRead
              ? "Not read yet. These settings are never broadcast, so they have to be requested from the node."
              : !canOperate
                ? "Not read yet. Reading a node's settings needs the manager or admin role."
                : "Not read yet. These settings are never broadcast, so they have to be requested from the node — which needs confirmed admin rights. Probe it first, under Remote administration below."}
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-4">
            <Field label="Region">{humanizeEnum(config.region) ?? "—"}</Field>
            <Field
              label="Modem preset"
              title={
                config.usesPreset === false
                  ? "Ignored: this node runs explicit bandwidth, spread factor and coding rate instead of a preset"
                  : undefined
              }
            >
              {config.usesPreset === false
                ? "Custom"
                : (humanizeEnum(config.modemPreset) ?? "—")}
            </Field>
            <Field
              label="Frequency slot"
              mono
              title="Nodes must agree on the slot and the preset to hear each other at all"
            >
              {config.frequencySlot === null
                ? "—"
                : config.frequencySlot === 0
                  ? "Auto"
                  : config.frequencySlot}
            </Field>
            <Field label="Hop limit" mono>
              {config.hopLimit ?? "—"}
            </Field>
            {config.usesPreset === false && (
              <>
                <Field label="Bandwidth" mono>
                  {config.bandwidth === null ? "—" : `${config.bandwidth} kHz`}
                </Field>
                <Field label="Spread factor" mono>
                  {config.spreadFactor ?? "—"}
                </Field>
                <Field label="Coding rate" mono>
                  {config.codingRate ?? "—"}
                </Field>
              </>
            )}
            <Field label="TX power" mono>
              {config.txPower === null
                ? "—"
                : config.txPower === 0
                  ? "Default"
                  : `${config.txPower} dBm`}
            </Field>
            <Field label="Transmit">{flag(config.txEnabled)}</Field>
          </dl>

          <h3 className="mt-6 mb-3 border-t border-neutral-800 pt-4 text-xs tracking-wide text-neutral-500 uppercase">
            Broadcast and sensor intervals
          </h3>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-4">
            <Field label="Node info" mono>
              {interval(config.nodeInfoInterval)}
            </Field>
            <Field label="Position" mono>
              {interval(config.positionInterval)}
            </Field>
            <Field label="GPS update" mono>
              {interval(config.gpsUpdateInterval)}
            </Field>
            {/* No enable flag alongside this one: firmware's is
                `deviceTelemetryEnabled`, which the protobuf copy inside
                `@meshtastic/core` predates, so it never survives decoding. */}
            <Field label="Device metrics" mono>
              {interval(config.deviceMetricsInterval)}
            </Field>
            <IntervalField
              label="Environment"
              seconds={config.environmentInterval}
              enabled={config.environmentEnabled}
            />
            <IntervalField
              label="Air quality"
              seconds={config.airQualityInterval}
              enabled={config.airQualityEnabled}
            />
            <IntervalField
              label="Power"
              seconds={config.powerInterval}
              enabled={config.powerEnabled}
            />
            <IntervalField
              label="Health"
              seconds={config.healthInterval}
              enabled={config.healthEnabled}
            />
          </dl>
        </>
      )}
    </section>
  );
}

/**
 * A sensor interval alongside its enable flag.
 *
 * An interval on a disabled sensor is configured but silent, and showing the
 * number alone would have someone waiting for readings that will never come.
 */
function IntervalField({
  label,
  seconds,
  enabled,
}: {
  label: string;
  seconds: number | null;
  enabled: boolean | null;
}) {
  return (
    <div>
      <dt className="text-xs tracking-wide text-neutral-500 uppercase">
        {label}
      </dt>
      <dd className="data mt-1 text-sm text-neutral-200">
        {enabled === false ? (
          <span className="text-neutral-500">Disabled</span>
        ) : (
          interval(seconds)
        )}
      </dd>
    </div>
  );
}

/**
 * Recent readings as a plain table.
 *
 * A chart would be nicer and is the obvious next step, but a table is
 * honest about gaps: a node that went silent for six hours shows six
 * missing rows rather than a line drawn straight through the outage.
 */
function TelemetryHistory({
  points,
}: {
  points: NodeDetailResponse["telemetry"];
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

/**
 * Explains who has the radio, for the `title` of a disabled control.
 *
 * Background work is worded differently on purpose: there is no banner to
 * cancel it from, so telling someone to go and cancel it would send them
 * looking for a control that is not there. It is also brief and self-clearing,
 * which is the useful thing to say.
 */
function describeOccupancy(busy: RadioOccupancy): string {
  const where = busy.nodeName ?? busy.nodeId;
  if (busy.background) {
    return `The radio is busy in the background: ${busy.label.toLowerCase()} on ${where}. This clears on its own in a few seconds.`;
  }
  return `The radio is busy: ${busy.label.toLowerCase()} on ${where}. Wait for it to finish, or cancel it from the banner at the top of the page.`;
}

/**
 * What to do about each admin verdict, now that editing depends on one.
 *
 * Three states share "you cannot rename this node" but need different advice,
 * and `unknown` is the one that must not read as a refusal: nobody has asked
 * yet, so the answer may well be yes. Saying "not established" rather than
 * "not permitted" is the whole distinction the probe exists to make.
 */
const CAPABILITY_ADVICE: Record<AdminCapability, string> = {
  capable: "",
  unauthorized:
    "This node refused an admin request, so its settings cannot be changed from here. Add the local node's public key to its security.admin_key list, then re-probe.",
  unreachable:
    "This node did not answer an admin request, so its settings cannot be changed yet. It may be asleep or out of range — re-probe once it has been heard from again.",
  unknown:
    "Admin rights for this node have not been established yet, so its settings are not editable. Probe it to find out whether it accepts administration from the local node.",
};

/** Reason shown on every control that would need the mesh. */
const NO_RADIO_HINT =
  "Unavailable while the local radio is disconnected — these actions go out over the mesh.";

/**
 * Admin access and the log of what has been sent to this node.
 *
 * The writable settings themselves are edited inline in the header, next to
 * the values they change -- a separate form restating them meant two places
 * showing the same name and a save button a long way from the field. What is
 * left here is the part that is genuinely about the node as a *target*:
 * whether we may administer it, and what we have asked it to do.
 *
 * Writes remain non-optimistic. The row changes only after the remote
 * confirms, because a mesh ACK means "relayed", not "applied".
 */
function RemoteConfig({
  detail,
  radioConnected,
  canOperate,
  blockedReason,
  runExclusive,
  onChanged,
}: {
  detail: NodeDetailResponse;
  radioConnected: boolean;
  canOperate: boolean;
  /** Why the radio cannot be used right now, or null. */
  blockedReason: string | null;
  runExclusive: <T>(call: () => Promise<T>) => Promise<T>;
  onChanged: () => void;
}) {
  const { node, operations } = detail;
  const [probing, setProbing] = useState(false);
  const [message, setMessage] = useState<
    { kind: "ok" | "error"; text: string } | null
  >(null);

  async function probe() {
    setProbing(true);
    setMessage(null);
    try {
      const result = await runExclusive(() => api.probeNode(node.nodeId));
      setMessage({ kind: "ok", text: `Probe result: ${result.capability}.` });
      onChanged();
    } catch (cause) {
      setMessage({ kind: "error", text: (cause as Error).message });
    } finally {
      setProbing(false);
    }
  }

  return (
    <section className="card p-6" aria-label="Remote administration">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium tracking-wide text-neutral-500 uppercase">
          Remote administration
        </h2>
        {canOperate && (
          <button
            type="button"
            onClick={() => void probe()}
            disabled={probing || blockedReason !== null}
            title={blockedReason ?? undefined}
            className="inline-flex items-center gap-2 rounded-lg border border-neutral-800 px-3 py-1.5 text-xs text-neutral-400 transition [corner-shape:bevel] hover:border-amber-500/40 hover:text-amber-400 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-neutral-800 disabled:hover:text-neutral-400"
          >
            <RefreshCw
              aria-hidden
              className={`h-3.5 w-3.5 ${probing ? "animate-spin" : ""}`}
            />
            {probing ? "Probing…" : "Re-probe admin"}
          </button>
        )}
      </div>

      {/* With no radio there is nothing to say about admin rights that the
          degraded banner has not already said, and explaining how to unlock
          editing next to controls that are all disabled anyway would be
          noise. */}
      {!radioConnected ? (
        <p className="mb-4 rounded-lg border border-neutral-800 bg-neutral-950/60 p-3 text-sm text-neutral-400 [corner-shape:bevel]">
          {NO_RADIO_HINT} The last known admin status for this node is shown
          above and was accurate as of its last probe.
        </p>
      ) : (
        node.adminCapability !== "capable" && (
          <p className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200/90 [corner-shape:bevel]">
            {CAPABILITY_ADVICE[node.adminCapability]}
          </p>
        )
      )}

      {canOperate && (
        <p className="text-sm text-neutral-400">
          {node.adminCapability === "capable"
            ? "The writable settings — long and short name — are edited in place at the top of this page."
            : "The writable settings become editable at the top of this page once a probe confirms this node accepts administration from the local node."}
        </p>
      )}

      {message && (
        <p
          role="status"
          className={`mt-3 text-sm ${message.kind === "ok" ? "text-emerald-300" : "text-red-400"}`}
        >
          {message.text}
        </p>
      )}

      {operations.length > 0 && (
        <div className="mt-6 border-t border-neutral-800 pt-4">
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
                  <span className="text-red-500/80">{operation.errorText}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
