import { Protobuf } from "@meshtastic/core";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  APICallError,
  generateText,
  NoObjectGeneratedError,
  Output,
  RetryError,
  type LanguageModel,
} from "ai";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import type { AssistantConfig } from "../config.js";
import type {
  AssistantOutcome,
  AssistantQueryRepository,
} from "../db/repositories/assistantQueries.js";
import {
  ADMIN_CAPABILITIES,
  describeDuration,
  FLEET_SORT_KEYS,
  NODE_STATES,
  SIGNAL_QUALITIES,
  type FleetQuery,
} from "../../shared/fleetQuery.js";
import type { AskResponse } from "../../shared/types.js";

/**
 * The assistant: one free-text question in, one `FleetQuery` out.
 *
 * Read-only by construction. The model is given no tools and no fleet data;
 * it fills in a fixed schema of filters, which the browser applies to the
 * list it already holds. Nothing it returns can reach the radio, and the
 * nodes it "finds" are chosen by `matchesFleetQuery`, not by the model.
 *
 * Node names are deliberately absent from the prompt. Anyone on the mesh can
 * name a node anything, including text addressed to a language model, and a
 * prompt that never contains them cannot be steered by them.
 */

/** Longest question accepted. A filter request needs a sentence, not an essay. */
export const MAX_PROMPT_LENGTH = 500;

/** Room for models that think before answering; the answer itself is small. */
const MAX_OUTPUT_TOKENS = 2048;

/**
 * Role names as the decoder that runs at ingest spells them -- the bundled
 * copy inside `@meshtastic/core`, not `@meshtastic/protobufs` (CLAUDE.md §4) --
 * so a role the model picks is one a stored node can actually have.
 */
const ROLE_NAMES = Object.values(Protobuf.Config.Config_DeviceConfig_Role).filter(
  (value): value is string => typeof value === "string",
);

const DURATION = /^(\d+)\s*(s|m|h|d|w)$/;
const DURATION_SCALE: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 7 * 86400,
};

function toSeconds(value: string): number {
  const match = DURATION.exec(value.trim());
  // The schema has already enforced the pattern; this cannot fail.
  return Number(match![1]) * (DURATION_SCALE[match![2]!] ?? 1);
}

const durationField = z
  .string()
  .regex(DURATION)
  .describe('Whole number and unit: s, m, h, d or w. For example "2d", "36h", "1w".');

/**
 * What the model fills in.
 *
 * Every field is present and nullable rather than optional, because that is
 * the shape every provider's structured-output mode accepts (OpenAI's strict
 * mode rejects optional properties outright). Anything that fails these
 * checks fails the whole answer rather than being dropped: a filter that
 * silently lost a constraint would show more nodes than were asked for and
 * look like a correct answer.
 */
const answerSchema = z.object({
  understood: z
    .boolean()
    .describe(
      "False when the question is not about this fleet of Meshtastic nodes, or none of it can be expressed with these filters.",
    ),
  text: z
    .array(z.string().min(1))
    .nullable()
    .describe(
      "Node IDs (like !a4c138f0) or node names the user typed, one term per word. Every term must match. Null unless the user named a node.",
    ),
  states: z
    .array(z.enum(NODE_STATES as [string, ...string[]]))
    .nullable()
    .describe("Reachability as the console classifies it; see the instructions for the thresholds."),
  lastHeardOlderThan: durationField
    .nullable()
    .describe("Not heard for longer than this. Includes nodes never heard at all."),
  lastHeardWithin: durationField.nullable().describe("Heard within this long."),
  batteryBelow: z.number().int().min(0).max(100).nullable().describe("Battery percent, exclusive."),
  batteryAtLeast: z.number().int().min(0).max(100).nullable().describe("Battery percent, inclusive."),
  externallyPowered: z
    .boolean()
    .nullable()
    .describe("True for nodes on external or USB power, false for nodes running on battery."),
  roles: z.array(z.enum(ROLE_NAMES as [string, ...string[]])).nullable(),
  hardware: z
    .array(z.string().min(1))
    .nullable()
    .describe('Fragments of a hardware model name, e.g. "heltec", "tbeam", "rak4631". Any may match.'),
  adminCapability: z
    .array(z.enum(ADMIN_CAPABILITIES as [string, ...string[]]))
    .nullable(),
  signal: z.array(z.enum(SIGNAL_QUALITIES as [string, ...string[]])).nullable(),
  hopsAtMost: z.number().int().min(0).max(15).nullable().describe("0 means heard directly."),
  hopsAtLeast: z.number().int().min(0).max(15).nullable(),
  firmwareBelow: z
    .string()
    .regex(/^\d+(\.\d+)*$/)
    .nullable()
    .describe('Firmware older than this dotted version, e.g. "2.7".'),
  sortBy: z.enum(FLEET_SORT_KEYS).nullable(),
  sortDirection: z.enum(["asc", "desc"]).nullable(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .nullable()
    .describe("Only when the user asks for a number of nodes, e.g. 'the 5 weakest'."),
  note: z
    .string()
    .max(400)
    .nullable()
    .describe(
      "One or two short sentences for the operator, only when needed: why the question could not be answered, or what part of it these filters cannot express. Null otherwise.",
    ),
});

type Answer = z.infer<typeof answerSchema>;

function instructions(staleAfter: number, offlineAfter: number): string {
  const stale = describeDuration(staleAfter);
  const offline = describeDuration(offlineAfter);
  return `You translate an operator's question about a fleet of Meshtastic mesh radio nodes into a filter for the fleet list in a monitoring console.

You cannot see the nodes. Never guess which nodes exist, how many there are, or what their names are. Fill in the filter; the console applies it.

You cannot change anything, and neither can this console's question box. When the operator asks for an action -- restart, reboot, rename, update, refresh, configure, message, probe -- still fill in the filter that finds the nodes the action is about, and use the note to say that changes are made from each node's page. Do not claim anything was done.

How the fields map to the console:
- states: "online" means heard within ${stale}; "stale" means last heard between ${stale} and ${offline} ago; "offline" means not heard for more than ${offline}. When the operator gives an explicit duration ("not heard in 2 days", "staler than 3 days"), use lastHeardOlderThan, not states.
- Battery is a percentage. Nodes on external power report no percentage and never match a battery threshold; "plugged in" or "on mains" means externallyPowered true.
- signal is the quality of the last packet heard directly. "unknown" means it was never measured, usually because the node is only heard through relays; it does not mean a bad link.
- adminCapability is whether this console's radio may remotely administer the node: "capable" yes, "unauthorized" refused, "unreachable" did not answer, "unknown" not checked yet.
- hopsAtMost 0 means heard directly, with no relays.
- text is only for node IDs or names the operator actually typed. Never fill it in from general words like "router" or "battery"; those have their own fields.
- Sorting: lowest battery first is battery asc; most recently heard first is lastHeard desc; longest silent first is lastHeard asc; weakest signal first is signal asc; nearest first is hops asc. Leave sortBy null when the operator did not ask for an order.

Set understood to false, with a short note, when the question is not about the fleet at all. Leave every field the operator did not ask about null.`;
}

export class AssistantError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AssistantError";
    this.status = status;
  }
}

function createModel(config: AssistantConfig): LanguageModel {
  const apiKey = config.apiKey ?? undefined;
  const baseURL = config.baseUrl ?? undefined;
  switch (config.provider) {
    case "google":
      return createGoogle({ apiKey, baseURL })(config.model);
    case "anthropic":
      return createAnthropic({ apiKey, baseURL })(config.model);
    case "openai":
      return createOpenAI({ apiKey, baseURL })(config.model);
    case "openai_compatible":
      return createOpenAICompatible({
        name: "openai_compatible",
        // Validated as present in config.ts for this provider.
        baseURL: baseURL!,
        apiKey,
        // Ollama, LM Studio and vLLM all accept a JSON schema in
        // `response_format`; without this the schema is only described in the
        // prompt, which small local models follow loosely.
        supportsStructuredOutputs: true,
      })(config.model);
  }
}

/** Builds the stored query, dropping every null the model left. */
function toFleetQuery(answer: Answer): FleetQuery {
  const query: FleetQuery = {};
  if (answer.text?.length) query.text = answer.text;
  if (answer.states?.length) query.states = answer.states as FleetQuery["states"];
  if (answer.lastHeardOlderThan) query.lastHeardOlderThan = toSeconds(answer.lastHeardOlderThan);
  if (answer.lastHeardWithin) query.lastHeardWithin = toSeconds(answer.lastHeardWithin);
  if (answer.batteryBelow !== null) query.batteryBelow = answer.batteryBelow;
  if (answer.batteryAtLeast !== null) query.batteryAtLeast = answer.batteryAtLeast;
  if (answer.externallyPowered !== null) query.externallyPowered = answer.externallyPowered;
  if (answer.roles?.length) query.roles = answer.roles;
  if (answer.hardware?.length) query.hardware = answer.hardware;
  if (answer.adminCapability?.length) {
    query.adminCapability = answer.adminCapability as FleetQuery["adminCapability"];
  }
  if (answer.signal?.length) query.signal = answer.signal as FleetQuery["signal"];
  if (answer.hopsAtMost !== null) query.hopsAtMost = answer.hopsAtMost;
  if (answer.hopsAtLeast !== null) query.hopsAtLeast = answer.hopsAtLeast;
  if (answer.firmwareBelow) query.firmwareBelow = answer.firmwareBelow;
  if (answer.sortBy) {
    // A direction without a key means nothing; a key without one takes the
    // ascending order, which the instructions define per key.
    query.sort = { key: answer.sortBy, direction: answer.sortDirection ?? "asc" };
  }
  if (answer.limit !== null) query.limit = answer.limit;
  return query;
}

/** Start of the current UTC day, epoch seconds. The budget resets there. */
function startOfUtcDay(now = Date.now()): number {
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  return Math.floor(day.getTime() / 1000);
}

/**
 * Turns whatever the SDK threw into a status and a sentence an operator can
 * act on. Never includes request headers, which is where the key travels.
 */
function classify(cause: unknown, config: AssistantConfig): AssistantError {
  const inner = RetryError.isInstance(cause) ? cause.lastError : cause;

  if (inner instanceof Error && (inner.name === "TimeoutError" || inner.name === "AbortError")) {
    return new AssistantError(
      504,
      `No answer from ${config.provider} within ${config.timeout}s. Try again, or raise llm.timeout.`,
    );
  }
  if (NoObjectGeneratedError.isInstance(inner)) {
    return new AssistantError(
      502,
      "The model's answer did not fit the expected shape. Try rephrasing the question.",
    );
  }
  if (APICallError.isInstance(inner)) {
    const status = inner.statusCode;
    if (status === 429) {
      return new AssistantError(
        429,
        `${config.provider} is refusing requests for now: a rate limit or the free tier's daily quota. Try again later.`,
      );
    }
    if (status === 401 || status === 403) {
      return new AssistantError(
        502,
        `${config.provider} rejected the API key (HTTP ${status}). Check the key in the server's config.`,
      );
    }
    if (status === 404) {
      return new AssistantError(
        502,
        `${config.provider} does not know the model "${config.model}". Check llm.model in the server's config.`,
      );
    }
    return new AssistantError(
      502,
      status === undefined
        ? `Could not reach ${config.provider}: ${inner.message}`
        : `${config.provider} answered with an error (HTTP ${status}).`,
    );
  }
  return new AssistantError(
    502,
    `The question could not be put to ${config.provider}: ${inner instanceof Error ? inner.message : String(inner)}`,
  );
}

export interface AssistantOptions {
  config: AssistantConfig;
  queries: AssistantQueryRepository;
  logger: FastifyBaseLogger;
  staleAfter: number;
  offlineAfter: number;
}

export class Assistant {
  private readonly model: LanguageModel;
  private readonly instructions: string;

  constructor(private readonly options: AssistantOptions) {
    this.model = createModel(options.config);
    this.instructions = instructions(options.staleAfter, options.offlineAfter);
  }

  get provider(): string {
    return this.options.config.provider;
  }

  get modelName(): string {
    return this.options.config.model;
  }

  /**
   * Answers one question, records it, and enforces the daily budget.
   *
   * The budget is checked before the call against what is already spent, so
   * the last question of the day may run over it by one question's worth --
   * a couple of thousand tokens -- rather than being refused on an estimate.
   */
  async ask(username: string, prompt: string): Promise<AskResponse> {
    const { config, queries, logger } = this.options;

    if (config.dailyTokenBudget > 0) {
      const spent = queries.tokensSince(startOfUtcDay());
      if (spent >= config.dailyTokenBudget) {
        throw new AssistantError(
          429,
          `Today's assistant budget of ${config.dailyTokenBudget.toLocaleString("en-US")} tokens is used up. It resets at 00:00 UTC.`,
        );
      }
    }

    const started = Date.now();
    let outcome: AssistantOutcome = "failed";
    let query: FleetQuery | null = null;
    let note: string | null = null;
    let errorText: string | null = null;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;

    try {
      const result = await generateText({
        model: this.model,
        system: this.instructions,
        prompt,
        output: Output.object({
          schema: answerSchema,
          name: "fleet_filter",
          description: "A filter over the fleet list that answers the operator's question.",
        }),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        // None. The SDK retries 429s with a backoff, which spends a free
        // tier's quota re-sending a request that was refused for exceeding it,
        // and its waiting runs into our timeout so the operator is told
        // "no answer" instead of "rate limited". Asking again is one click.
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(config.timeout * 1000),
      });

      inputTokens = result.usage.inputTokens ?? null;
      outputTokens = result.usage.outputTokens ?? null;

      const answer = result.output;
      note = answer.note?.trim() || null;
      if (answer.understood) {
        outcome = "answered";
        query = toFleetQuery(answer);
      } else {
        outcome = "not_understood";
        note ??= "That does not look like a question about the fleet.";
      }
      return { query, note };
    } catch (cause) {
      // An answer that did not parse was still generated, and billed.
      // Without this the budget would undercount exactly the questions a
      // weak model keeps failing on.
      if (NoObjectGeneratedError.isInstance(cause) && cause.usage) {
        inputTokens = cause.usage.inputTokens ?? null;
        outputTokens = cause.usage.outputTokens ?? null;
      }
      const error = classify(cause, config);
      errorText = error.message;
      throw error;
    } finally {
      const durationMs = Date.now() - started;
      queries.record({
        username,
        prompt,
        provider: config.provider,
        model: config.model,
        outcome,
        query,
        note,
        errorText,
        inputTokens,
        outputTokens,
        durationMs,
      });
      // The prompt is in the audit table; the log line carries the cost.
      const line = {
        username,
        outcome,
        provider: config.provider,
        model: config.model,
        inputTokens,
        outputTokens,
        durationMs,
      };
      if (outcome === "failed") {
        logger.warn({ ...line, error: errorText }, "assistant question failed");
      } else {
        logger.info(line, "assistant question answered");
      }
    }
  }
}
