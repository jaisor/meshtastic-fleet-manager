import type { FastifyBaseLogger } from "fastify";
import type {
  ConfigReadOutcome,
  FleetNode,
  NodeRadioConfig,
} from "../../shared/types.js";
import type { ChannelRepository } from "../db/repositories/channels.js";
import type { NodeRepository } from "../db/repositories/nodes.js";
import { AdminError, type AdminClient } from "./admin.js";
import type { MeshListener } from "./listener.js";
import { logNode, toNodeId } from "./nodeId.js";
import { channelFromProto } from "./radioConfig.js";
import { TaskCancelledError } from "./tasks.js";

/**
 * Reading the USB-attached radio back in full: identity, settings, and all
 * eight channel slots.
 *
 * Every request is admin-to-self over USB, so nothing is transmitted and no
 * radio lock is taken -- the same reasoning as the watchdog's self-check.
 */

export interface LocalRadioReadDependencies {
  admin: AdminClient;
  nodes: NodeRepository;
  channels: ChannelRepository;
  logger: FastifyBaseLogger;
}

export interface LocalRadioReadResult {
  outcome: ConfigReadOutcome;
  channelsRead: number;
}

const CHANNEL_SLOTS = 8;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Owner and metadata come first and throw on failure: a radio that does not
 * answer those is not going to answer the rest, and twelve timeouts in a row
 * would say nothing the first one did not. Settings and channels are read
 * one at a time and a miss is reported rather than fatal.
 */
export async function readLocalRadio(
  nodeNum: number,
  deps: LocalRadioReadDependencies,
  signal?: AbortSignal,
): Promise<LocalRadioReadResult> {
  const owner = await deps.admin.getOwner(nodeNum, signal);
  deps.nodes.upsert({
    nodeNum,
    longName: owner.longName || null,
    shortName: owner.shortName || null,
    publicKey: owner.publicKey.length > 0 ? owner.publicKey : null,
    lastHeardAt: nowSeconds(),
  });

  const metadata = await deps.admin.getMetadata(nodeNum, signal);
  deps.nodes.upsert({
    nodeNum,
    firmwareVersion: metadata.firmwareVersion || null,
  });

  const { config, outcome } = await deps.admin.readRadioConfig(nodeNum, signal);
  if (outcome.lora || outcome.device || outcome.position || outcome.telemetry) {
    deps.nodes.saveConfig(nodeNum, config);
  }

  let channelsRead = 0;
  for (let index = 0; index < CHANNEL_SLOTS; index++) {
    try {
      const channel = await deps.admin.getChannel(nodeNum, index, signal);
      deps.channels.save(nodeNum, channelFromProto(channel, nowSeconds()));
      channelsRead += 1;
    } catch (cause) {
      if (cause instanceof TaskCancelledError) throw cause;
      deps.logger.warn(
        { ...logNode(nodeNum), index, err: (cause as Error).message },
        "local channel read failed",
      );
    }
  }

  return { outcome, channelsRead };
}

/**
 * `MEDIUM_FAST` -> `MediumFast`, the spelling the Meshtastic apps use, so the
 * log reads the way the radio's own screen and the phone app do.
 */
function presetName(preset: string): string {
  return preset
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

/**
 * The modem settings as one token: `MediumFast#45`.
 *
 * Slot 0 is firmware's "derive the slot from the channel name", not slot
 * zero, so it reads `#auto`. With preset mode off the preset field holds
 * whatever it last had and means nothing, so the explicit values are shown
 * instead.
 */
function describeModem(config: NodeRadioConfig | null): string {
  if (config === null) return "unknown settings (not read)";
  const modem =
    config.usesPreset === false
      ? `custom BW${config.bandwidth ?? "?"}/SF${config.spreadFactor ?? "?"}/CR4/${config.codingRate ?? "?"}`
      : config.modemPreset
        ? presetName(config.modemPreset)
        : "unknown preset";
  const slot =
    config.frequencySlot === null
      ? ""
      : config.frequencySlot === 0
        ? "#auto"
        : `#${config.frequencySlot}`;
  const region = config.region ? ` (${config.region})` : "";
  return `${modem}${slot}${region}`;
}

/**
 * One line naming the radio on the cable, for the log at connect:
 *
 *   Found USB-connected node jjab / JJA Mesh - B, id !3e2561af, on MediumFast#45 (US)
 *
 * Built from what is stored after the read rather than from the read's own
 * replies, so a part the radio did not answer falls back to what its config
 * dump said a moment earlier instead of printing blank.
 */
export function describeLocalRadio(
  nodeNum: number,
  node: FleetNode | null,
  config: NodeRadioConfig | null,
): string {
  const names =
    [node?.shortName, node?.longName].filter(Boolean).join(" / ") || "(unnamed)";
  const extras = [
    node?.hwModel,
    node?.firmwareVersion && `firmware ${node.firmwareVersion}`,
  ].filter(Boolean);
  return (
    `Found USB-connected node ${names}, id ${toNodeId(nodeNum)}, on ${describeModem(config)}` +
    (extras.length > 0 ? `, ${extras.join(", ")}` : "")
  );
}

/**
 * Probes the local radio each time it finishes handing over its config dump
 * -- on startup, on every reconnect, and after a reboot.
 *
 * The dump already carries most of this, but only as a stream the radio
 * pushed; a full read is the radio answering admin requests, which is the
 * thing every write on the Radio page depends on, so a radio that streams
 * but will not answer shows up in the log at connect rather than at the
 * first save. It also leaves the Radio page current without anyone having
 * to press Re-read.
 *
 * One read at a time, abandoned on disconnect: the admin client does not
 * notice a vanished radio by itself, and every request left would otherwise
 * sit out its full timeout.
 */
export class LocalRadioProbe {
  private inFlight: AbortController | null = null;

  constructor(
    private readonly options: LocalRadioReadDependencies & { listener: MeshListener },
  ) {}

  attach(): void {
    this.options.listener.on("configured", () => void this.run());
    this.options.listener.on("disconnected", () => this.inFlight?.abort());
  }

  private async run(): Promise<void> {
    const { listener, logger } = this.options;
    if (this.inFlight) return;

    const nodeNum = listener.getStatus().localNodeNum;
    if (nodeNum === null) {
      logger.warn("radio finished its config dump without reporting its node number");
      return;
    }

    const controller = new AbortController();
    this.inFlight = controller;
    const started = Date.now();
    try {
      const { outcome, channelsRead } = await readLocalRadio(
        nodeNum,
        this.options,
        controller.signal,
      );
      const node = this.options.nodes.get(nodeNum);
      const config = this.options.nodes.configFor(nodeNum);
      logger.info(
        {
          ...logNode(nodeNum),
          shortName: node?.shortName ?? null,
          longName: node?.longName ?? null,
          modemPreset: config?.usesPreset === false ? "custom" : (config?.modemPreset ?? null),
          frequencySlot: config?.frequencySlot ?? null,
          region: config?.region ?? null,
          outcome,
          channelsRead,
          ms: Date.now() - started,
        },
        describeLocalRadio(nodeNum, node, config),
      );
    } catch (cause) {
      if (cause instanceof TaskCancelledError) {
        logger.info(logNode(nodeNum), "local radio probe abandoned; radio disconnected");
      } else if (cause instanceof AdminError) {
        logger.warn(
          { ...logNode(nodeNum), err: cause.message },
          "local radio did not answer its startup probe",
        );
      } else {
        // Not rethrown: the crash guard would cycle the serial link, and a
        // bug in a read-back is no reason to drop a working radio.
        logger.error({ ...logNode(nodeNum), err: cause }, "local radio probe failed");
      }
    } finally {
      this.inFlight = null;
    }
  }
}
