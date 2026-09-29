import type {
  AdminCapability,
  AdminOperation,
  FleetNode,
  NodeConfigUpdate,
  PositionPoint,
  RadioStatus,
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
}

export interface NodeDetailResponse {
  node: FleetNode;
  telemetry: TelemetryPoint[];
  positions: PositionPoint[];
  operations: AdminOperation[];
}

export const api = {
  getSession: () => request<{ authenticated: boolean }>("/api/session"),

  login: (password: string) =>
    request<{ authenticated: boolean }>("/api/session", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),

  logout: () =>
    request<{ authenticated: boolean }>("/api/session", { method: "DELETE" }),

  getStatus: () => request<StatusResponse>("/api/status"),

  listNodes: () => request<{ nodes: FleetNode[] }>("/api/nodes"),

  getNode: (nodeId: string) =>
    request<NodeDetailResponse>(`/api/nodes/${encodeURIComponent(nodeId)}`),

  probeNode: (nodeId: string) =>
    request<{ capability: AdminCapability }>(
      `/api/nodes/${encodeURIComponent(nodeId)}/probe`,
      { method: "POST" },
    ),

  updateNodeConfig: (nodeId: string, update: NodeConfigUpdate) =>
    request<{ operationId: number; state: string }>(
      `/api/nodes/${encodeURIComponent(nodeId)}/config`,
      { method: "PATCH", body: JSON.stringify(update) },
    ),
};
