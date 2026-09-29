import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { FleetNode } from "../../shared/types";
import { api } from "../api";
import { nodePath } from "../router";
import { CapabilityBadge } from "../components/CapabilityBadge";
import { StatusDot } from "../components/StatusDot";
import { absoluteTime, metric, relativeTime } from "../components/format";

/** Poll cadence. The mesh is slow; refreshing faster would show nothing new. */
const REFRESH_MS = 20_000;

export function Fleet({ onOpen }: { onOpen: (path: string) => void }) {
  const [nodes, setNodes] = useState<FleetNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const result = await api.listNodes();
        if (!cancelled) {
          setNodes(result.nodes);
          setError(null);
        }
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message);
      }
    }

    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (error) {
    return <p className="card p-6 text-red-400">{error}</p>;
  }

  if (nodes === null) {
    return <p className="p-6 text-neutral-500">Loading fleet…</p>;
  }

  if (nodes.length === 0) {
    return (
      <div className="card p-8 text-center">
        <h2 className="text-lg font-semibold text-white">No nodes yet</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-neutral-500">
          Discovery is passive: nodes appear here as the local radio hears
          them on the primary channel. A quiet mesh can take a while — nodes
          broadcast their identity roughly every few hours.
        </p>
      </div>
    );
  }

  return (
    <section aria-label="Managed nodes">
      <h2 className="mb-4 text-sm font-medium tracking-wide text-neutral-500 uppercase">
        {nodes.length} {nodes.length === 1 ? "node" : "nodes"}
      </h2>

      <ul className="space-y-2">
        {nodes.map((node) => (
          <li key={node.nodeNum}>
            <a
              href={nodePath(node.nodeId)}
              onClick={(event) => {
                // Let modified clicks open a new tab as usual.
                if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                event.preventDefault();
                onOpen(nodePath(node.nodeId));
              }}
              className="card card-link flex flex-col gap-3 p-4 sm:min-h-16 sm:flex-row sm:items-center sm:gap-4"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="truncate font-semibold text-white">
                    {node.longName ?? node.nodeId}
                  </span>
                  {node.shortName && (
                    <span className="data rounded border border-neutral-800 px-1.5 py-0.5 text-xs text-amber-500/80 [corner-shape:bevel]">
                      {node.shortName}
                    </span>
                  )}
                  {node.isLocal && (
                    <span className="text-xs font-medium text-amber-400">
                      local
                    </span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-500">
                  <span className="data">{node.nodeId}</span>
                  <span title={absoluteTime(node.lastHeardAt)}>
                    Heard {relativeTime(node.lastHeardAt)}
                  </span>
                  {node.batteryLevel !== null && (
                    <span className="data">{node.batteryLevel}%</span>
                  )}
                  {node.snr !== null && (
                    <span className="data">{metric(node.snr, " dB")}</span>
                  )}
                </div>
              </div>

              {/* Side by side on a phone, stacked in a fixed column above it,
                  so the badges cannot crowd the metadata line. */}
              <div className="flex items-center gap-3 sm:w-32 sm:shrink-0 sm:flex-col sm:items-end sm:gap-2">
                <StatusDot state={node.state} />
                {!node.isLocal && (
                  <CapabilityBadge capability={node.adminCapability} />
                )}
              </div>

              <ChevronRight
                aria-hidden
                className="hidden h-5 w-5 shrink-0 text-neutral-700 sm:block"
              />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
