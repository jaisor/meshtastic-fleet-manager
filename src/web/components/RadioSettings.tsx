import { useState } from "react";
import { Settings2 } from "lucide-react";
import { api, ApiError } from "../api";
import type { AdminCapability, NodeRadioConfig } from "../../shared/types";
import { Field } from "./NodeFields";
import { absoluteTime, flag, humanizeEnum, interval, relativeTime } from "./format";

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
export function RadioSettings({
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
            <Field label="Region">
              {/* Region codes are acronyms ("US", "EU_868"); humanizing
                  them yields "Us". */}
              {config.region?.replace(/_/g, " ") ?? "—"}
            </Field>
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
