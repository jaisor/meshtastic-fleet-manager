import { readFileSync } from "node:fs";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * Loads and validates the mounted YAML config. A fleet manager that starts
 * with half a config is worse than one that refuses to start, so every
 * failure here is fatal and reported with the offending path.
 */

/** Accepts `30s`, `12h`, `7d`, or a bare number of seconds. */
const duration = z
  .union([z.string(), z.number()])
  .transform((value, ctx) => {
    if (typeof value === "number") return value;
    const match = /^(\d+)\s*(s|m|h|d)?$/.exec(value.trim());
    if (!match) {
      ctx.addIssue({
        code: "custom",
        message: `expected a duration like "30s", "12h" or "7d", got "${value}"`,
      });
      return z.NEVER;
    }
    const scale = { s: 1, m: 60, h: 3600, d: 86400 }[match[2] ?? "s"] ?? 1;
    return Number(match[1]) * scale;
  });

const schema = z.object({
  server: z
    .object({
      host: z.string().default("0.0.0.0"),
      port: z.number().int().min(1).max(65535).default(8432),
      session_secret: z.string().min(16).optional(),
      session_ttl: duration.default(12 * 3600),
      /**
       * Set true only when the app is reached over HTTPS. It marks the
       * session cookie `Secure`, which a browser will silently drop on a
       * plain-HTTP origin -- the usual cause of "login does nothing".
       */
      secure_cookies: z.boolean().default(false),
    })
    .prefault({}),
  auth: z
    .object({
      password: z.string().min(1).optional(),
      password_hash: z.string().min(1).optional(),
    })
    .refine((v) => Boolean(v.password) !== Boolean(v.password_hash), {
      message: "set exactly one of auth.password or auth.password_hash",
    }),
  serial: z
    .object({
      /** A device path, or "auto" to pick the first likely Meshtastic port. */
      port: z.string().default("auto"),
      baud: z.number().int().positive().default(115200),
      /** Backoff ladder between reconnect attempts; the last value repeats. */
      reconnect_backoff: z.array(duration).min(1).default([1, 2, 5, 15, 60]),
      enabled: z.boolean().default(true),
    })
    .prefault({}),
  /**
   * Periodically asks the local node a question with a known answer, and
   * restarts the serial link when it stops answering.
   */
  watchdog: z
    .object({
      enabled: z.boolean().default(true),
      /** Between self-checks while healthy. */
      interval: duration
        .pipe(z.number().min(10).max(3600))
        .default(120),
      /** How long one self-check may take. Over USB, not the air. */
      timeout: duration.pipe(z.number().min(1).max(120)).default(10),
      /** Consecutive failed self-checks before the link is restarted. */
      failures_before_restart: z.number().int().min(1).max(20).default(3),
      /**
       * Report the radio as silent when nothing has been heard over the air
       * for this long. 0 turns it off, which suits a fleet of one.
       */
      silence_after: duration.default(2 * 3600),
    })
    .prefault({}),
  database: z
    .object({
      path: z.string().default("/data/fleet.db"),
    })
    .prefault({}),
  /**
   * Which nodes are allowed into the fleet at all.
   *
   * The default admits anything the radio hears. Every key below narrows
   * that, and they compose: a node must satisfy all of them to be admitted.
   */
  discovery: z
    .object({
      /**
       * "any", "primary" (channel 0), or a channel index 0-7 as configured
       * on the radio. A node must be heard on this channel to be admitted.
       */
      channel: z
        .union([
          z.literal("any"),
          z.literal("primary"),
          z.number().int().min(0).max(7),
        ])
        .default("any"),
      /**
       * Require an actual text message. Telemetry, position and node-info
       * broadcasts alone will not admit a node.
       */
      require_message: z.boolean().default(false),
      /**
       * Admit only when the message text contains this substring, compared
       * case-insensitively. Implies require_message.
       */
      message_contains: z.string().min(1).nullable().default(null),
      /**
       * Ask a newly discovered node for its names, hardware, role and
       * metrics instead of waiting hours for its next broadcast. Costs two
       * transmissions per new node, so it can be turned off on a busy mesh.
       */
      probe_new_nodes: z.boolean().default(true),
      /**
       * Admit nodes the radio only ever witnessed over MQTT rather than
       * hearing on the air. They cannot have transmitted on your channel,
       * so they are excluded by default.
       */
      include_mqtt: z.boolean().default(false),
    })
    .prefault({}),
  fleet: z
    .object({
      stale_after: duration.default(6 * 3600),
      offline_after: duration.default(24 * 3600),
      admin_probe_interval: duration.default(24 * 3600),
      admin_probe_timeout: duration.default(30),
      telemetry_retention: duration.default(30 * 86400),
    })
    .prefault({}),
  logging: z
    .object({
      level: z
        .enum(["fatal", "error", "warn", "info", "debug", "trace"])
        .default("info"),
    })
    .prefault({}),
});

/** Discovery rules, normalized from the YAML into what the ingest needs. */
export interface DiscoveryRules {
  /** Null means any channel. */
  channel: number | null;
  requireMessage: boolean;
  /** Already lowercased, ready to compare. */
  messageContains: string | null;
  includeMqtt: boolean;
}

export type AppConfig = z.infer<typeof schema> & {
  discoveryRules: DiscoveryRules;
  /** Resolved at load time; never the plaintext from the file. */
  passwordHash: string;
  sessionSecret: string;
};

const SCRYPT_KEYLEN = 64;

/** `scrypt$<saltHex>$<hashHex>` -- self-describing so the format can change. */
export function hashPassword(password: string, salt?: Buffer): string {
  const useSalt = salt ?? randomBytes(16);
  const derived = scryptSync(password, useSalt, SCRYPT_KEYLEN);
  return `scrypt$${useSalt.toString("hex")}$${derived.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1] ?? "", "hex");
  const expected = Buffer.from(parts[2] ?? "", "hex");
  if (salt.length === 0 || expected.length !== SCRYPT_KEYLEN) return false;
  const actual = scryptSync(password, salt, SCRYPT_KEYLEN);
  return timingSafeEqual(actual, expected);
}

export class ConfigError extends Error {}

export function loadConfig(path: string): AppConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw new ConfigError(
      `cannot read config file at ${path}: ${(cause as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw) ?? {};
  } catch (cause) {
    throw new ConfigError(`${path} is not valid YAML: ${(cause as Error).message}`);
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const where = issue.path.join(".") || "(root)";
      return `  ${where}: ${issue.message}`;
    });
    throw new ConfigError(`${path} failed validation:\n${lines.join("\n")}`);
  }

  const config = result.data;

  // Hash immediately so a plaintext password never reaches a log line, the
  // database, or an error message further down.
  const passwordHash = config.auth.password_hash
    ? config.auth.password_hash
    : hashPassword(config.auth.password as string);
  config.auth.password = undefined;

  if (!config.server.session_secret) {
    // Usable, but every restart invalidates open sessions. Warned about at
    // startup rather than silently tolerated.
    config.server.session_secret = randomBytes(32).toString("hex");
  }

  const channel = config.discovery.channel;
  const discoveryRules: DiscoveryRules = {
    channel:
      channel === "any" ? null : channel === "primary" ? 0 : channel,
    // A substring filter is meaningless without a message to search, so it
    // turns on the message requirement rather than silently doing nothing.
    requireMessage:
      config.discovery.require_message ||
      config.discovery.message_contains !== null,
    messageContains: config.discovery.message_contains?.toLowerCase() ?? null,
    includeMqtt: config.discovery.include_mqtt,
  };

  return {
    ...config,
    passwordHash,
    sessionSecret: config.server.session_secret,
    discoveryRules,
  };
}
