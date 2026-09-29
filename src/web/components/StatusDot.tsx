import type { NodeState } from "../../shared/types";

/**
 * Online / stale / offline indicator.
 *
 * Always rendered next to its text label, never alone: color is a second
 * channel here, not the only one, so the state survives a grayscale
 * screenshot and a red-green color deficiency alike.
 */
const STYLES: Record<NodeState, { dot: string; text: string; label: string }> = {
  online: { dot: "bg-emerald-500", text: "text-emerald-300", label: "Online" },
  stale: { dot: "bg-amber-500", text: "text-amber-300", label: "Stale" },
  offline: { dot: "bg-neutral-600", text: "text-neutral-500", label: "Offline" },
};

export function StatusDot({ state }: { state: NodeState }) {
  const style = STYLES[state];
  return (
    <span className={`inline-flex items-center gap-2 text-xs font-medium ${style.text}`}>
      <span aria-hidden className={`h-2 w-2 rounded-full ${style.dot}`} />
      {style.label}
    </span>
  );
}
