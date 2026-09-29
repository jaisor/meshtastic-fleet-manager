import { EventEmitter } from "node:events";
import { MeshDevice, Types } from "@meshtastic/core";
import { TransportNodeSerial } from "@meshtastic/transport-node-serial";
import { SerialPort } from "serialport";
import type { FastifyBaseLogger } from "fastify";
import type { RadioStatus } from "../../shared/types.js";

/**
 * Owns the USB link to the local Meshtastic node: connect, stay connected,
 * and hand every decoded packet to whoever subscribed.
 *
 * The radio being unplugged is a normal event, not an error. The listener
 * reconnects on a backoff ladder and reports `connected: false` so the UI
 * can say "the radio is gone" rather than showing hours-old rows as live.
 */

/** USB vendor IDs seen on Meshtastic hardware and their USB-serial bridges. */
const KNOWN_VENDOR_IDS = new Set([
  "239a", // Adafruit / nRF52 boards
  "303a", // Espressif (native USB ESP32-S3/C3)
  "10c4", // Silicon Labs CP210x
  "1a86", // QinHeng CH340 / CH9102
  "2886", // Seeed Studio
  "1209", // generic / pid.codes
]);

export interface ListenerOptions {
  portPath: string;
  baud: number;
  /** Seconds between reconnect attempts; the final value repeats. */
  backoff: number[];
  logger: FastifyBaseLogger;
}

export class MeshListener extends EventEmitter {
  private device: MeshDevice | null = null;
  private transport: TransportNodeSerial | null = null;
  private stopped = false;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  private status: RadioStatus = {
    connected: false,
    configured: false,
    portPath: "",
    localNodeNum: null,
    lastErrorText: null,
    lastConnectedAt: null,
  };

  constructor(private readonly options: ListenerOptions) {
    super();
    this.status.portPath = options.portPath;
  }

  getStatus(): RadioStatus {
    return { ...this.status };
  }

  /** The connected device, or null while disconnected. */
  getDevice(): MeshDevice | null {
    return this.status.connected ? this.device : null;
  }

  /**
   * Begins connecting and keeps trying until `stop()`. Deliberately not
   * awaited by the caller: the HTTP server must come up even with no radio
   * attached, so an operator can still reach the UI to see why.
   */
  start(): void {
    this.stopped = false;
    void this.connectLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.teardown();
  }

  private async teardown(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    this.device = null;
    this.status.connected = false;
    this.status.configured = false;
    if (transport) {
      try {
        await transport.disconnect();
      } catch {
        // Already gone -- unplugging is exactly how we get here.
      }
    }
  }

  private async connectLoop(): Promise<void> {
    if (this.stopped) return;

    try {
      const path = await resolvePort(this.options.portPath);
      this.status.portPath = path;
      this.options.logger.info({ path }, "connecting to local Meshtastic node");

      const transport = await TransportNodeSerial.create(path, this.options.baud);
      this.transport = transport;

      const device = new MeshDevice(transport);
      this.device = device;
      this.wireEvents(device);

      this.status.connected = true;
      this.status.lastErrorText = null;
      this.status.lastConnectedAt = Math.floor(Date.now() / 1000);
      this.attempt = 0;

      // `configure()` asks the radio to dump its full state: MyNodeInfo, the
      // channel list, config, and every node in its NodeDB. That dump is
      // where the fleet comes from on a cold start -- discovery does not
      // have to wait for each node to transmit again.
      await device.configure();
      this.emit("connected", device);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.status.lastErrorText = message;
      this.options.logger.warn({ err: message }, "serial connection failed");
      await this.teardown();
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const ladder = this.options.backoff;
    const delay = ladder[Math.min(this.attempt, ladder.length - 1)] ?? 5;
    this.attempt += 1;
    this.options.logger.info({ delay }, "retrying serial connection");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectLoop();
    }, delay * 1000);
  }

  private wireEvents(device: MeshDevice): void {
    device.events.onDeviceStatus.subscribe((status) => {
      this.status.configured = status === Types.DeviceStatusEnum.DeviceConfigured;

      if (
        status === Types.DeviceStatusEnum.DeviceDisconnected &&
        this.status.connected
      ) {
        this.options.logger.warn("radio disconnected");
        void this.teardown().then(() => this.scheduleReconnect());
      }
    });

    device.events.onMyNodeInfo.subscribe((info) => {
      this.status.localNodeNum = info.myNodeNum;
      this.emit("myNodeInfo", info);
    });

    device.events.onNodeInfoPacket.subscribe((n) => this.emit("nodeInfo", n));
    device.events.onUserPacket.subscribe((p) => this.emit("user", p));
    device.events.onTelemetryPacket.subscribe((p) => this.emit("telemetry", p));
    device.events.onPositionPacket.subscribe((p) => this.emit("position", p));
    device.events.onMessagePacket.subscribe((p) => this.emit("message", p));
    device.events.onDeviceMetadataPacket.subscribe((p) => this.emit("metadata", p));
    device.events.onRoutingPacket.subscribe((p) => this.emit("routing", p));
    device.events.onMeshPacket.subscribe((p) => this.emit("meshPacket", p));
  }
}

/**
 * Resolves `"auto"` to a real device path by looking for a USB vendor ID
 * known to appear on Meshtastic hardware.
 *
 * Prefer a `/dev/serial/by-id/...` path in config over letting this guess:
 * `ttyUSB0` renumbers on replug, and with two radios attached "the first
 * one" is whichever the kernel enumerated first, which is not stable.
 */
export async function resolvePort(configured: string): Promise<string> {
  if (configured !== "auto") return configured;

  const ports = await SerialPort.list();
  const candidate = ports.find((port) =>
    KNOWN_VENDOR_IDS.has((port.vendorId ?? "").toLowerCase()),
  );

  if (!candidate) {
    const seen = ports.map((p) => p.path).join(", ") || "none";
    throw new Error(
      `serial.port is "auto" but no known Meshtastic USB device was found (ports seen: ${seen})`,
    );
  }
  return candidate.path;
}
