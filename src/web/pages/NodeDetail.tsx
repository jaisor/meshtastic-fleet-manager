import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { api, ApiError, type NodeDetailResponse } from "../api";
import { CapabilityBadge } from "../components/CapabilityBadge";
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
}: {
  nodeId: string;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<NodeDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  if (error) return <p className="card p-6 text-red-400">{error}</p>;
  if (!detail) return <p className="p-6 text-neutral-500">Loading node…</p>;

  const { node, telemetry, positions } = detail;
  const latest = telemetry[0];
  const position = positions[0];

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
            <StatusDot state={node.state} />
            {!node.isLocal && <CapabilityBadge capability={node.adminCapability} />}
          </div>
        </div>

        <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-4">
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
          <Field label="Hops away" mono>
            {node.hopsAway ?? "—"}
          </Field>
          <Field label="SNR" mono>
            {metric(node.snr, " dB")}
          </Field>
          <Field label="Battery" mono>
            {node.batteryLevel === null ? "—" : `${node.batteryLevel}%`}
          </Field>
        </dl>
      </header>

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
        <RemoteConfig detail={detail} onChanged={() => void load()} />
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
 * Remote configuration.
 *
 * Deliberately limited to the node's names. Every field here is
 * reversible; widening this form is a decision, not a detail. Writes are
 * never optimistic -- the row only changes after the remote confirms,
 * because a mesh ACK means "relayed", not "applied".
 */
function RemoteConfig({
  detail,
  onChanged,
}: {
  detail: NodeDetailResponse;
  onChanged: () => void;
}) {
  const { node, operations } = detail;
  const [longName, setLongName] = useState(node.longName ?? "");
  const [shortName, setShortName] = useState(node.shortName ?? "");
  const [busy, setBusy] = useState(false);
  const [probing, setProbing] = useState(false);
  const [message, setMessage] = useState<
    { kind: "ok" | "error"; text: string } | null
  >(null);

  const dirty =
    longName !== (node.longName ?? "") || shortName !== (node.shortName ?? "");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      !window.confirm(
        `Send a remote configuration change to ${node.nodeId}?\n\n` +
          `Long name:  ${longName}\nShort name: ${shortName}\n\n` +
          "This writes to the remote node over the mesh and can take a while.",
      )
    ) {
      return;
    }

    setBusy(true);
    setMessage(null);
    try {
      await api.updateNodeConfig(node.nodeId, { longName, shortName });
      setMessage({ kind: "ok", text: "Remote node confirmed the change." });
      onChanged();
    } catch (cause) {
      setMessage({
        kind: "error",
        text:
          cause instanceof ApiError ? cause.message : "the request did not complete",
      });
    } finally {
      setBusy(false);
    }
  }

  async function probe() {
    setProbing(true);
    setMessage(null);
    try {
      const result = await api.probeNode(node.nodeId);
      setMessage({ kind: "ok", text: `Probe result: ${result.capability}.` });
      onChanged();
    } catch (cause) {
      setMessage({ kind: "error", text: (cause as Error).message });
    } finally {
      setProbing(false);
    }
  }

  return (
    <section className="card p-6" aria-label="Remote configuration">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium tracking-wide text-neutral-500 uppercase">
          Remote configuration
        </h2>
        <button
          type="button"
          onClick={() => void probe()}
          disabled={probing}
          className="inline-flex items-center gap-2 rounded-lg border border-neutral-800 px-3 py-1.5 text-xs text-neutral-400 transition [corner-shape:bevel] hover:border-amber-500/40 hover:text-amber-400 disabled:opacity-40"
        >
          <RefreshCw
            aria-hidden
            className={`h-3.5 w-3.5 ${probing ? "animate-spin" : ""}`}
          />
          {probing ? "Probing…" : "Re-probe admin"}
        </button>
      </div>

      {node.adminCapability !== "capable" && (
        <p className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200/90 [corner-shape:bevel]">
          {node.adminCapability === "unauthorized"
            ? "This node refused an admin request. Add the local node's public key to its security.admin_key list, then re-probe."
            : "Admin rights for this node are not established. You can still try — the probe only tells you what happened last time."}
        </p>
      )}

      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs tracking-wide text-neutral-500 uppercase">
              Long name
            </span>
            <input
              value={longName}
              maxLength={39}
              onChange={(event) => setLongName(event.target.value)}
              className="mt-1 w-full rounded-lg border border-neutral-800 bg-neutral-950/60 px-3 py-2 text-sm text-neutral-100 [corner-shape:bevel] focus:border-amber-500/50"
            />
          </label>
          <label className="block">
            <span className="text-xs tracking-wide text-neutral-500 uppercase">
              Short name
            </span>
            <input
              value={shortName}
              maxLength={4}
              onChange={(event) => setShortName(event.target.value)}
              className="data mt-1 w-full rounded-lg border border-neutral-800 bg-neutral-950/60 px-3 py-2 text-sm text-neutral-100 [corner-shape:bevel] focus:border-amber-500/50"
            />
          </label>
        </div>

        {message && (
          <p
            role="status"
            className={`text-sm ${message.kind === "ok" ? "text-emerald-300" : "text-red-400"}`}
          >
            {message.text}
          </p>
        )}

        <button
          type="submit"
          disabled={busy || !dirty}
          className="rounded-lg border border-amber-500/40 bg-amber-500/15 px-4 py-2 text-sm font-medium text-amber-300 transition [corner-shape:bevel] hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Sending over the mesh…" : "Apply to remote node"}
        </button>
      </form>

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
