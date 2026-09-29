import { useEffect, useState } from "react";
import { Loader, X } from "lucide-react";
import type { RadioTask } from "../../shared/types";

/**
 * Shown while the radio is occupied by something an operator started.
 *
 * It lives in `Layout`, above the page content, because the person who
 * started a mesh round trip has usually navigated somewhere else by the
 * time it finishes -- a spinner on the originating button alone would
 * leave the radio looking idle everywhere except the page they left.
 *
 * Amber, like the degraded banner: the console is working and this is a
 * normal wait, not a fault. Red is reserved for things that are broken.
 */
export function RadioTaskBanner({
  tasks,
  onCancel,
}: {
  tasks: RadioTask[];
  onCancel: (task: RadioTask) => void;
}) {
  // Ticks once a second purely so the elapsed counter advances; the task
  // list itself only changes when the status poll returns.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  if (tasks.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="card mb-6 border-amber-500/40 bg-amber-500/10 p-4"
    >
      <ul className="space-y-3">
        {tasks.map((task) => (
          <TaskRow key={task.id} task={task} onCancel={onCancel} />
        ))}
      </ul>
    </div>
  );
}

function TaskRow({
  task,
  onCancel,
}: {
  task: RadioTask;
  onCancel: (task: RadioTask) => void;
}) {
  const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - task.startedAt);
  const remaining = Math.max(0, task.timeoutSeconds - elapsed);
  const target = task.nodeName ?? task.nodeId;

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <Loader
        aria-hidden
        className="h-5 w-5 shrink-0 animate-spin text-amber-400"
      />

      <div className="min-w-0 flex-1">
        <p className="font-semibold text-amber-200">
          Radio busy — {task.label}
        </p>
        <p className="mt-0.5 text-sm text-amber-200/80">
          <span className="data">{target}</span>
          {task.nodeName && <span className="data"> · {task.nodeId}</span>}
          {" — waiting "}
          <span className="data">{elapsed}s</span>
          {remaining > 0 ? (
            <>
              , giving up in <span className="data">{remaining}s</span>
            </>
          ) : (
            ", finishing up"
          )}
        </p>
      </div>

      <button
        type="button"
        onClick={() => onCancel(task)}
        // Honest about what stopping does: the packet may already be on the
        // air, so this abandons the wait rather than recalling anything.
        title="Stop waiting and return the radio to listening. A request already sent cannot be recalled."
        className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-amber-500/40 px-3 py-1.5 text-sm text-amber-200 transition [corner-shape:bevel] hover:bg-amber-500/20"
      >
        <X aria-hidden className="h-4 w-4" />
        Cancel
      </button>
    </li>
  );
}
