import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";
import { verifyPassword } from "./config.js";

/**
 * Session auth for a single shared password.
 *
 * Sessions are held in memory, so a restart logs everyone out. For a
 * single-operator tool that is the right trade: no session table to
 * migrate, no expiry sweep to get wrong, and no way for a stolen cookie to
 * outlive the process. Revisit if this ever grows real user accounts.
 */

const COOKIE_NAME = "mfm_session";

/** Slows down password guessing without needing a rate-limit dependency. */
const FAILED_LOGIN_DELAY_MS = 750;

interface Session {
  expiresAt: number;
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly ttlSeconds: number) {}

  create(): string {
    const id = randomBytes(32).toString("hex");
    this.sessions.set(id, { expiresAt: Date.now() + this.ttlSeconds * 1000 });
    this.prune();
    return id;
  }

  isValid(id: string | undefined): boolean {
    if (!id) return false;
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      return false;
    }
    return true;
  }

  destroy(id: string | undefined): void {
    if (id) this.sessions.delete(id);
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
  }
}

export interface AuthContext {
  store: SessionStore;
  config: AppConfig;
}

function readSessionId(request: FastifyRequest): string | undefined {
  const raw = request.cookies[COOKIE_NAME];
  if (!raw) return undefined;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid ? (unsigned.value ?? undefined) : undefined;
}

export function isAuthenticated(
  request: FastifyRequest,
  auth: AuthContext,
): boolean {
  return auth.store.isValid(readSessionId(request));
}

/**
 * Guard for every route that exposes fleet data. Registered as an
 * `onRequest` hook on the API scope rather than per route, so adding a
 * route cannot accidentally leave it unauthenticated.
 */
export function requireSession(auth: AuthContext) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!isAuthenticated(request, auth)) {
      await reply.status(401).send({ error: "authentication required" });
    }
  };
}

export function registerAuthRoutes(
  app: FastifyInstance,
  auth: AuthContext,
): void {
  app.get("/api/session", async (request) => ({
    authenticated: isAuthenticated(request, auth),
  }));

  app.post<{ Body: { password?: string } }>(
    "/api/session",
    async (request, reply) => {
      const password = request.body?.password;

      if (typeof password !== "string" || password.length === 0) {
        return reply.status(400).send({ error: "password is required" });
      }

      if (!verifyPassword(password, auth.config.passwordHash)) {
        await new Promise((resolve) =>
          setTimeout(resolve, FAILED_LOGIN_DELAY_MS),
        );
        request.log.warn({ ip: request.ip }, "failed login attempt");
        return reply.status(401).send({ error: "incorrect password" });
      }

      const id = auth.store.create();
      return reply
        .setCookie(COOKIE_NAME, id, {
          path: "/",
          httpOnly: true,
          sameSite: "strict",
          secure: auth.config.server.secure_cookies,
          signed: true,
          maxAge: auth.config.server.session_ttl,
        })
        .send({ authenticated: true });
    },
  );

  app.delete("/api/session", async (request, reply) => {
    auth.store.destroy(readSessionId(request));
    return reply
      .clearCookie(COOKIE_NAME, { path: "/" })
      .send({ authenticated: false });
  });
}
