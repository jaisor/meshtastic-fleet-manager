import type { FastifyInstance } from "fastify";
import { hashPassword } from "../config.js";
import type { Db } from "../db/index.js";
import {
  DuplicateUsernameError,
  type UserRepository,
} from "../db/repositories/users.js";
import { requireCapability, type AuthContext } from "../auth.js";
import {
  BUILT_IN_ADMIN_USERNAME,
  isUserRole,
  type UserRole,
} from "../../shared/roles.js";

/**
 * Account management and the destructive maintenance actions.
 *
 * Everything here requires the admin role, checked per handler rather than
 * by a scope-wide hook, because these live alongside routes that managers
 * and viewers legitimately reach.
 */

const MIN_PASSWORD_LENGTH = 8;
const MAX_USERNAME_LENGTH = 32;

export interface AdminDependencies {
  auth: AuthContext;
  users: UserRepository;
  db: Db;
}

function validateUsername(raw: unknown): { value: string } | { error: string } {
  const username = String(raw ?? "").trim();
  if (username.length === 0) return { error: "username is required" };
  if (username.length > MAX_USERNAME_LENGTH) {
    return { error: `username must be at most ${MAX_USERNAME_LENGTH} characters` };
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
    return {
      error: "username may contain only letters, digits, dot, dash and underscore",
    };
  }
  if (username.toLowerCase() === BUILT_IN_ADMIN_USERNAME) {
    return {
      error:
        "\"admin\" is reserved for the account defined in config.yaml; change its password there",
    };
  }
  return { value: username };
}

function validatePassword(raw: unknown): { value: string } | { error: string } {
  const password = String(raw ?? "");
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  return { value: password };
}

export function registerAdminRoutes(
  app: FastifyInstance,
  deps: AdminDependencies,
): void {
  const requireAdmin = requireCapability(deps.auth, "administer");

  app.get("/api/users", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return reply;
    return { users: deps.users.list() };
  });

  app.post<{ Body: { username?: string; password?: string; role?: string } }>(
    "/api/users",
    async (request, reply) => {
      if (!(await requireAdmin(request, reply))) return reply;

      const username = validateUsername(request.body?.username);
      if ("error" in username) {
        return reply.status(400).send({ error: username.error });
      }
      const password = validatePassword(request.body?.password);
      if ("error" in password) {
        return reply.status(400).send({ error: password.error });
      }
      if (!isUserRole(request.body?.role)) {
        return reply.status(400).send({ error: "role must be admin, manager or viewer" });
      }

      try {
        const created = deps.users.create(
          username.value,
          hashPassword(password.value),
          request.body.role as UserRole,
        );
        request.log.info(
          { username: created.username, role: created.role },
          "user account created",
        );
        return reply.status(201).send({ user: created });
      } catch (cause) {
        if (cause instanceof DuplicateUsernameError) {
          return reply.status(409).send({ error: cause.message });
        }
        throw cause;
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: { role?: string; password?: string } }>(
    "/api/users/:id",
    async (request, reply) => {
      const actor = await requireAdmin(request, reply);
      if (!actor) return reply;

      const id = Number(request.params.id);
      const target = Number.isInteger(id) ? deps.users.get(id) : null;
      if (!target) return reply.status(404).send({ error: "unknown user" });

      const changes: string[] = [];

      if (request.body?.role !== undefined) {
        if (!isUserRole(request.body.role)) {
          return reply
            .status(400)
            .send({ error: "role must be admin, manager or viewer" });
        }
        deps.users.setRole(id, request.body.role);
        changes.push(`role=${request.body.role}`);
      }

      if (request.body?.password !== undefined) {
        const password = validatePassword(request.body.password);
        if ("error" in password) {
          return reply.status(400).send({ error: password.error });
        }
        deps.users.setPassword(id, hashPassword(password.value));
        changes.push("password reset");
      }

      if (changes.length === 0) {
        return reply.status(400).send({ error: "nothing to change" });
      }

      // A role change or password reset has to take effect now. Leaving the
      // old session alive would let a demoted account keep its former
      // permissions until the cookie happened to expire.
      const revoked = deps.auth.store.revokeUser(target.username);
      request.log.info(
        { by: actor.username, user: target.username, changes, revoked },
        "user account updated; sessions revoked",
      );

      return { user: deps.users.get(id), sessionsRevoked: revoked };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/users/:id",
    async (request, reply) => {
      const actor = await requireAdmin(request, reply);
      if (!actor) return reply;

      const id = Number(request.params.id);
      const target = Number.isInteger(id) ? deps.users.get(id) : null;
      if (!target) return reply.status(404).send({ error: "unknown user" });

      if (target.username.toLowerCase() === actor.username.toLowerCase()) {
        return reply
          .status(409)
          .send({ error: "you cannot delete the account you are signed in as" });
      }

      deps.users.delete(id);
      const revoked = deps.auth.store.revokeUser(target.username);
      request.log.warn(
        { by: actor.username, user: target.username, revoked },
        "user account deleted",
      );
      return { deleted: true, sessionsRevoked: revoked };
    },
  );

  /**
   * Clears collected mesh data.
   *
   * `scope=nodes` drops the fleet itself, taking telemetry and positions
   * with it through the foreign keys. `scope=history` keeps the nodes and
   * clears only their readings, which is the one people actually want when
   * a database has grown large.
   *
   * Neither touches accounts or the schema. Discovery starts again from
   * whatever the radio hears next -- and on the next reconnect the radio
   * hands over its own node database, so a wiped fleet usually repopulates
   * within seconds rather than being gone for good.
   */
  app.post<{ Body: { scope?: string; confirm?: string } }>(
    "/api/admin/purge",
    async (request, reply) => {
      const actor = await requireAdmin(request, reply);
      if (!actor) return reply;

      const scope = request.body?.scope;
      if (scope !== "nodes" && scope !== "history") {
        return reply.status(400).send({ error: "scope must be nodes or history" });
      }

      // Typed confirmation, because the button alone is one misclick away
      // from deleting everything the fleet has collected.
      if (request.body?.confirm !== scope) {
        return reply
          .status(400)
          .send({ error: `type "${scope}" to confirm this deletion` });
      }

      const result = deps.db.transaction(() => {
        const telemetry = deps.db.prepare("DELETE FROM telemetry").run().changes;
        const positions = deps.db.prepare("DELETE FROM positions").run().changes;
        if (scope === "history") {
          return { nodes: 0, telemetry, positions, operations: 0 };
        }
        const operations = deps.db
          .prepare("DELETE FROM admin_operations")
          .run().changes;
        const nodes = deps.db.prepare("DELETE FROM nodes").run().changes;
        return { nodes, telemetry, positions, operations };
      })();

      request.log.warn(
        { by: actor.username, scope, ...result },
        "mesh data purged by administrator",
      );
      return { purged: result };
    },
  );
}
