import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { ConfigError, loadConfig } from "./config.js";
import { openDatabase } from "./db/index.js";
import { NodeRepository } from "./db/repositories/nodes.js";
import { AdminOperationRepository } from "./db/repositories/adminOperations.js";
import { MeshListener } from "./mesh/listener.js";
import { attachIngest } from "./mesh/ingest.js";
import { AdminClient } from "./mesh/admin.js";
import { CapabilityProber } from "./mesh/capability.js";
import { registerAuthRoutes, requireSession, SessionStore } from "./auth.js";
import { registerApiRoutes } from "./routes/api.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * `/config/config.yaml` is the container mount point. Falling back to the
 * repo's own `config/` means `npm run dev` works with no environment
 * juggling, and MFM_CONFIG still overrides both.
 */
function resolveConfigPath(): string {
  if (process.env.MFM_CONFIG) return resolve(process.env.MFM_CONFIG);
  const mounted = "/config/config.yaml";
  if (existsSync(mounted)) return mounted;
  return resolve("config/config.yaml");
}

const CONFIG_PATH = resolveConfigPath();

/** History prune cadence. Cheap, so daily is plenty. */
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(CONFIG_PATH);
  } catch (cause) {
    if (cause instanceof ConfigError) {
      // Before the logger exists, so plain stderr.
      process.stderr.write(`${cause.message}\n`);
      process.exit(1);
    }
    throw cause;
  }

  const app = Fastify({
    logger: { level: config.logging.level },
    trustProxy: true,
  });

  if (!config.server.session_secret) {
    app.log.warn(
      "no server.session_secret configured; sessions will not survive a restart",
    );
  }

  const db = openDatabase(config.database.path);
  const nodes = new NodeRepository(db, {
    staleAfter: config.fleet.stale_after,
    offlineAfter: config.fleet.offline_after,
  });
  const operations = new AdminOperationRepository(db);

  // Anything still pending belongs to a previous process and has no waiter.
  const abandoned = operations.failAllPending("interrupted by server restart");
  if (abandoned > 0) {
    app.log.warn({ abandoned }, "marked orphaned admin operations as failed");
  }

  const listener = new MeshListener({
    portPath: config.serial.port,
    baud: config.serial.baud,
    backoff: config.serial.reconnect_backoff,
    enabled: config.serial.enabled,
    logger: app.log,
  });
  attachIngest(listener, nodes, app.log);

  const admin = new AdminClient({
    listener,
    logger: app.log,
    timeout: config.fleet.admin_probe_timeout,
  });
  admin.attach();

  const prober = new CapabilityProber({
    nodes,
    admin,
    listener,
    logger: app.log,
    interval: config.fleet.admin_probe_interval,
  });

  await app.register(cookie, { secret: config.sessionSecret });

  const auth = { store: new SessionStore(config.server.session_ttl), config };
  registerAuthRoutes(app, auth);

  // Every fleet route behind one hook, so a new route cannot be added
  // unauthenticated by forgetting a decorator.
  await app.register(async (scope) => {
    scope.addHook("onRequest", requireSession(auth));
    registerApiRoutes(scope, {
      config,
      nodes,
      operations,
      listener,
      admin,
      prober,
    });
  });

  await registerWebUi(app);

  if (config.serial.enabled) {
    listener.start();
    prober.start();
  } else {
    app.log.warn("serial.enabled is false; running without a radio");
  }

  const pruneTimer = setInterval(() => {
    const removed = nodes.pruneHistory(config.fleet.telemetry_retention);
    if (removed > 0) app.log.info({ removed }, "pruned history rows");
  }, PRUNE_INTERVAL_MS);
  pruneTimer.unref();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    clearInterval(pruneTimer);
    prober.stop();
    await listener.stop();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  try {
    await app.listen({ port: config.server.port, host: config.server.host });
  } catch (cause) {
    // A bare EADDRINUSE stack is a poor way to learn that something else
    // owns the port -- and in dev the Vite proxy will cheerfully forward
    // to whatever that something else is, so the browser shows a stranger's
    // HTTP errors instead of ours. Name the problem.
    if ((cause as NodeJS.ErrnoException).code === "EADDRINUSE") {
      app.log.fatal(
        `port ${config.server.port} is already in use by another process; ` +
          "change server.port in the config file, or stop whatever is holding it",
      );
      process.exit(1);
    }
    throw cause;
  }

  // Only armed once the console is actually serving. A crash before this
  // point is a startup bug and should still be loud and fatal.
  installCrashGuard(app, listener, config.serial.enabled);
}

/**
 * Keeps the console serving when something in the mesh stack throws where
 * nobody can catch it.
 *
 * This is a deliberate exception to "never swallow an uncaught exception".
 * The serial path runs through a pre-1.0 dependency over a native binding,
 * and a device being absent, busy, or yanked mid-write is routine rather
 * than exceptional. An operator losing the whole console -- including the
 * history already in SQLite, and any explanation of what went wrong --
 * because a USB port misbehaved is the worse failure.
 *
 * The bargain: nothing is silent. Every catch is logged at fatal with the
 * stack, the radio is dropped back into its reconnect loop, and the reason
 * surfaces in the UI's degraded banner. It is armed only after the HTTP
 * server is listening, so startup bugs still exit non-zero.
 */
function installCrashGuard(
  app: FastifyInstance,
  listener: MeshListener,
  serialEnabled: boolean,
): void {
  const recover = (kind: string, cause: unknown): void => {
    app.log.fatal(
      { err: cause instanceof Error ? cause.stack : String(cause), kind },
      "uncaught failure; console stays up in degraded mode",
    );
    if (!serialEnabled) return;
    // Cycle the listener so it re-enters its backoff loop rather than
    // sitting in whatever half-torn-down state the throw left behind.
    void listener
      .stop()
      .catch(() => {})
      .then(() => listener.start());
  };

  process.on("uncaughtException", (cause) => recover("uncaughtException", cause));
  process.on("unhandledRejection", (cause) => recover("unhandledRejection", cause));
}

/**
 * Serves the built web UI when it exists, and falls back to `index.html`
 * for unknown paths so the client router survives a hard refresh on
 * `/nodes/!a4c138f0`. In dev the UI is served by Vite instead, so a
 * missing `dist/web` is normal rather than an error.
 */
async function registerWebUi(app: FastifyInstance): Promise<void> {
  const webRoot = join(here, "..", "web");
  if (!existsSync(join(webRoot, "index.html"))) {
    app.log.warn(
      { webRoot },
      "no built web UI found; run `npm run build:web` or use the Vite dev server",
    );
    return;
  }

  await app.register(fastifyStatic, { root: webRoot });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.status(404).send({ error: "not found" });
    }
    return reply.sendFile("index.html");
  });
}

main().catch((cause: unknown) => {
  process.stderr.write(`fatal: ${(cause as Error).stack ?? String(cause)}\n`);
  process.exit(1);
});
