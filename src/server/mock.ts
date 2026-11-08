import { createHmac } from "node:crypto";
import type { MockConfig } from "./config.js";
import type { Db } from "./db/index.js";
import { ChannelRepository } from "./db/repositories/channels.js";
import {
  NodeRepository,
  type NodeUpsert,
  type StaleThresholds,
} from "./db/repositories/nodes.js";
import type { MeshListener, RadioLink } from "./mesh/listener.js";
import type { MqttFeed } from "./mesh/mqttFeed.js";
import { toNodeId } from "./mesh/nodeId.js";
import type { StoredChannel } from "./mesh/radioConfig.js";
import type { RadioWatchdog } from "./mesh/watchdog.js";
import type {
  AdminCapability,
  FleetNode,
  NodeRadioConfig,
  PositionPoint,
  TelemetryPoint,
} from "../shared/types.js";

/**
 * Mock mode: the console serves a mock database with the real radio
 * attached, and no real identity reaches that database or the API.
 *
 * **The seam is the mesh side's repositories.** The mesh modules speak real
 * node numbers; the routes speak stored ones. In mock mode the ingests, the
 * broker feed, the admission gate and the connect-time radio read are handed
 * `MockedNodeRepository` / `MockedChannelRepository`, which translate on the
 * way in, while the routes keep the plain repositories. The admission gate
 * needs no wrapper of its own: it is built on the mocked repository, so its
 * membership test already looks up the stored number. Translating inside
 * one shared repository would not work: a route passing a stored (mock)
 * number would be translated a second time.
 *
 * A real node listed in `mock.nodes` appears as that mock node and keeps the
 * mock node's names, key, hardware and role; only its live state (last heard,
 * signal, hops, battery, telemetry) flows through. Any other node appears
 * under a pseudonym keyed by `mock.secret`, so it is stable across restarts
 * and cannot be reversed from the database. Positions are relocated when
 * `mock.relocate` is set and dropped otherwise. The local radio's channel
 * table is never written: names and keys are exactly what the mock must not
 * show, so the mock's own rows stand.
 *
 * **Read-only toward the mesh.** Every route that would put the radio to work
 * answers 503 (see `mockRadioLink`), the capability sweep and the enricher do
 * not run, and nothing is transmitted on the mock's behalf. The status still
 * reports the radio as it is, so the header reads connected.
 *
 * **Logs are not masked.** They carry real ids, as they always have; mock mode
 * is about what the browser shows.
 */

/** The 503 every radio operation gets in mock mode. */
export const MOCK_REFUSAL =
  "Mock mode is on: the console is showing a mock fleet and does not operate the radio. " +
  "Set mock.enabled to false to use it.";

export class MockIdentities {
  private readonly pseudonyms = new Map<number, number>();
  private readonly targets: Set<number>;

  constructor(private readonly config: MockConfig) {
    this.targets = new Set(config.nodes.values());
  }

  /** The number a real node is stored under. */
  nodeNum(real: number): number {
    const mapped = this.config.nodes.get(real);
    if (mapped !== undefined) return mapped;
    let pseudonym = this.pseudonyms.get(real);
    if (pseudonym === undefined) {
      pseudonym = this.derive(real);
      this.pseudonyms.set(real, pseudonym);
    }
    return pseudonym;
  }

  /** Whether the node appears as a mock node chosen in config. */
  isMapped(real: number): boolean {
    return this.config.nodes.has(real);
  }

  /**
   * An upsert with nothing identifying left in it. A mapped node keeps the
   * identity its mock row already has; a pseudonym gets firmware's own
   * default naming, so it reads like any node nobody has named yet.
   */
  upsert(node: NodeUpsert): NodeUpsert {
    const nodeNum = this.nodeNum(node.nodeNum);
    if (this.isMapped(node.nodeNum)) {
      return {
        ...node,
        nodeNum,
        shortName: undefined,
        longName: undefined,
        publicKey: undefined,
        hwModel: undefined,
        role: undefined,
      };
    }
    const short = (nodeNum & 0xffff).toString(16).padStart(4, "0");
    return {
      ...node,
      nodeNum,
      shortName: node.shortName ? short : node.shortName,
      longName: node.longName ? `Meshtastic ${short}` : node.longName,
      publicKey: node.publicKey ? this.digest("key", node.nodeNum) : node.publicKey,
    };
  }

  /**
   * The point moved by `mock.relocate`, or null to drop it. Altitude is
   * dropped too: with the horizontal position moved, the real ground height
   * is the one coordinate left that still describes the real site.
   */
  position(point: PositionPoint): PositionPoint | null {
    const r = this.config.relocate;
    if (!r || point.latitude === null || point.longitude === null) return null;
    const rad = Math.PI / 180;
    const dy = point.latitude - r.from.lat;
    const dx = (point.longitude - r.from.lon) * Math.cos(r.from.lat * rad);
    const a = r.rotate * rad;
    const y = r.scale * (dx * Math.sin(a) + dy * Math.cos(a));
    const x = r.scale * (dx * Math.cos(a) - dy * Math.sin(a));
    return {
      ...point,
      latitude: r.to.lat + y,
      longitude: r.to.lon + x / Math.cos(r.to.lat * rad),
      altitude: null,
    };
  }

  /**
   * Status text with every `!hex` id translated and each `[real, shown]`
   * string swapped. For texts written by the mesh side, where any id is real.
   */
  text(value: string | null, swaps: Array<[string, string]> = []): string | null {
    if (value === null) return null;
    let out = value.replace(/!([0-9a-f]{8})\b/gi, (_, hex: string) =>
      toNodeId(this.nodeNum(Number.parseInt(hex, 16) >>> 0)),
    );
    for (const [real, shown] of swaps) {
      if (real) out = out.split(real).join(shown);
    }
    return out;
  }

  private derive(real: number): number {
    for (let attempt = 0; ; attempt++) {
      const n = this.digest(`node${attempt}`, real).readUInt32BE(0);
      // Low numbers and broadcast are not node numbers; a mapped target is taken.
      if (n > 3 && n !== 0xffffffff && !this.targets.has(n)) return n;
    }
  }

  private digest(label: string, real: number): Buffer {
    return createHmac("sha256", this.config.secret)
      .update(`${label}:${real >>> 0}`)
      .digest();
  }
}

/**
 * The node repository the mesh side writes through in mock mode. Every
 * method that takes a node number gets a real one and translates it; the
 * listing methods return stored rows and are inherited unchanged.
 */
export class MockedNodeRepository extends NodeRepository {
  constructor(
    db: Db,
    thresholds: StaleThresholds,
    localNodeNum: () => number | null,
    private readonly ids: MockIdentities,
  ) {
    super(db, thresholds, localNodeNum);
  }

  override upsert(node: NodeUpsert): void {
    super.upsert(this.ids.upsert(node));
  }

  override recordLocal(nodeNum: number, at: number): number | null {
    return super.recordLocal(this.ids.nodeNum(nodeNum), at);
  }

  override exists(nodeNum: number): boolean {
    return super.exists(this.ids.nodeNum(nodeNum));
  }

  override get(nodeNum: number): FleetNode | null {
    return super.get(this.ids.nodeNum(nodeNum));
  }

  override publicKeyFor(nodeNum: number): string | null {
    return super.publicKeyFor(this.ids.nodeNum(nodeNum));
  }

  override setAdminCapability(nodeNum: number, capability: AdminCapability): void {
    super.setAdminCapability(this.ids.nodeNum(nodeNum), capability);
  }

  override recordTelemetry(nodeNum: number, point: TelemetryPoint): void {
    super.recordTelemetry(this.ids.nodeNum(nodeNum), point);
  }

  override telemetryFor(nodeNum: number, limit: number): TelemetryPoint[] {
    return super.telemetryFor(this.ids.nodeNum(nodeNum), limit);
  }

  override recordPosition(nodeNum: number, point: PositionPoint): void {
    const moved = this.ids.position(point);
    if (moved) super.recordPosition(this.ids.nodeNum(nodeNum), moved);
  }

  override positionsFor(nodeNum: number, limit: number): PositionPoint[] {
    return super.positionsFor(this.ids.nodeNum(nodeNum), limit);
  }

  override saveConfig(nodeNum: number, config: NodeRadioConfig): void {
    super.saveConfig(this.ids.nodeNum(nodeNum), config);
  }

  override configFor(nodeNum: number): NodeRadioConfig | null {
    return super.configFor(this.ids.nodeNum(nodeNum));
  }
}

/** Never writes: the mock's channel rows stand. See the module comment. */
export class MockedChannelRepository extends ChannelRepository {
  override save(_nodeNum: number, _channel: StoredChannel): void {}
}

/**
 * What the routes see of the radio. The status is the real one with the local
 * radio's number translated and the port path replaced, so the header reads
 * as it would; every operation is refused, by the same `unavailableReason`
 * every radio route already checks.
 */
export function mockRadioLink(
  listener: MeshListener,
  ids: MockIdentities,
  config: MockConfig,
): RadioLink {
  return {
    getStatus: () => {
      const status = listener.getStatus();
      return {
        ...status,
        portPath: config.portPath,
        localNodeNum:
          status.localNodeNum === null ? null : ids.nodeNum(status.localNodeNum),
        lastErrorText: ids.text(status.lastErrorText, [
          [status.portPath, config.portPath],
        ]),
      };
    },
    getIdentifiedDevice: () => listener.getIdentifiedDevice(),
    unavailableReason: () => listener.unavailableReason() ?? MOCK_REFUSAL,
  };
}

export function mockWatchdog(
  watchdog: RadioWatchdog,
  ids: MockIdentities,
): Pick<RadioWatchdog, "getStatus"> {
  return {
    getStatus: () => {
      const status = watchdog.getStatus();
      return { ...status, lastFailureText: ids.text(status.lastFailureText) };
    },
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** The broker's address and topics name the real deployment, so both are replaced. */
export function mockMqtt(
  feed: MqttFeed,
  ids: MockIdentities,
  config: MockConfig,
): Pick<MqttFeed, "getStatus"> {
  return {
    getStatus: () => {
      const status = feed.getStatus();
      const swaps: Array<[string, string]> = [
        [status.url, config.mqttUrl],
        // Connection errors name the bare host ("getaddrinfo ENOTFOUND ...").
        [hostOf(status.url), hostOf(config.mqttUrl)],
        ...status.topics.map((t): [string, string] => [t, config.mqttTopics[0] ?? ""]),
      ];
      return {
        ...status,
        url: config.mqttUrl,
        topics: config.mqttTopics,
        lastErrorText: ids.text(status.lastErrorText, swaps),
        lastIgnoredReason: ids.text(status.lastIgnoredReason, swaps),
      };
    },
  };
}
