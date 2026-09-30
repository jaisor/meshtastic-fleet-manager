import type { UserRole } from "../shared/roles";
import type {
  AdminCapability,
  AdminOperation,
  ConfigReadOutcome,
  FleetNode,
  NodeConfigUpdate,
  NodeRadioConfig,
  PositionPoint,
  DiscoverySummary,
  ManagedUser,
  MaintenanceResult,
  RadioOccupancy,
  RadioStatus,
  SessionResponse,
  RadioTask,
  TelemetryPoint,
} from "../shared/types";

/**
 * Thin fetch wrapper. Every call goes to the same origin so the session
 * cookie rides along without any CORS or credentials juggling.
 */

/** Thrown for any non-2xx response, carrying the server's message. */
export class ApiError extends Error {
  // Written out rather than declared as a constructor parameter property:
  // the web build runs with `erasableSyntaxOnly`, which rules those out.
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    let message = `request failed with ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Non-JSON error body; the status-derived message will do.
    }
    throw new ApiError(message, response.status);
  }

  return (await response.json()) as T;
}

export interface StatusResponse {
  radio: RadioStatus;
  staleAfter: number;
  /** User-initiated operations currently occupying the radio. */
  tasks: RadioTask[];
  /**
   * What holds the radio, background sweeps included — so a control can be
   * disabled for work that never appears in the task banner.
   */
  radioBusy: RadioOccupancy | null;
  discovery: DiscoverySummary;
}

export interface NodeDetailResponse {
  node: FleetNode;
  telemetry: TelemetryPoint[];
  positions: PositionPoint[];
  operations: AdminOperation[];
  /** Null until somebody reads this node's settings. */
  config: NodeRadioConfig | null;
}

export const api = {
  getSession: () => request<SessionResponse>("/api/session"),

  login: (username: string, password: string) =>
    request<SessionResponse>("/api/session", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),

  logout: () => request<SessionResponse>("/api/session", { method: "DELETE" }),

  listUsers: () => request<{ users: ManagedUser[] }>("/api/users"),

  createUser: (username: string, password: string, role: UserRole) =>
    request<{ user: ManagedUser }>("/api/users", {
      method: "POST",
      body: JSON.stringify({ username, password, role }),
    }),

  updateUser: (id: number, changes: { role?: UserRole; password?: string }) =>
    request<{ user: ManagedUser; sessionsRevoked: number }>(`/api/users/${id}`, {
      method: "PATCH",
      body: JSON.stringify(changes),
    }),

  deleteUser: (id: number) =>
    request<{ deleted: boolean }>(`/api/users/${id}`, { method: "DELETE" }),

  purge: (scope: "nodes" | "history") =>
    request<{ purged: MaintenanceResult }>("/api/admin/purge", {
      method: "POST",
      // The server requires the scope echoed back; the UI collects it from a
      // typed confirmation field before ever calling this.
      body: JSON.stringify({ scope, confirm: scope }),
    }),

  getStatus: () => request<StatusResponse>("/api/status"),

  cancelTask: (id: number) =>
    request<{ cancelled: boolean }>(`/api/tasks/${id}/cancel`, {
      method: "POST",
    }),

  listNodes: () => request<{ nodes: FleetNode[] }>("/api/nodes"),

  getNode: (nodeId: string) =>
    request<NodeDetailResponse>(`/api/nodes/${encodeURIComponent(nodeId)}`),

  refreshNode: (nodeId: string) =>
    request<{
      received: { identity: boolean; metrics: boolean; position: boolean };
      node: FleetNode;
    }>(`/api/nodes/${encodeURIComponent(nodeId)}/refresh`, { method: "POST" }),

  probeNode: (nodeId: string) =>
    request<{ capability: AdminCapability }>(
      `/api/nodes/${encodeURIComponent(nodeId)}/probe`,
      { method: "POST" },
    ),

  /** Four mesh round trips; slow by nature. Registers a cancellable task. */
  readNodeConfig: (nodeId: string) =>
    request<{ outcome: ConfigReadOutcome; config: NodeRadioConfig }>(
      `/api/nodes/${encodeURIComponent(nodeId)}/config/read`,
      { method: "POST" },
    ),

  updateNodeConfig: (nodeId: string, update: NodeConfigUpdate) =>
    request<{ operationId: number; state: string }>(
      `/api/nodes/${encodeURIComponent(nodeId)}/config`,
      { method: "PATCH", body: JSON.stringify(update) },
    ),
};
