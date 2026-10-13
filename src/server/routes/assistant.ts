import type { FastifyInstance } from "fastify";
import { requireCapability, type AuthContext } from "../auth.js";
import { Assistant, AssistantError, MAX_PROMPT_LENGTH } from "../assistant/index.js";
import type { AskResponse } from "../../shared/types.js";

export interface AssistantRouteDependencies {
  auth: AuthContext;
  /** Null when `llm.enabled` is off. */
  assistant: Assistant | null;
}

/**
 * One question in, one filter out. Touches neither the radio nor the
 * database's mesh tables, so it works with the radio unplugged; what it
 * needs is the provider, and its failures name the provider rather than the
 * radio.
 */
export function registerAssistantRoutes(
  app: FastifyInstance,
  deps: AssistantRouteDependencies,
): void {
  // Manager and admin only: every question is billed to the server owner.
  const requireAsker = requireCapability(deps.auth, "ask");

  app.post<{ Body: { prompt?: unknown } }>("/api/ask", async (request, reply) => {
    const user = await requireAsker(request, reply);
    if (!user) return reply;

    if (!deps.assistant) {
      return reply
        .status(503)
        .send({ error: "The assistant is not configured. Set llm.enabled in config.yaml." });
    }

    const prompt = typeof request.body?.prompt === "string" ? request.body.prompt.trim() : "";
    if (!prompt) {
      return reply.status(400).send({ error: "Ask a question first." });
    }
    if (prompt.length > MAX_PROMPT_LENGTH) {
      return reply
        .status(400)
        .send({ error: `Keep the question under ${MAX_PROMPT_LENGTH} characters.` });
    }

    try {
      return (await deps.assistant.ask(user.username, prompt)) satisfies AskResponse;
    } catch (cause) {
      if (cause instanceof AssistantError) {
        return reply.status(cause.status).send({ error: cause.message });
      }
      throw cause;
    }
  });
}
