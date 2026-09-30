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

/**
 * Firmware closes its end of the serial API session after 15 minutes without
 * a byte from the client (`SERIAL_CONNECTION_TIMEOUT`, SerialConsole.cpp).
 * After that `PhoneAPI::available()` is false: the port stays open, nothing
 * errors, and no packet ever reaches us again -- a radio that looks connected
 * and has gone deaf. We transmit only on probes and operator actions, so an
 * idle server hit this every time. A heartbeat is a ToRadio like any other and
 * resets that clock; five minutes leaves two to spare before the cutoff.
 */
const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000;

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
  /** False when serial.enabled is off; reported so the UI can say why. */
  enabled: boolean;
  logger: FastifyBaseLogger;
}

export class MeshListener extends EventEmitter {
  private device: MeshDevice | null = null;
  private transport: TransportNodeSerial | null = null;
  private stopped = false;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  /**
   * Bumped by every connection attempt. `configure()` can settle long after
   * its connection was torn down -- the library resolves `wantConfigId` on a
   * 60s timeout rather than on the reply -- and a stale attempt must not
   * announce a dead device or schedule a second reconnect.
   */
  private generation = 0;

  private status: Omit<RadioStatus, "watchdog"> = {
    connected: false,
    configured: false,
    enabled: true,
    portPath: "",
    localNodeNum: null,
    lastErrorText: null,
    lastConnectedAt: null,
    decodeErrors: 0,
    lastDecodeErrorAt: null,
    lastAirPacketAt: null,
  };

  constructor(private readonly options: ListenerOptions) {
    super();
    this.status.portPath = options.portPath;
    this.status.enabled = options.enabled;
  }

  /** Everything but the watchdog's half, which the watchdog reports itself. */
  getStatus(): Omit<RadioStatus, "watchdog"> {
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

  /**
   * Drops a link that is open but no longer working, and reconnects.
   *
   * For the watchdog: the port is fine as far as the OS knows, so nothing
   * else would ever notice. Reconnecting sends a fresh `wantConfigId`, which
   * is what reopens the firmware's API session. Anything waiting on the mesh
   * is told first, as on an unplug, so it gives up now instead of timing out.
   */
  restart(reason: string): void {
    if (this.stopped || !this.status.connected) return;
    this.options.logger.warn({ reason }, "restarting serial link");
    this.status.lastErrorText = reason;
    this.emit("disconnected");
    this.attempt = 0;
    void this.teardown().then(() => this.scheduleReconnect());
  }

  private async teardown(): Promise<void> {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
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
    const generation = ++this.generation;

    try {
      const path = await resolvePort(this.options.portPath);
      this.status.portPath = path;
      this.options.logger.info({ path }, "connecting to local Meshtastic node");

      const port = await openSerialPort(path, this.options.baud, this.options.logger);
      const transport = new TransportNodeSerial(port);
      this.transport = transport;

      const device = new MeshDevice(transport);
      this.device = device;
      this.countDecodeErrors(device);
      this.wireEvents(device);

      this.status.connected = true;
      this.status.lastErrorText = null;
      this.status.decodeErrors = 0;
      this.status.lastDecodeErrorAt = null;
      this.status.lastConnectedAt = Math.floor(Date.now() / 1000);
      this.attempt = 0;
      this.startKeepalive(device);

      // `configure()` asks the radio to dump its full state: MyNodeInfo, the
      // channel list, config, and every node in its NodeDB. That dump is
      // where the fleet comes from on a cold start -- discovery does not
      // have to wait for each node to transmit again.
      await device.configure();
      if (generation !== this.generation || this.device !== device) return;
      this.emit("connected", device);
    } catch (cause) {
      if (generation !== this.generation) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      this.status.lastErrorText = message;
      this.options.logger.warn({ err: message }, "serial connection failed");
      await this.teardown();
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    // Two failure paths can both land here for one dead connection -- an
    // unplug seen by the status event and by `configure()` rejecting.
    if (this.stopped || this.reconnectTimer) return;
    const ladder = this.options.backoff;
    const delay = ladder[Math.min(this.attempt, ladder.length - 1)] ?? 5;
    this.attempt += 1;
    this.options.logger.info({ delay }, "retrying serial connection");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectLoop();
    }, delay * 1000);
  }

  /**
   * Holds the firmware's API session open; see `KEEPALIVE_INTERVAL_MS`.
   *
   * Our own timer rather than the library's `setHeartbeatInterval`, which is
   * cleared only by a `DeviceDisconnected` status and so would keep writing to
   * a transport we tore down ourselves.
   */
  private startKeepalive(device: MeshDevice): void {
    this.keepaliveTimer = setInterval(() => {
      device.heartbeat().catch((cause: unknown) => {
        this.options.logger.debug(
          { err: cause instanceof Error ? cause.message : String(cause) },
          "heartbeat to radio failed",
        );
      });
    }, KEEPALIVE_INTERVAL_MS);
    this.keepaliveTimer.unref();
  }

  /**
   * Tallies frames the radio sent that could not be parsed as protobuf.
   *
   * `@meshtastic/core` logs these through its own tslog instance and then
   * drops the frame; there is no event for it, and the non-protobuf bytes
   * that caused the desync are discarded outright (`case "debug": break`).
   * So the count is the only signal available, and without it there is no
   * way to tell one-off resynchronization from steady packet loss.
   *
   * Matching on the message text is admittedly brittle. It is a diagnostic
   * counter, so a miscount is cosmetic -- but if this ever silently reads
   * zero on a noisy link, check whether the library reworded the message.
   */
  private countDecodeErrors(device: MeshDevice): void {
    device.log.attachTransport((entry: Record<string, unknown>) => {
      const meta = entry["_meta"] as { logLevelName?: string } | undefined;
      if (meta?.logLevelName !== "ERROR") return;

      const undecodable = Object.values(entry).some(
        (value) => typeof value === "string" && value.includes("undecodable"),
      );
      if (!undecodable) return;

      this.status.decodeErrors += 1;
      this.status.lastDecodeErrorAt = Math.floor(Date.now() / 1000);
    });
  }

  private wireEvents(device: MeshDevice): void {
    device.events.onDeviceStatus.subscribe((status) => {
      this.status.configured = status === Types.DeviceStatusEnum.DeviceConfigured;

      if (
        status === Types.DeviceStatusEnum.DeviceDisconnected &&
        this.status.connected
      ) {
        this.options.logger.warn("radio disconnected");
        // Emitted before teardown so anything waiting on the mesh can give
        // up now rather than sit out its full timeout against a radio that
        // is no longer there.
        this.emit("disconnected");
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

    /**
     * True only while a decoded MeshPacket is being dispatched.
     *
     * `onConfigPacket` and `onModuleConfigPacket` have **two** dispatch sites
     * in the library and carry no node number: `handleFromRadio` emits them
     * for the local radio's own config dump during `configure()`, and
     * `handleDecodedPacket` emits them again for a *remote* node's
     * `getConfigResponse`. Subscribing naively would file a remote node's
     * LoRa preset as the local radio's, silently, and the local node is
     * exactly the one whose values look plausible enough not to be
     * questioned.
     *
     * The two are distinguishable by origin: an admin response always
     * arrives inside a MeshPacket dispatch, the local dump never does.
     * `handleMeshPacket` dispatches `onMeshPacket` first and then calls
     * `handleDecodedPacket` on the same synchronous call stack, so a flag set
     * here and cleared in a microtask is true for exactly that window.
     * Remote reads are the `AdminClient`'s business anyway -- it correlates
     * them by `requestId`, which is authoritative -- so they are dropped
     * here rather than guessed at.
     */
    let inMeshPacket = false;
    device.events.onMeshPacket.subscribe((p) => {
      // Encrypted packets count: the radio could not open them, but it did
      // hear them, which is the thing in question.
      if (p.from !== this.status.localNodeNum && !p.viaMqtt) {
        this.status.lastAirPacketAt = Math.floor(Date.now() / 1000);
      }
      inMeshPacket = true;
      queueMicrotask(() => {
        inMeshPacket = false;
      });
      this.emit("meshPacket", p);
    });

    device.events.onConfigPacket.subscribe((config) => {
      if (inMeshPacket) return;
      this.emit("localConfig", config);
    });
    device.events.onModuleConfigPacket.subscribe((config) => {
      if (inMeshPacket) return;
      this.emit("localModuleConfig", config);
    });
  }
}

/**
 * Opens the serial port ourselves instead of calling
 * `TransportNodeSerial.create()`.
 *
 * That factory crashes the process when the port cannot be opened. Its
 * error path is:
 *
 * ```js
 * const onError = (err) => { port.close(); reject(err); };
 * port.once("error", onError);
 * ```
 *
 * `close()` on a port that never opened does not throw -- with no callback
 * it *emits* `error`. The `once` listener has already been consumed by the
 * time it runs, so nothing is listening, and Node turns an unhandled
 * `error` event into an uncaught exception. A missing or busy radio would
 * take the whole server down with it, which is precisely what must not
 * happen: the console has to come up so an operator can see why.
 *
 * So: create the port with `autoOpen: false`, attach a durable `error`
 * listener *before* anything can fail, and open it with a callback. Fixed
 * upstream, this can go back to `TransportNodeSerial.create`.
 */
function openSerialPort(
  path: string,
  baudRate: number,
  logger: FastifyBaseLogger,
): Promise<SerialPort> {
  return new Promise((resolve, reject) => {
    const port = new SerialPort({ path, baudRate, autoOpen: false });

    // Stays attached for the port's lifetime. `TransportNodeSerial` adds
    // its own handler later; several listeners are fine, zero is fatal.
    port.on("error", (cause: Error) => {
      logger.warn({ err: cause.message }, "serial port error");
    });

    port.open((cause) => {
      if (cause) {
        reject(cause);
        return;
      }
      resolve(port);
    });
  });
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
