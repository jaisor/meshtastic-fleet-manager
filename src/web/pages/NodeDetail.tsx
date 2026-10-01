import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, RefreshCw, RotateCw } from "lucide-react";
import { api, ApiError, type NodeDetailResponse } from "../api";
import type {
  AdminCapability,
  NodeConfigUpdate,
  RadioOccupancy,
} from "../../shared/types";
import { CapabilityBadge } from "../components/CapabilityBadge";
import { RadioSettings } from "../components/RadioSettings";
import {
  EditableField,
  Field,
  MAX_LONG_NAME,
  MAX_SHORT_NAME,
  OperationLog,
  PublicKey,
  describeOccupancy,
  TelemetryHistory,
} from "../components/NodeFields";
import { SignalDot } from "../components/SignalDot";
import { StatusDot } from "../components/StatusDot";
import {
  absoluteTime,
  humanizeEnum,
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
  onLocal,
}: {
  nodeId: string;
  onBack: () => void;
  /**
   * Called when the id turns out to be the local radio, which has its own
   * page. Old bookmarks and links from before it moved still land here.
   */
  onLocal: () => void;
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

  const isLocal = detail?.node.isLocal === true;
  useEffect(() => {
    if (isLocal) onLocal();
  }, [isLocal, onLocal]);
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
    try {
      await runExclusive(() => api.updateNodeConfig(nodeId, update));
    } finally {
      // After a failure too: the operation log gains a row either way, and a
      // read-back may have learned the node's real name.
      await load();
    }
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

        <PublicKey value={detail.publicKey} isLocal={node.isLocal} />
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

/** Firmware truncates over-long names silently; the server rejects instead. */

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

      <OperationLog operations={operations} />
    </section>
  );
}
