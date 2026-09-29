import type { Types } from "@meshtastic/core";
import { Protobuf } from "@meshtastic/core";
import type { FastifyBaseLogger } from "fastify";
import type { NodeRepository } from "../db/repositories/nodes.js";
import type { DiscoveryRules } from "../config.js";
import { admits, describeRules, isRestricted } from "./discovery.js";
import { logNode } from "./nodeId.js";
import type { MeshListener } from "./listener.js";

/**
 * Turns listener events into database writes. This is the only writer to
 * the mesh-derived tables, which is what lets the repositories stay free of
 * protobuf types and the routes stay read-only.
 */

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Protobuf timestamps are seconds since the epoch, but nodes with no time
 * source send 0. Treat anything implausible as "now" -- a slightly wrong
 * timestamp is better than a row in 1970 that sorts to the bottom forever.
 */
function resolveTime(candidate: number | undefined): number {
  const now = nowSeconds();
  if (!candidate || candidate < 946_684_800 || candidate > now + 86_400) {
    return now;
  }
  return candidate;
}

/** Numeric protobuf enum -> its name, for display. */
function enumName(
  table: Record<number, string> | object,
  value: number | undefined,
): string | null {
  if (value === undefined) return null;
  const name = (table as Record<number, string>)[value];
  return typeof name === "string" ? name : null;
}

/** Protobuf uses 0 as "unset" for several optional numeric fields. */
function zeroAsNull(value: number | undefined): number | null {
  return value === undefined || value === 0 ? null : value;
}

/**
 * The packet's channel index, or undefined when the field is not one.
 *
 * `MeshPacket.channel` is only a channel index on a packet that was
 * actually decoded with one of our channel keys. The protobuf names two
 * exceptions outright, and both were admitting strangers:
 *
 * - **Still encrypted.** "Very briefly, while sending and receiving deep
 *   inside the device Router code, this field instead contains the
 *   'channel hash' [...] only used while the payload_variant is an
 *   'encrypted'." A hash is a different number space from an index, so
 *   comparing it to a configured channel is a category error -- and the
 *   value reads as 0, i.e. "primary", for every foreign-channel packet the
 *   radio forwards but cannot open. `@meshtastic/core` dispatches
 *   `onMeshPacket` *before* it looks at `payloadVariant`, so these reach us.
 * - **PKI-encrypted.** A PKC direct message never used a channel at all;
 *   it is addressed to our public key. Any node holding that key can reach
 *   us whatever channels it has, and the field stays 0.
 *
 * Returning undefined hands both to the "missing evidence does not match"
 * rule in `discovery.ts`, which rejects rather than admits.
 */
function channelEvidence(
  packet: Protobuf.Mesh.MeshPacket,
): number | undefined {
  if (packet.payloadVariant.case !== "decoded") return undefined;
  if (packet.pkiEncrypted) return undefined;
  return packet.channel;
}

/**
 * How many hops the packet travelled, or null when it cannot say.
 *
 * The sender stamps `hopStart` with its configured limit and each relay
 * decrements `hopLimit`. A `hopStart` of 0 is *unknown*, not direct --
 * firmware before 2.3.0 never populated it, as the protobuf comment
 * warns -- so neither the distance nor the signal may be attributed.
 */
function hopsTravelled(packet: Protobuf.Mesh.MeshPacket): number | null {
  if (packet.hopStart === 0) return null;
  const hops = packet.hopStart - packet.hopLimit;
  return hops >= 0 ? hops : null;
}

export function attachIngest(
  listener: MeshListener,
  nodes: NodeRepository,
  discovery: DiscoveryRules,
  logger: FastifyBaseLogger,
  onAdmitted?: (nodeNum: number) => void,
): void {
  let localNodeNum: number | null = null;

  /**
   * What the raw MeshPacket said, for the typed handlers that follow it.
   *
   * `PacketMetadata` carries neither `viaMqtt` nor `pkiEncrypted`, and its
   * `channel` is `meshPacket.channel` copied verbatim -- so the typed
   * events cannot tell on their own whether that number is a channel index
   * or one of the two things `channelEvidence` rules out. The raw packet
   * can, so it is recorded here and read back.
   *
   * A single slot rather than a map keyed by node: `handleMeshPacket`
   * dispatches `onMeshPacket` and then calls `handleDecodedPacket` on the
   * same synchronous call stack, and nothing here awaits, so the stash is
   * always this packet's by the time a typed handler runs. Verified
   * against the library -- the dispatch is its first statement. The `from`
   * check below is the belt to that braces: a typed event reaching us by
   * some other route gets no raw facts rather than another packet's.
   */
  let rawPacket: {
    from: number;
    channel: number | undefined;
    viaMqtt: boolean;
  } | null = null;

  if (isRestricted(discovery)) {
    logger.info(
      { discovery: describeRules(discovery) },
      "discovery is narrowed; nodes outside the criteria will be ignored",
    );
  }

  /**
   * The admission gate. Every handler below funnels through this before
   * touching the database, so a node outside the discovery criteria leaves
   * no trace at all -- not even a bare row with a last-heard time.
   *
   * Already-known nodes always pass: the criteria decide who joins the
   * fleet, not what we are allowed to learn about members.
   */
  function admitted(nodeNum: number, evidence: Parameters<typeof admits>[1]): boolean {
    // Our own radio is not a discovery candidate; it is the instrument.
    if (nodeNum === localNodeNum) return true;
    if (nodes.exists(nodeNum)) return true;

    if (!admits(discovery, evidence)) {
      logger.debug(
        { ...logNode(nodeNum), evidence },
        "packet ignored; node does not meet discovery criteria",
      );
      return false;
    }

    logger.info(
      { ...logNode(nodeNum), evidence },
      "node admitted to the fleet by discovery criteria",
    );
    // Fires only on first admission, so enrichment is asked for once per
    // node rather than on every packet it ever sends.
    onAdmitted?.(nodeNum);
    return true;
  }

  /** Evidence for a typed packet, taken from the raw one it was decoded from. */
  function evidenceFor(packet: { from: number }) {
    const raw = rawPacket?.from === packet.from ? rawPacket : null;
    return { channel: raw?.channel, viaMqtt: raw?.viaMqtt };
  }

  listener.on("myNodeInfo", (info: Protobuf.Mesh.MyNodeInfo) => {
    localNodeNum = info.myNodeNum;
    nodes.upsert({
      nodeNum: info.myNodeNum,
      isLocal: true,
      lastHeardAt: nowSeconds(),
    });
    logger.info(logNode(info.myNodeNum), "local node identified");
  });

  /**
   * The NodeDB dump on connect and every subsequent NodeInfo both land
   * here. This is the primary discovery path: anything the local radio has
   * heard on the primary channel becomes a fleet member with no enrollment.
   */
  listener.on("nodeInfo", (info: Protobuf.Mesh.NodeInfo) => {
    // Carries no message, so a policy requiring one rejects the whole
    // NodeDB dump -- which is the point: the radio already knows everyone.
    // `NodeInfo.channel` is documented as "only populated if it is not the
    // default channel", so a zero means primary OR unknown and is no
    // evidence at all. Reporting it as primary made a `channel: primary`
    // policy admit the radio's entire node database.
    if (
      !admitted(info.num, {
        channel: info.channel === 0 ? undefined : info.channel,
        viaMqtt: info.viaMqtt,
      })
    ) {
      return;
    }
    nodes.upsert({
      nodeNum: info.num,
      shortName: info.user?.shortName || null,
      longName: info.user?.longName || null,
      hwModel: enumName(Protobuf.Mesh.HardwareModel, info.user?.hwModel),
      role: enumName(Protobuf.Config.Config_DeviceConfig_Role, info.user?.role),
      publicKey: info.user?.publicKey?.length ? info.user.publicKey : null,
      isLocal: localNodeNum !== null && info.num === localNodeNum,
      lastHeardAt: resolveTime(info.lastHeard),
      snr: zeroAsNull(info.snr),
      hopsAway: info.hopsAway ?? null,
      batteryLevel: zeroAsNull(info.deviceMetrics?.batteryLevel),
      voltage: zeroAsNull(info.deviceMetrics?.voltage),
    });
  });

  listener.on("user", (packet: Types.PacketMetadata<Protobuf.Mesh.User>) => {
    if (!admitted(packet.from, evidenceFor(packet))) return;
    nodes.upsert({
      nodeNum: packet.from,
      shortName: packet.data.shortName || null,
      longName: packet.data.longName || null,
      hwModel: enumName(Protobuf.Mesh.HardwareModel, packet.data.hwModel),
      role: enumName(Protobuf.Config.Config_DeviceConfig_Role, packet.data.role),
      publicKey: packet.data.publicKey?.length ? packet.data.publicKey : null,
      lastHeardAt: Math.floor(packet.rxTime.getTime() / 1000),
    });
  });

  listener.on(
    "telemetry",
    (packet: Types.PacketMetadata<Protobuf.Telemetry.Telemetry>) => {
      if (!admitted(packet.from, evidenceFor(packet))) return;
      const recordedAt = resolveTime(packet.data.time);
      const variant = packet.data.variant;

      // Ensure the node exists before the foreign key on telemetry bites.
      nodes.upsert({ nodeNum: packet.from, lastHeardAt: recordedAt });

      if (variant?.case === "deviceMetrics") {
        const m = variant.value;
        nodes.upsert({
          nodeNum: packet.from,
          batteryLevel: zeroAsNull(m.batteryLevel),
          voltage: zeroAsNull(m.voltage),
          lastHeardAt: recordedAt,
        });
        nodes.recordTelemetry(packet.from, {
          recordedAt,
          batteryLevel: zeroAsNull(m.batteryLevel),
          voltage: zeroAsNull(m.voltage),
          channelUtilization: zeroAsNull(m.channelUtilization),
          airUtilTx: zeroAsNull(m.airUtilTx),
          uptimeSeconds: zeroAsNull(m.uptimeSeconds),
          temperature: null,
          relativeHumidity: null,
          barometricPressure: null,
        });
        return;
      }

      if (variant?.case === "environmentMetrics") {
        const m = variant.value;
        nodes.recordTelemetry(packet.from, {
          recordedAt,
          batteryLevel: null,
          voltage: zeroAsNull(m.voltage),
          channelUtilization: null,
          airUtilTx: null,
          uptimeSeconds: null,
          temperature: zeroAsNull(m.temperature),
          relativeHumidity: zeroAsNull(m.relativeHumidity),
          barometricPressure: zeroAsNull(m.barometricPressure),
        });
      }
      // Other telemetry variants (power, air quality, health) are recorded
      // as a check-in only until the UI has somewhere to show them.
    },
  );

  listener.on(
    "position",
    (packet: Types.PacketMetadata<Protobuf.Mesh.Position>) => {
      if (!admitted(packet.from, evidenceFor(packet))) return;
      const recordedAt = resolveTime(packet.data.time);
      nodes.upsert({ nodeNum: packet.from, lastHeardAt: recordedAt });

      // Meshtastic sends coordinates as degrees * 1e7. A node with no fix
      // sends 0/0, which is a real place in the Atlantic -- drop it rather
      // than plot it.
      const latitude = packet.data.latitudeI
        ? packet.data.latitudeI / 1e7
        : null;
      const longitude = packet.data.longitudeI
        ? packet.data.longitudeI / 1e7
        : null;
      if (latitude === null && longitude === null) return;

      nodes.recordPosition(packet.from, {
        recordedAt,
        latitude,
        longitude,
        altitude: zeroAsNull(packet.data.altitude),
      });
    },
  );

  /**
   * A text message on the primary channel is not interesting content for a
   * fleet manager, but it is proof of life -- record the check-in and
   * discover the sender if we have not seen it before.
   */
  listener.on("message", (packet: Types.PacketMetadata<string>) => {
    // The one packet type that can satisfy a text or substring rule.
    if (
      !admitted(packet.from, { ...evidenceFor(packet), message: packet.data })
    ) {
      return;
    }
    nodes.upsert({
      nodeNum: packet.from,
      lastHeardAt: Math.floor(packet.rxTime.getTime() / 1000),
    });
  });

  /**
   * Link quality, taken from the radio's own measurement of each packet.
   *
   * `rxSnr` and `rxRssi` describe the **last hop**, not the whole path. On a
   * relayed packet they measure our link to the relay, so attributing them
   * to the originating node would report a healthy link for a node we
   * cannot actually hear. Only direct packets are recorded.
   *
   * This fires for *every* packet, decodable or not, which makes it the
   * widest gate in the file and the one where trusting `packet.channel`
   * did real damage -- see `channelEvidence`.
   */
  listener.on("meshPacket", (packet: Protobuf.Mesh.MeshPacket) => {
    // Stashed before anything can return early, so the typed handlers
    // dispatched further down `handleMeshPacket` see this packet's facts
    // even when it is our own radio or the node is turned away here.
    rawPacket = {
      from: packet.from,
      channel: channelEvidence(packet),
      viaMqtt: packet.viaMqtt,
    };

    if (localNodeNum !== null && packet.from === localNodeNum) return;

    if (
      !admitted(packet.from, {
        channel: rawPacket.channel,
        viaMqtt: packet.viaMqtt,
      })
    ) {
      return;
    }

    // A row goes in unconditionally, even with no usable hop count. A node
    // admitted here and nowhere else used to be logged as discovered and
    // then never written: it stayed invisible in the UI, the enricher
    // looked it up and found nothing, and every later packet announced the
    // same discovery again because `nodes.exists` was still false.
    const hops = hopsTravelled(packet);
    const direct = hops === 0;
    nodes.upsert({
      nodeNum: packet.from,
      hopsAway: hops ?? undefined,
      snr: direct ? zeroAsNull(packet.rxSnr) : undefined,
      rssi: direct ? zeroAsNull(packet.rxRssi) : undefined,
      lastHeardAt: resolveTime(packet.rxTime),
    });
  });

  listener.on(
    "metadata",
    (packet: Types.PacketMetadata<Protobuf.Mesh.DeviceMetadata>) => {
      if (!admitted(packet.from, evidenceFor(packet))) return;
      nodes.upsert({
        nodeNum: packet.from,
        firmwareVersion: packet.data.firmwareVersion || null,
        role: enumName(Protobuf.Config.Config_DeviceConfig_Role, packet.data.role),
        lastHeardAt: Math.floor(packet.rxTime.getTime() / 1000),
      });
    },
  );
}
