import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";
import { hashPassword, verifyPassword } from "./config.js";
import type { UserRepository } from "./db/repositories/users.js";
import type { SessionUser } from "../shared/types.js";
import {
  BUILT_IN_ADMIN_USERNAME,
  canAdminister,
  canOperateRadio,
  type UserRole,
} from "../shared/roles.js";

/**
 * Session auth for named accounts.
 *
 * Sessions live in memory, so a restart signs everyone out. For a
 * single-operator tool that remains the right trade: no session table to
 * migrate, no expiry sweep to get wrong, and no way for a stolen cookie to
 * outlive the process.
 *
 * The `admin` account comes from config.yaml rather than the database, so
 * the console is reachable even when the database is empty, restored from
 * a backup, or has had its last admin deleted.
 */

const COOKIE_NAME = "mfm_session";

/** Slows down password guessing without needing a rate-limit dependency. */
const FAILED_LOGIN_DELAY_MS = 750;

interface Session {
  user: SessionUser;
  expiresAt: number;
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly ttlSeconds: number) {}

  create(user: SessionUser): string {
    const id = randomBytes(32).toString("hex");
    this.sessions.set(id, {
      user,
      expiresAt: Date.now() + this.ttlSeconds * 1000,
    });
    this.prune();
    return id;
  }

  get(id: string | undefined): SessionUser | null {
    if (!id) return null;
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      return null;
    }
    return session.user;
  }

  destroy(id: string | undefined): void {
    if (id) this.sessions.delete(id);
  }

  /**
   * Ends every session belonging to a user. Called when an account is
   * deleted, demoted, or has its password reset -- otherwise a revoked
   * account keeps its access until its cookie happens to expire, which is
   * the whole point of being able to revoke it.
   */
  revokeUser(username: string): number {
    let revoked = 0;
    for (const [id, session] of this.sessions) {
      if (session.user.username.toLowerCase() === username.toLowerCase()) {
        this.sessions.delete(id);
        revoked += 1;
      }
    }
    return revoked;
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
  users: UserRepository;
}

function readSessionId(request: FastifyRequest): string | undefined {
  const raw = request.cookies[COOKIE_NAME];
  if (!raw) return undefined;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid ? (unsigned.value ?? undefined) : undefined;
}

export function currentUser(
  request: FastifyRequest,
  auth: AuthContext,
): SessionUser | null {
  return auth.store.get(readSessionId(request));
}

/**
 * Guard for every route that exposes fleet data. Registered as an
 * `onRequest` hook on the API scope rather than per route, so adding a
 * route cannot accidentally leave it unauthenticated.
 */
export function requireSession(auth: AuthContext) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!currentUser(request, auth)) {
      await reply.status(401).send({ error: "authentication required" });
    }
  };
}

/**
 * Per-route capability check. Returns the user when allowed, and answers
 * 403 itself when not, so handlers read as a single early return.
 *
 * Authorization is enforced here and nowhere else that matters: the UI
 * hides what a role cannot do, but that is an affordance, not a control.
 */
export function requireCapability(
  auth: AuthContext,
  capability: "operate" | "administer",
) {
  return async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<SessionUser | null> => {
    const user = currentUser(request, auth);
    if (!user) {
      await reply.status(401).send({ error: "authentication required" });
      return null;
    }

    const allowed =
      capability === "administer"
        ? canAdminister(user.role)
        : canOperateRadio(user.role);

    if (!allowed) {
      request.log.warn(
        { username: user.username, role: user.role, capability },
        "request refused: insufficient role",
      );
      await reply.status(403).send({
        error:
          capability === "administer"
            ? "this action requires the admin role"
            : "this action requires the manager or admin role",
      });
      return null;
    }
    return user;
  };
}

/** Resolves credentials against the built-in admin, then the database. */
function authenticate(
  auth: AuthContext,
  username: string,
  password: string,
): SessionUser | null {
  if (username.toLowerCase() === BUILT_IN_ADMIN_USERNAME) {
    if (!verifyPassword(password, auth.config.passwordHash)) return null;
    return { username: BUILT_IN_ADMIN_USERNAME, role: "admin", builtIn: true };
  }

  const found = auth.users.findByUsername(username);
  if (!found) {
    // Hash anyway so a missing account takes the same time as a wrong
    // password; otherwise the response time enumerates valid usernames.
    hashPassword(password);
    return null;
  }
  if (!verifyPassword(password, found.passwordHash)) return null;

  auth.users.recordLogin(found.user.id);
  return {
    username: found.user.username,
    role: found.user.role as UserRole,
    builtIn: false,
  };
}

export function registerAuthRoutes(
  app: FastifyInstance,
  auth: AuthContext,
): void {
  app.get("/api/session", async (request) => {
    const user = currentUser(request, auth);
    return { authenticated: user !== null, user };
  });

  app.post<{ Body: { username?: string; password?: string } }>(
    "/api/session",
    async (request, reply) => {
      const username = request.body?.username?.trim();
      const password = request.body?.password;

      if (!username || typeof password !== "string" || password.length === 0) {
        return reply
          .status(400)
          .send({ error: "username and password are required" });
      }

      const user = authenticate(auth, username, password);
      if (!user) {
        await new Promise((resolve) =>
          setTimeout(resolve, FAILED_LOGIN_DELAY_MS),
        );
        request.log.warn({ ip: request.ip, username }, "failed login attempt");
        // Deliberately does not say which half was wrong.
        return reply.status(401).send({ error: "incorrect username or password" });
      }

      const id = auth.store.create(user);
      return reply
        .setCookie(COOKIE_NAME, id, {
          path: "/",
          httpOnly: true,
          sameSite: "strict",
          secure: auth.config.server.secure_cookies,
          signed: true,
          maxAge: auth.config.server.session_ttl,
        })
        .send({ authenticated: true, user });
    },
  );

  app.delete("/api/session", async (request, reply) => {
    auth.store.destroy(readSessionId(request));
    return reply
      .clearCookie(COOKIE_NAME, { path: "/" })
      .send({ authenticated: false, user: null });
  });
}
