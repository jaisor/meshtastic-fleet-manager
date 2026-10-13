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
      /**
       * False turns sign-in and roles off: every request is treated as the
       * built-in admin. For a console reachable only from a trusted network.
       */
      enabled: z.boolean().default(true),
      password: z.string().min(1).optional(),
      password_hash: z.string().min(1).optional(),
    })
    // With auth on, exactly one. With it off neither is needed, but one may
    // stay in the file for when it is turned back on; two is still a mistake.
    .refine(
      (v) =>
        v.enabled
          ? Boolean(v.password) !== Boolean(v.password_hash)
          : !(v.password && v.password_hash),
      {
        message: "set exactly one of auth.password or auth.password_hash",
      },
    ),
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
  /**
   * A second source of node reports: our own subscription to an MQTT broker
   * that the fleet's gateways uplink to. JSON payloads only. Read-only --
   * nothing is ever published.
   */
  mqtt: z
    .object({
      enabled: z.boolean().default(false),
      /** mqtt://, mqtts://, ws:// or wss://. Required when enabled. */
      url: z
        .url({
          protocol: /^(mqtts?|wss?)$/,
          error: "expected an mqtt://, mqtts://, ws:// or wss:// URL",
        })
        .optional(),
      /** One filter or several, MQTT wildcards allowed. Required when enabled. */
      topic: z
        .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
        .optional(),
      username: z.string().min(1).optional(),
      /** At most one of these two. */
      password: z.string().min(1).optional(),
      password_file: z.string().min(1).optional(),
      /** Defaults to a random id per start. */
      client_id: z.string().min(1).optional(),
      /** Set false only for a broker with a self-signed certificate. */
      reject_unauthorized: z.boolean().default(true),
      /**
       * Admit nodes first reported here. Off, the feed only keeps nodes
       * already in the fleet up to date.
       */
      discovery: z.boolean().default(true),
      /**
       * One info line per message received. Off, the same lines are logged
       * at debug -- for a busy broker, where they would drown everything.
       */
      log_messages: z.boolean().default(true),
    })
    .refine((v) => !(v.password && v.password_file), {
      message: "set at most one of mqtt.password or mqtt.password_file",
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
  /**
   * The assistant: free-text questions about the fleet, answered as a filter
   * over the fleet list. Off unless switched on. Every question is a call to
   * the provider on the server owner's key.
   */
  llm: z
    .object({
      enabled: z.boolean().default(false),
      provider: z
        .enum(["google", "anthropic", "openai", "openai_compatible"])
        .default("google"),
      /** Required except for `google`, which defaults to a free-tier model. */
      model: z.string().min(1).optional(),
      /** At most one of these three. With none, the provider's usual env var. */
      api_key: z.string().min(1).optional(),
      api_key_env: z.string().min(1).optional(),
      api_key_file: z.string().min(1).optional(),
      /** Required for `openai_compatible` (Ollama, LM Studio, vLLM, ...). */
      base_url: z.url().optional(),
      timeout: duration.pipe(z.number().min(1).max(300)).default(30),
      /** Input plus output tokens per UTC day, across all users. 0 is no cap. */
      daily_token_budget: z.number().int().min(0).default(500_000),
    })
    .refine(
      (v) => [v.api_key, v.api_key_env, v.api_key_file].filter(Boolean).length <= 1,
      { message: "set at most one of llm.api_key, llm.api_key_env or llm.api_key_file" },
    )
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
  /** `mqtt.enabled && mqtt.discovery`: the broker feed may admit nodes. */
  brokerDiscovery: boolean;
}

/** The `mqtt` section, resolved: the password read from wherever it was put. */
export interface MqttConfig {
  url: string;
  topics: string[];
  username: string | null;
  password: string | null;
  clientId: string;
  rejectUnauthorized: boolean;
  logMessages: boolean;
}

export type LlmProvider = "google" | "anthropic" | "openai" | "openai_compatible";

/** The `llm` section, resolved: the key read from wherever it was put. */
export interface AssistantConfig {
  provider: LlmProvider;
  model: string;
  /** Null only for `openai_compatible`, where a local server may need none. */
  apiKey: string | null;
  baseUrl: string | null;
  /** Seconds. */
  timeout: number;
  /** 0 means no cap. */
  dailyTokenBudget: number;
}

/**
 * Free-tier eligible on Google AI Studio as of 2026-10, and the cheapest of
 * Google's paid rates if billing is on. Only Google gets a default: the
 * others have no free tier, so choosing a model there is choosing a price.
 */
const DEFAULT_GOOGLE_MODEL = "gemini-2.5-flash-lite";

/** What each provider's own SDK reads when no key is configured. */
const CONVENTIONAL_KEY_ENV: Record<Exclude<LlmProvider, "openai_compatible">, string> = {
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

export type AppConfig = z.infer<typeof schema> & {
  discoveryRules: DiscoveryRules;
  /** Null when `llm.enabled` is off. */
  assistant: AssistantConfig | null;
  /** Null when `mqtt.enabled` is off. */
  broker: MqttConfig | null;
  /**
   * Resolved at load time; never the plaintext from the file. Null only with
   * auth disabled and no password set, in which case nobody signs in at all.
   */
  passwordHash: string | null;
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
    : config.auth.password
      ? hashPassword(config.auth.password)
      : null;
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
    brokerDiscovery: config.mqtt.enabled && config.mqtt.discovery,
  };

  const assistant = config.llm.enabled ? resolveAssistant(config.llm) : null;
  // Same treatment as the password: the key lives in `assistant` only, so
  // logging the config object can never print it.
  config.llm.api_key = undefined;

  const broker = config.mqtt.enabled ? resolveBroker(config.mqtt) : null;
  config.mqtt.password = undefined;

  return {
    ...config,
    passwordHash,
    sessionSecret: config.server.session_secret,
    discoveryRules,
    assistant,
    broker,
  };
}

/**
 * Turns the `mqtt` section into connection settings, or refuses to start.
 *
 * Only what would leave an enabled feed silently useless is fatal: no
 * broker, no topic, an unreadable password file. A broker that is down or
 * refuses the credentials is not -- that is a runtime condition, retried
 * and reported in the status like an unplugged radio.
 */
function resolveBroker(mqtt: z.infer<typeof schema>["mqtt"]): MqttConfig {
  if (!mqtt.url) {
    throw new ConfigError(
      "mqtt.url is required when mqtt.enabled is true, e.g. mqtt://broker.local:1883",
    );
  }
  if (!mqtt.topic) {
    throw new ConfigError(
      "mqtt.topic is required when mqtt.enabled is true, e.g. msh/US/2/json/#",
    );
  }

  let password = mqtt.password ?? null;
  if (mqtt.password_file) {
    try {
      password = readFileSync(mqtt.password_file, "utf8").trim();
    } catch (cause) {
      throw new ConfigError(
        `cannot read mqtt.password_file at ${mqtt.password_file}: ${(cause as Error).message}`,
      );
    }
    if (!password) throw new ConfigError(`mqtt.password_file at ${mqtt.password_file} is empty`);
  }

  return {
    url: mqtt.url,
    topics: Array.isArray(mqtt.topic) ? mqtt.topic : [mqtt.topic],
    username: mqtt.username ?? null,
    password,
    // Random per start: two instances sharing a fixed id would knock each
    // other off the broker in a reconnect loop.
    clientId: mqtt.client_id ?? `mfm-${randomBytes(4).toString("hex")}`,
    rejectUnauthorized: mqtt.reject_unauthorized,
    logMessages: mqtt.log_messages,
  };
}

/**
 * Turns the `llm` section into something callable, or refuses to start.
 *
 * An enabled assistant with no usable key would boot fine and then fail on
 * every question, which is the half-configured state this file exists to
 * prevent. So a missing key, an unreadable key file or a named environment
 * variable that is unset are all fatal here, naming what is missing.
 */
function resolveAssistant(llm: z.infer<typeof schema>["llm"]): AssistantConfig {
  const { provider } = llm;

  let model = llm.model;
  if (!model) {
    if (provider !== "google") {
      throw new ConfigError(`llm.model is required for provider "${provider}"`);
    }
    model = DEFAULT_GOOGLE_MODEL;
  }

  if (provider === "openai_compatible" && !llm.base_url) {
    throw new ConfigError(
      'llm.base_url is required for provider "openai_compatible", e.g. http://localhost:11434/v1 for Ollama',
    );
  }

  let apiKey: string | null = null;
  if (llm.api_key_file) {
    try {
      apiKey = readFileSync(llm.api_key_file, "utf8").trim();
    } catch (cause) {
      throw new ConfigError(
        `cannot read llm.api_key_file at ${llm.api_key_file}: ${(cause as Error).message}`,
      );
    }
    if (!apiKey) throw new ConfigError(`llm.api_key_file at ${llm.api_key_file} is empty`);
  } else if (llm.api_key_env) {
    apiKey = process.env[llm.api_key_env]?.trim() || null;
    if (!apiKey) {
      throw new ConfigError(
        `llm.api_key_env names ${llm.api_key_env}, which is not set in the environment`,
      );
    }
  } else if (llm.api_key) {
    apiKey = llm.api_key;
  } else if (provider !== "openai_compatible") {
    const conventional = CONVENTIONAL_KEY_ENV[provider];
    apiKey = process.env[conventional]?.trim() || null;
    if (!apiKey) {
      throw new ConfigError(
        `llm.enabled is true but no API key was found for "${provider}": set llm.api_key_file, ` +
          `llm.api_key_env or llm.api_key, or the ${conventional} environment variable`,
      );
    }
  }

  return {
    provider,
    model,
    apiKey,
    baseUrl: llm.base_url ?? null,
    timeout: llm.timeout,
    dailyTokenBudget: llm.daily_token_budget,
  };
}
