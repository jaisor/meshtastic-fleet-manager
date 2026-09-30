import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import type { NodeRepository } from "../db/repositories/nodes.js";
import type { AdminOperationRepository } from "../db/repositories/adminOperations.js";
import { AdminError, type AdminClient } from "../mesh/admin.js";
import type { CapabilityProber } from "../mesh/capability.js";
import type { MeshListener } from "../mesh/listener.js";
import { TaskCancelledError, type RadioTaskRegistry } from "../mesh/tasks.js";
import { describeRules, isRestricted } from "../mesh/discovery.js";
import { requireCapability, type AuthContext } from "../auth.js";
import type { NodeEnricher } from "../mesh/enrich.js";
import { logNode, parseNodeId } from "../mesh/nodeId.js";
import type { NodeConfigUpdate, RadioOccupancy } from "../../shared/types.js";

/**
 * Read paths serve straight from SQLite -- never from the radio -- so the
 * UI stays responsive and useful while the mesh is slow or the radio is
 * unplugged. Only the write path in `PATCH /api/nodes/:id/config` touches
 * the mesh, and it reports its own outcome.
 */

/**
 * The radio is exclusive, so every operation can be refused because another
 * one holds it. 409 rather than 503: 503 is "there is no radio", this is "the
 * radio is here and busy", and an operator needs to tell those apart. The
 * message names the occupant, because "busy" alone leaves nothing to do but
 * click again.
 */
function busyError(occupant: RadioOccupancy | null): { error: string } {
  if (!occupant) {
    // It finished between the refusal and this call. Rare, and there is
    // nothing useful to name, so say the one thing that is certainly true.
    return { error: "The radio was busy with another operation. Try again." };
  }

  const what = `${occupant.label.toLowerCase()} on ${occupant.nodeName ?? occupant.nodeId}`;
  // Background work has no banner entry, so telling someone to cancel it there
  // would send them looking for a control that does not exist.
  return {
    error: occupant.background
      ? `The radio is busy in the background: ${what}. This clears on its own in a few seconds — try again shortly.`
      : `The radio is busy: ${what}. Wait for it to finish, or cancel it from the banner at the top of the page.`,
  };
}

const TELEMETRY_LIMIT = 200;
const POSITION_LIMIT = 100;
const OPERATION_LIMIT = 20;

export interface ApiDependencies {
  config: AppConfig;
  nodes: NodeRepository;
  operations: AdminOperationRepository;
  listener: MeshListener;
  admin: AdminClient;
  prober: CapabilityProber;
  tasks: RadioTaskRegistry;
  auth: AuthContext;
  enricher: NodeEnricher;
}

export function registerApiRoutes(
  app: FastifyInstance,
  deps: ApiDependencies,
): void {
  // Anything that puts the radio to work needs manager or admin. Reads are
  // open to every signed-in role, including viewer.
  const requireOperator = requireCapability(deps.auth, "operate");

  app.get("/api/status", async () => ({
    radio: deps.listener.getStatus(),
    staleAfter: deps.config.fleet.stale_after,
    // Polled by the UI to drive the "radio busy" banner, so this endpoint
    // is also what makes a long operation visible from any page.
    tasks: deps.tasks.list(),
    // Separate from `tasks` on purpose: this one includes background sweeps,
    // so the UI can disable a control the server would refuse even though
    // nothing is in the banner.
    radioBusy: deps.tasks.occupancy(),
    discovery: {
      restricted: isRestricted(deps.config.discoveryRules),
      description: describeRules(deps.config.discoveryRules),
    },
  }));

  /**
   * Stops waiting on an operation and releases the radio.
   *
   * Cancelling cannot recall a packet already transmitted; what it does is
   * abandon the wait, so a late reply is simply ignored. Returns 409 when
   * the task already finished, which the UI can lose fairly: the banner is
   * polled, so an operation may complete between a poll and the click.
   */
  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/cancel",
    async (request, reply) => {
      if (!(await requireOperator(request, reply))) return reply;

      const id = Number(request.params.id);
      if (!Number.isInteger(id)) {
        return reply.status(400).send({ error: "malformed task id" });
      }
      if (!deps.tasks.cancel(id)) {
        return reply.status(409).send({ error: "task already finished" });
      }
      request.log.info({ taskId: id }, "radio task cancelled by operator");
      return { cancelled: true };
    },
  );

  app.get("/api/nodes", async () => ({ nodes: deps.nodes.list() }));

  app.get<{ Params: { id: string } }>(
    "/api/nodes/:id",
    async (request, reply) => {
      const nodeNum = parseNodeId(request.params.id);
      if (nodeNum === null) {
        return reply.status(400).send({ error: "malformed node id" });
      }

      const node = deps.nodes.get(nodeNum);
      if (!node) {
        return reply.status(404).send({ error: "unknown node" });
      }

      return {
        node,
        telemetry: deps.nodes.telemetryFor(nodeNum, TELEMETRY_LIMIT),
        positions: deps.nodes.positionsFor(nodeNum, POSITION_LIMIT),
        operations: deps.operations.recentFor(nodeNum, OPERATION_LIMIT),
        config: deps.nodes.configFor(nodeNum),
      };
    },
  );

  /**
   * Reads a remote node's radio and module settings over the mesh.
   *
   * On demand rather than swept, because unlike the admin probe this is four
   * round trips and nothing about it expires -- settings change when someone
   * changes them, not on a schedule. Polling the fleet for config would spend
   * most of the duty cycle re-learning constants.
   *
   * The local radio needs none of this: its own dump arrives over USB on
   * every connect, so its row is already there and this refuses rather than
   * sending an admin message to ourselves.
   */
  app.post<{ Params: { id: string } }>(
    "/api/nodes/:id/config/read",
    async (request, reply) => {
      if (!(await requireOperator(request, reply))) return reply;

      const nodeNum = parseNodeId(request.params.id);
      if (nodeNum === null) {
        return reply.status(400).send({ error: "malformed node id" });
      }
      const node = deps.nodes.get(nodeNum);
      if (!node) return reply.status(404).send({ error: "unknown node" });
      if (node.isLocal) {
        return reply.status(400).send({
          error: "the local node reports its own settings over USB",
        });
      }
      if (!deps.listener.getDevice()) {
        return reply.status(503).send({ error: "local radio is not connected" });
      }

      const started = deps.tasks.start({
        kind: "readConfig",
        label: "Reading radio settings",
        nodeNum,
        nodeName: node.longName ?? node.shortName ?? null,
        // Four sequential reads, each able to run out its own admin timeout.
        timeoutSeconds: deps.config.fleet.admin_probe_timeout * 4,
      });

      if (!started) {
        return reply.status(409).send(busyError(deps.tasks.occupancy()));
      }
      const { task, signal } = started;

      try {
        const { config, outcome } = await deps.admin.readRadioConfig(
          nodeNum,
          signal,
        );

        // Nothing came back at all: leave any previous snapshot alone rather
        // than replacing it with a row of blanks stamped with now.
        if (!outcome.lora && !outcome.device && !outcome.position && !outcome.telemetry) {
          return reply.status(502).send({
            error: "the node did not answer any settings request",
            outcome,
          });
        }

        deps.nodes.saveConfig(nodeNum, config);
        // Answering an admin read is proof of admin rights, so record it --
        // otherwise the badge can still read "unprobed" next to settings that
        // could only have been obtained with those rights.
        deps.nodes.setAdminCapability(nodeNum, "capable");
        request.log.info({ ...logNode(nodeNum), outcome }, "radio settings read");
        return { outcome, config };
      } catch (cause) {
        if (cause instanceof TaskCancelledError) {
          return reply.status(409).send({ error: "settings read cancelled" });
        }
        if (cause instanceof AdminError) {
          if (cause.capability !== "unknown") {
            deps.nodes.setAdminCapability(nodeNum, cause.capability);
          }
          return reply.status(502).send({ error: cause.message });
        }
        throw cause;
      } finally {
        deps.tasks.finish(task.id);
      }
    },
  );

  /**
   * Re-probes admin capability for one node on demand, because waiting out
   * the sweep interval after fixing a node's `adminKey` is a bad workflow.
   */
  app.post<{ Params: { id: string } }>(
    "/api/nodes/:id/probe",
    async (request, reply) => {
      if (!(await requireOperator(request, reply))) return reply;

      const nodeNum = parseNodeId(request.params.id);
      if (nodeNum === null) {
        return reply.status(400).send({ error: "malformed node id" });
      }
      if (!deps.nodes.get(nodeNum)) {
        return reply.status(404).send({ error: "unknown node" });
      }
      if (!deps.listener.getDevice()) {
        return reply.status(503).send({ error: "local radio is not connected" });
      }

      const node = deps.nodes.get(nodeNum);
      const started = deps.tasks.start({
        kind: "probe",
        label: "Checking admin access",
        nodeNum,
        nodeName: node?.longName ?? node?.shortName ?? null,
        timeoutSeconds: deps.config.fleet.admin_probe_timeout,
      });

      if (!started) {
        return reply.status(409).send(busyError(deps.tasks.occupancy()));
      }
      const { task, signal } = started;

      // Drop the cached session passkey so the probe is a real round trip and
      // not a verdict inferred from state left over from last time. After the
      // lock, not before: a refused request must change nothing.
      deps.admin.forget(nodeNum);

      try {
        const capability = await deps.admin.probe(nodeNum, signal);
        deps.nodes.setAdminCapability(nodeNum, capability);
        return { capability };
      } catch (cause) {
        // A cancelled probe establishes nothing, so no verdict is recorded.
        if (cause instanceof TaskCancelledError) {
          return reply.status(409).send({ error: "probe cancelled" });
        }
        throw cause;
      } finally {
        deps.tasks.finish(task.id);
      }
    },
  );

  /**
   * Asks the node for everything it will report right now -- identity,
   * device metrics and any sensor readings, and position.
   *
   * Unlike the automatic pass after discovery this asks regardless of what
   * is already stored, because the point of pressing refresh is to learn
   * what is true now. It waits for the replies so the button can say what
   * actually arrived, and registers a task so the wait is visible and
   * cancellable from anywhere.
   */
  app.post<{ Params: { id: string } }>(
    "/api/nodes/:id/refresh",
    async (request, reply) => {
      if (!(await requireOperator(request, reply))) return reply;

      const nodeNum = parseNodeId(request.params.id);
      if (nodeNum === null) {
        return reply.status(400).send({ error: "malformed node id" });
      }
      const node = deps.nodes.get(nodeNum);
      if (!node) return reply.status(404).send({ error: "unknown node" });
      if (node.isLocal) {
        return reply
          .status(400)
          .send({ error: "the local node reports its own state over USB" });
      }
      if (!deps.listener.getDevice()) {
        return reply.status(503).send({ error: "local radio is not connected" });
      }

      const started = deps.tasks.start({
        kind: "refresh",
        label: "Refreshing device information",
        nodeNum,
        nodeName: node.longName ?? node.shortName ?? null,
        timeoutSeconds: 25,
      });

      if (!started) {
        return reply.status(409).send(busyError(deps.tasks.occupancy()));
      }
      const { task, signal } = started;

      try {
        const received = await deps.enricher.refresh(nodeNum, signal);
        // The node row is updated by the ingest as replies land, so read it
        // back rather than reporting what we hoped for.
        return { received, node: deps.nodes.get(nodeNum) };
      } catch (cause) {
        if (cause instanceof TaskCancelledError) {
          return reply.status(409).send({ error: "refresh cancelled" });
        }
        throw cause;
      } finally {
        deps.tasks.finish(task.id);
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: NodeConfigUpdate }>(
    "/api/nodes/:id/config",
    async (request, reply) => {
      if (!(await requireOperator(request, reply))) return reply;

      const nodeNum = parseNodeId(request.params.id);
      if (nodeNum === null) {
        return reply.status(400).send({ error: "malformed node id" });
      }

      const node = deps.nodes.get(nodeNum);
      if (!node) {
        return reply.status(404).send({ error: "unknown node" });
      }
      if (node.isLocal) {
        return reply
          .status(400)
          .send({ error: "the local node is configured over USB, not remotely" });
      }
      if (!deps.listener.getDevice()) {
        return reply.status(503).send({ error: "local radio is not connected" });
      }

      const update = validateConfigUpdate(request.body);
      if ("error" in update) {
        return reply.status(400).send({ error: update.error });
      }

      const detail = Object.entries(update.value)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ");
      const operationId = deps.operations.create(nodeNum, "setOwner", detail);
      const started = deps.tasks.start({
        kind: "config",
        label: "Applying configuration",
        nodeNum,
        nodeName: node.longName ?? node.shortName ?? null,
        timeoutSeconds: deps.config.fleet.admin_probe_timeout,
      });

      if (!started) {
        return reply.status(409).send(busyError(deps.tasks.occupancy()));
      }
      const { task, signal } = started;

      try {
        await deps.admin.setOwner(nodeNum, update.value, signal);
        deps.operations.settle(operationId, "confirmed", null);

        // The remote is now authoritative for these names; reflect them
        // locally so the UI does not show the old ones until the next
        // NodeInfo broadcast, which can be twenty minutes out.
        deps.nodes.upsert({
          nodeNum,
          longName: update.value.longName ?? null,
          shortName: update.value.shortName ?? null,
        });
        deps.nodes.setAdminCapability(nodeNum, "capable");

        return { operationId, state: "confirmed" as const };
      } catch (cause) {
        // Cancelling a write is the ambiguous case: the packet may already
        // be on the air, so the change may yet land on the node. Record it
        // as such rather than claiming it failed, and do not touch the
        // admin verdict -- nothing was established either way.
        if (cause instanceof TaskCancelledError) {
          deps.operations.settle(
            operationId,
            "failed",
            "cancelled by operator; the change may still have been applied",
          );
          return reply.status(409).send({
            error:
              "Cancelled. The request may already have reached the node, so re-check its name before retrying.",
            operationId,
            state: "failed" as const,
          });
        }

        const message =
          cause instanceof Error ? cause.message : "unknown failure";
        deps.operations.settle(operationId, "failed", message);

        if (cause instanceof AdminError && cause.capability !== "unknown") {
          deps.nodes.setAdminCapability(nodeNum, cause.capability);
        }

        request.log.warn(
          { ...logNode(nodeNum), err: message },
          "remote config failed",
        );
        return reply
          .status(502)
          .send({ error: message, operationId, state: "failed" as const });
      } finally {
        deps.tasks.finish(task.id);
      }
    },
  );
}

const MAX_LONG_NAME = 39;
const MAX_SHORT_NAME = 4;

/**
 * Firmware truncates over-long names silently, which would leave the UI
 * showing something the node never stored. Reject instead.
 */
function validateConfigUpdate(
  body: NodeConfigUpdate | undefined,
): { value: NodeConfigUpdate } | { error: string } {
  const value: NodeConfigUpdate = {};

  if (body?.longName !== undefined) {
    const longName = String(body.longName).trim();
    if (longName.length === 0) return { error: "longName cannot be empty" };
    if (longName.length > MAX_LONG_NAME) {
      return { error: `longName must be at most ${MAX_LONG_NAME} characters` };
    }
    value.longName = longName;
  }

  if (body?.shortName !== undefined) {
    const shortName = String(body.shortName).trim();
    if (shortName.length === 0) return { error: "shortName cannot be empty" };
    if (shortName.length > MAX_SHORT_NAME) {
      return { error: `shortName must be at most ${MAX_SHORT_NAME} characters` };
    }
    value.shortName = shortName;
  }

  if (Object.keys(value).length === 0) {
    return { error: "no supported settings in request" };
  }
  return { value };
}
