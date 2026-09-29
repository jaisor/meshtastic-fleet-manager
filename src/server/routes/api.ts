import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import type { NodeRepository } from "../db/repositories/nodes.js";
import type { AdminOperationRepository } from "../db/repositories/adminOperations.js";
import { AdminError, type AdminClient } from "../mesh/admin.js";
import type { CapabilityProber } from "../mesh/capability.js";
import type { MeshListener } from "../mesh/listener.js";
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
}

export function registerApiRoutes(
  app: FastifyInstance,
  deps: ApiDependencies,
): void {
  app.get("/api/status", async () => ({
    radio: deps.listener.getStatus(),
    staleAfter: deps.config.fleet.stale_after,
  }));

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
      const capability = await deps.admin.probe(nodeNum);
      deps.nodes.setAdminCapability(nodeNum, capability);
      return { capability };
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

      try {
        await deps.admin.setOwner(nodeNum, update.value);
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
