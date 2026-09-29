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
      port: z.number().int().min(1).max(65535).default(8080),
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
  database: z
    .object({
      path: z.string().default("/data/fleet.db"),
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

export type AppConfig = z.infer<typeof schema> & {
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

  return {
    ...config,
    passwordHash,
    sessionSecret: config.server.session_secret,
  };
}
