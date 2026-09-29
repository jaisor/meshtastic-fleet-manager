import type { Types } from "@meshtastic/core";
import { Protobuf } from "@meshtastic/core";
import type { FastifyBaseLogger } from "fastify";
import type { NodeRepository } from "../db/repositories/nodes.js";
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

export function attachIngest(
  listener: MeshListener,
  nodes: NodeRepository,
  logger: FastifyBaseLogger,
): void {
  let localNodeNum: number | null = null;

  listener.on("myNodeInfo", (info: Protobuf.Mesh.MyNodeInfo) => {
    localNodeNum = info.myNodeNum;
    nodes.upsert({
      nodeNum: info.myNodeNum,
      isLocal: true,
      lastHeardAt: nowSeconds(),
    });
    logger.info({ localNodeNum }, "local node identified");
  });

  /**
   * The NodeDB dump on connect and every subsequent NodeInfo both land
   * here. This is the primary discovery path: anything the local radio has
   * heard on the primary channel becomes a fleet member with no enrollment.
   */
  listener.on("nodeInfo", (info: Protobuf.Mesh.NodeInfo) => {
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
    nodes.upsert({
      nodeNum: packet.from,
      lastHeardAt: Math.floor(packet.rxTime.getTime() / 1000),
    });
  });

  listener.on(
    "metadata",
    (packet: Types.PacketMetadata<Protobuf.Mesh.DeviceMetadata>) => {
      nodes.upsert({
        nodeNum: packet.from,
        firmwareVersion: packet.data.firmwareVersion || null,
        role: enumName(Protobuf.Config.Config_DeviceConfig_Role, packet.data.role),
        lastHeardAt: Math.floor(packet.rxTime.getTime() / 1000),
      });
    },
  );
}
