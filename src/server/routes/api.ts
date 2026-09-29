import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import type { NodeRepository } from "../db/repositories/nodes.js";
import type { AdminOperationRepository } from "../db/repositories/adminOperations.js";
import { AdminError, type AdminClient } from "../mesh/admin.js";
import type { CapabilityProber } from "../mesh/capability.js";
import type { MeshListener } from "../mesh/listener.js";
import { TaskCancelledError, type RadioTaskRegistry } from "../mesh/tasks.js";
import { parseNodeId } from "../mesh/nodeId.js";
import type { NodeConfigUpdate } from "../../shared/types.js";

/**
 * Read paths serve straight from SQLite -- never from the radio -- so the
 * UI stays responsive and useful while the mesh is slow or the radio is
 * unplugged. Only the write path in `PATCH /api/nodes/:id/config` touches
 * the mesh, and it reports its own outcome.
 */

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
}

export function registerApiRoutes(
  app: FastifyInstance,
  deps: ApiDependencies,
): void {
  app.get("/api/status", async () => ({
    radio: deps.listener.getStatus(),
    staleAfter: deps.config.fleet.stale_after,
    // Polled by the UI to drive the "radio busy" banner, so this endpoint
    // is also what makes a long operation visible from any page.
    tasks: deps.tasks.list(),
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
      };
    },
  );

  /**
   * Re-probes admin capability for one node on demand, because waiting out
   * the sweep interval after fixing a node's `adminKey` is a bad workflow.
   */
  app.post<{ Params: { id: string } }>(
    "/api/nodes/:id/probe",
    async (request, reply) => {
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

      deps.admin.forget(nodeNum);
      const node = deps.nodes.get(nodeNum);
      const { task, signal } = deps.tasks.start({
        kind: "probe",
        label: "Checking admin access",
        nodeNum,
        nodeName: node?.longName ?? node?.shortName ?? null,
        timeoutSeconds: deps.config.fleet.admin_probe_timeout,
      });

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

  app.patch<{ Params: { id: string }; Body: NodeConfigUpdate }>(
    "/api/nodes/:id/config",
    async (request, reply) => {
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
      const { task, signal } = deps.tasks.start({
        kind: "config",
        label: "Applying configuration",
        nodeNum,
        nodeName: node.longName ?? node.shortName ?? null,
        timeoutSeconds: deps.config.fleet.admin_probe_timeout,
      });

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

        request.log.warn({ nodeNum, err: message }, "remote config failed");
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
