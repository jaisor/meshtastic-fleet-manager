import { randomInt } from "node:crypto";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { type MeshDevice, Protobuf } from "@meshtastic/core";
import type { FastifyBaseLogger } from "fastify";
import type { RadioWatchdogStatus } from "../../shared/types.js";
import type { MeshListener } from "./listener.js";
import { logNode, toNodeId } from "./nodeId.js";

/**
 * Checks that the USB-attached radio is still working, not merely attached.
 *
 * An open serial port proves very little. The firmware can close its end of
 * the API session while the port stays open -- it does exactly that after 15
 * minutes without contact -- and from here that is indistinguishable from a
 * quiet mesh: no error, no disconnect, just nothing arriving. So on a
 * schedule the watchdog asks the local node a question whose answer it can
 * predict, and restarts the link when the answer stops coming.
 *
 * **The question is an admin `getDeviceMetadataRequest` addressed to the
 * local node itself.** It exercises the whole path that matters: our write,
 * the firmware's packet router and admin module, and the firmware delivering
 * a reply back to the API client -- the step a closed session silently stops
 * doing. A heartbeat would not do: firmware answers one with a queue status
 * even after it has closed the session, so a heartbeat reply proves the
 * serial line and nothing else.
 *
 * **It uses no airtime.** A packet addressed to the local node is handled on
 * the node and never transmitted, which is why the watchdog does not take the
 * radio lock (`tasks.ts`) and may run beside an operator's admin exchange.
 *
 * **What is validated:** a reply arrives within the timeout, it comes from
 * the node number the radio reported on connect, it is a metadata response,
 * and it reports the same firmware version and hardware model as the first
 * check of this session. The last two are a baseline, re-taken whenever the
 * node re-sends its configuration (a reconnect, or a reboot the library
 * reconfigures after), so an OTA update does not count as a fault.
 *
 * **What it cannot see is the LoRa transceiver.** The self-check never goes
 * near it. The only evidence available for that is packets from other nodes
 * arriving, so silence on the air is tracked and reported -- but not acted
 * on, since a deaf radio and a quiet mesh look identical from here.
 */

const ADMIN_PORT = Protobuf.Portnums.PortNum.ADMIN_APP;

/**
 * How long a connection may spend in its configuration dump before that is
 * itself a failure. The dump carries the whole NodeDB at 115200 baud, so on a
 * busy mesh it is not quick; a dump that never finishes is still a wedge.
 */
const CONFIGURE_GRACE_SECONDS = 180;

/** First check after (re)connecting, so a bad link is caught promptly. */
const FIRST_CHECK_SECONDS = 30;

/** Retry spacing after a failure, so a real fault is confirmed quickly. */
const RETRY_SECONDS = 15;

export interface RadioWatchdogOptions {
  listener: MeshListener;
  logger: FastifyBaseLogger;
  /** Seconds between self-checks while healthy. */
  interval: number;
  /** Seconds one self-check may take. */
  timeout: number;
  failuresBeforeRestart: number;
  /** Seconds of air silence before reporting it; 0 turns that off. */
  silenceAfter: number;
}

interface Baseline {
  device: MeshDevice;
  firmwareVersion: string;
  hwModel: number;
}

type Waiter = (packet: Protobuf.Mesh.MeshPacket) => void;

export class RadioWatchdog {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private readonly waiters = new Map<number, Waiter>();

  /** Reset whenever the node re-sends its configuration. */
  private baseline: Baseline | null = null;
  private configuringSince: { device: MeshDevice; at: number } | null = null;
  /**
   * When this connection started listening. Silence is measured from here
   * when it is later than the last packet heard: a radio that was unplugged
   * all night has not been deaf all night.
   */
  private listeningSince: number | null = null;
  private wasSilent = false;

  private readonly status: Omit<RadioWatchdogStatus, "silent"> = {
    state: "pending",
    lastCheckAt: null,
    lastOkAt: null,
    lastLatencyMs: null,
    consecutiveFailures: 0,
    failuresBeforeRestart: 0,
    lastFailureText: null,
    restarts: 0,
    lastRestartAt: null,
    lastRestartReason: null,
    silenceAfter: null,
    firmwareVersion: null,
  };

  constructor(private readonly options: RadioWatchdogOptions) {
    this.status.failuresBeforeRestart = options.failuresBeforeRestart;
    this.status.silenceAfter = options.silenceAfter > 0 ? options.silenceAfter : null;
  }

  start(): void {
    this.stopped = false;
    this.options.listener.on("meshPacket", this.onMeshPacket);
    this.options.listener.on("disconnected", this.onDisconnected);
    this.schedule(FIRST_CHECK_SECONDS);
  }

  stop(): void {
    this.stopped = true;
    this.options.listener.off("meshPacket", this.onMeshPacket);
    this.options.listener.off("disconnected", this.onDisconnected);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  getStatus(): RadioWatchdogStatus {
    return { ...this.status, silent: this.isSilent() };
  }

  private readonly onMeshPacket = (packet: Protobuf.Mesh.MeshPacket): void => {
    if (packet.payloadVariant.case !== "decoded") return;
    const data = packet.payloadVariant.value;
    if (data.portnum !== ADMIN_PORT || data.requestId === 0) return;
    this.waiters.get(data.requestId)?.(packet);
  };

  private readonly onDisconnected = (): void => {
    this.resetConnection();
    // Check soon after the listener is back rather than a full interval on.
    this.schedule(FIRST_CHECK_SECONDS);
  };

  /** Forgets everything that described the previous connection. */
  private resetConnection(): void {
    this.baseline = null;
    this.configuringSince = null;
    this.listeningSince = null;
    this.wasSilent = false;
    this.status.state = "pending";
    this.status.consecutiveFailures = 0;
    this.status.firmwareVersion = null;
  }

  private schedule(seconds: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), seconds * 1000);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    this.timer = null;
    let next = this.options.interval;
    try {
      next = await this.check();
    } catch (cause) {
      // A bug in here must not stop the watchdog for good.
      this.options.logger.error(
        { err: cause instanceof Error ? cause.stack : String(cause) },
        "radio watchdog check threw",
      );
    }
    // A disconnect during the check has already scheduled the next one.
    if (!this.timer) this.schedule(next);
  }

  /** One pass. Returns the seconds until the next. */
  private async check(): Promise<number> {
    const { listener } = this.options;
    const device = listener.getDevice();
    const radio = listener.getStatus();
    const now = Math.floor(Date.now() / 1000);

    // Not connected is the listener's own business: it is already retrying,
    // and there is nothing here to ask.
    if (!device) {
      if (this.status.state !== "pending") this.resetConnection();
      return this.options.interval;
    }

    if (!radio.configured) {
      // The node is (re)sending its configuration: a new session, so the
      // baseline goes with the old one.
      this.baseline = null;
      if (this.configuringSince?.device !== device) {
        this.configuringSince = { device, at: now };
      }
      if (now - this.configuringSince.at < CONFIGURE_GRACE_SECONDS) {
        return RETRY_SECONDS;
      }
      return this.fail(
        `radio has not finished sending its configuration after ${CONFIGURE_GRACE_SECONDS}s`,
      );
    }
    this.configuringSince = null;
    this.listeningSince ??= now;

    const local = radio.localNodeNum;
    if (local === null) {
      return this.fail("radio is configured but never reported its node number");
    }

    this.status.lastCheckAt = now;
    const started = Date.now();
    let reply: Protobuf.Mesh.MeshPacket;
    try {
      reply = await this.ask(device, local);
    } catch (cause) {
      return this.fail((cause as Error).message);
    }

    // The link may have been dropped while we waited; a verdict on the old
    // connection must not land on the new one.
    if (listener.getDevice() !== device) return this.options.interval;

    const problem = this.validate(device, local, reply);
    if (problem) return this.fail(problem);

    this.succeed(Date.now() - started);
    return this.options.interval;
  }

  /**
   * Sends the self-check and waits for its answer.
   *
   * Goes through `sendRaw` with an id chosen here rather than `sendPacket`,
   * whose id is only returned once the send queue settles -- and for a
   * packet to ourselves that is never, because firmware sends the reply
   * instead of an ACK. Choosing the id lets the waiter be in place before the
   * reply can arrive. The queue is then told the packet is done, so it does
   * not sit there for 60s and log a timeout for a check that succeeded.
   */
  private ask(device: MeshDevice, local: number): Promise<Protobuf.Mesh.MeshPacket> {
    const id = randomInt(1, 0xffffffff);
    const request = create(Protobuf.Admin.AdminMessageSchema, {
      payloadVariant: { case: "getDeviceMetadataRequest", value: true },
    });
    const packet = create(Protobuf.Mesh.MeshPacketSchema, {
      from: local,
      to: local,
      id,
      // Nothing crosses the air, so there is nothing to acknowledge; the
      // reply is the proof.
      wantAck: false,
      channel: 0,
      payloadVariant: {
        case: "decoded",
        value: {
          portnum: ADMIN_PORT,
          payload: toBinary(Protobuf.Admin.AdminMessageSchema, request),
          wantResponse: true,
        },
      },
    });
    const toRadio = create(Protobuf.Mesh.ToRadioSchema, {
      payloadVariant: { case: "packet", value: packet },
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        device.queue.remove(id);
        reject(new Error(`no answer to self-check within ${this.options.timeout}s`));
      }, this.options.timeout * 1000);

      this.waiters.set(id, (reply) => {
        clearTimeout(timer);
        this.waiters.delete(id);
        device.queue.processAck(id);
        resolve(reply);
      });

      device.sendRaw(toBinary(Protobuf.Mesh.ToRadioSchema, toRadio), id).catch(
        (cause: unknown) => {
          // Settled already -- answered or timed out -- and the queue's own
          // verdict on a packet it was told about late is noise.
          if (!this.waiters.has(id)) return;
          clearTimeout(timer);
          this.waiters.delete(id);
          const message = cause instanceof Error ? cause.message : String(cause);
          reject(new Error(`could not send self-check: ${message}`));
        },
      );
    });
  }

  /** Null when the reply is what a healthy node says; otherwise why not. */
  private validate(
    device: MeshDevice,
    local: number,
    reply: Protobuf.Mesh.MeshPacket,
  ): string | null {
    if (reply.from !== local) {
      return `self-check answered by ${toNodeId(reply.from)}, expected ${toNodeId(local)}`;
    }
    if (reply.payloadVariant.case !== "decoded") {
      return "self-check answer was not decoded";
    }

    let message: Protobuf.Admin.AdminMessage;
    try {
      message = fromBinary(
        Protobuf.Admin.AdminMessageSchema,
        reply.payloadVariant.value.payload,
      );
    } catch (cause) {
      return `self-check answer is not an admin message: ${(cause as Error).message}`;
    }
    if (message.payloadVariant.case !== "getDeviceMetadataResponse") {
      return `self-check answered with ${message.payloadVariant.case ?? "an empty message"}`;
    }

    const metadata = message.payloadVariant.value;
    if (!metadata.firmwareVersion) {
      return "self-check answer carries no firmware version";
    }

    if (!this.baseline || this.baseline.device !== device) {
      this.baseline = {
        device,
        firmwareVersion: metadata.firmwareVersion,
        hwModel: metadata.hwModel,
      };
      this.status.firmwareVersion = metadata.firmwareVersion;
      return null;
    }

    if (metadata.firmwareVersion !== this.baseline.firmwareVersion) {
      return `firmware changed mid-session: ${this.baseline.firmwareVersion} -> ${metadata.firmwareVersion}`;
    }
    if (metadata.hwModel !== this.baseline.hwModel) {
      return `hardware model changed mid-session: ${this.baseline.hwModel} -> ${metadata.hwModel}`;
    }
    return null;
  }

  private succeed(latencyMs: number): void {
    const recovered = this.status.consecutiveFailures > 0;
    this.status.state = "ok";
    this.status.consecutiveFailures = 0;
    this.status.lastOkAt = Math.floor(Date.now() / 1000);
    this.status.lastLatencyMs = latencyMs;
    if (recovered) {
      this.options.logger.info({ latencyMs }, "radio answering self-checks again");
    }
    this.noteSilence();
  }

  private fail(reason: string): number {
    this.status.state = "failing";
    this.status.consecutiveFailures += 1;
    this.status.lastFailureText = reason;

    const { consecutiveFailures } = this.status;
    const local = this.options.listener.getStatus().localNodeNum;
    this.options.logger.warn(
      {
        ...(local !== null ? logNode(local) : {}),
        reason,
        consecutiveFailures,
        failuresBeforeRestart: this.options.failuresBeforeRestart,
      },
      "radio self-check failed",
    );

    if (consecutiveFailures < this.options.failuresBeforeRestart) {
      return Math.min(RETRY_SECONDS, this.options.interval);
    }

    this.status.restarts += 1;
    this.status.lastRestartAt = Math.floor(Date.now() / 1000);
    this.status.lastRestartReason = reason;
    this.options.logger.error(
      { reason, consecutiveFailures, restarts: this.status.restarts },
      "radio stopped answering; restarting the serial link",
    );
    // Emits "disconnected", which resets this watchdog and schedules the
    // first check of the next connection.
    this.options.listener.restart(`watchdog: ${reason}`);
    return this.options.interval;
  }

  private isSilent(): boolean {
    const { silenceAfter } = this.options;
    if (silenceAfter <= 0 || this.listeningSince === null) return false;
    if (!this.options.listener.getDevice()) return false;
    const heard = this.options.listener.getStatus().lastAirPacketAt ?? 0;
    const since = Math.max(heard, this.listeningSince);
    return Math.floor(Date.now() / 1000) - since > silenceAfter;
  }

  /** Logs the edges only; the state itself is computed on read. */
  private noteSilence(): void {
    const silent = this.isSilent();
    if (silent === this.wasSilent) return;
    this.wasSilent = silent;
    const lastAirPacketAt = this.options.listener.getStatus().lastAirPacketAt;
    if (silent) {
      this.options.logger.warn(
        { lastAirPacketAt, silenceAfter: this.options.silenceAfter },
        "radio answers over USB but has heard nothing over the air",
      );
    } else {
      this.options.logger.info({ lastAirPacketAt }, "radio hearing the mesh again");
    }
  }
}
