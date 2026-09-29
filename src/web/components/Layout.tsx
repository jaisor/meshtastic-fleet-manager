import type { ReactNode } from "react";
import { RadioTower, TriangleAlert } from "lucide-react";
import type { RadioStatus, RadioTask, SessionUser } from "../../shared/types";
import { UserMenu } from "./UserMenu";
import { RadioTaskBanner } from "./RadioTaskBanner";
import { absoluteTime, relativeTime } from "./format";

/**
 * Page chrome: the masthead with the local radio's state, the degraded-mode
 * banner, and the footer.
 *
 * The banner is not decoration. Every number in this app comes from the
 * database, not live from the mesh, so with the USB link down the page
 * still renders perfectly plausible rows that are hours old. Saying so is
 * the difference between stale data and wrong data.
 *
 * The header pill and the banner are not redundant: the pill is glanceable
 * state that is also present (and green) when things are fine, the banner
 * appears only on a fault and explains the consequences.
 */
export function Layout({
  radio,
  tasks,
  user,
  onCancelTask,
  onNavigate,
  onLogout,
  children,
}: {
  radio: RadioStatus | null;
  tasks: RadioTask[];
  user: SessionUser;
  onCancelTask: (task: RadioTask) => void;
  onNavigate: (path: string) => void;
  onLogout: () => void;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col px-4 py-6 sm:px-6 lg:py-10">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <a href="/" className="group flex items-center gap-3">
          <RadioTower aria-hidden className="h-6 w-6 text-amber-500" />
          <span className="text-lg font-semibold tracking-tight text-white">
            Fleet Manager
          </span>
        </a>

        <div className="flex items-center gap-4">
          {radio && <RadioPill radio={radio} />}
          <UserMenu user={user} onNavigate={onNavigate} onLogout={onLogout} />
        </div>
      </header>

      {radio && !radio.connected && <DegradedBanner radio={radio} />}

      <RadioTaskBanner tasks={tasks} onCancel={onCancelTask} />

      <main className="flex-1">{children}</main>

      <footer className="mt-10 border-t border-neutral-800 pt-6 text-center text-xs text-neutral-600">
        Meshtastic Fleet Manager
      </footer>
    </div>
  );
}

/**
 * Shown whenever the radio is not connected.
 *
 * Amber rather than red on purpose: the console is working, and everything
 * on screen is real. What is lost is freshness and the ability to write.
 * Red would say "this page is broken", which would be wrong and would
 * teach people to ignore the banner.
 */
function DegradedBanner({ radio }: { radio: RadioStatus }) {
  const disabledByConfig = !radio.enabled;

  return (
    <div
      role="status"
      className="card mb-6 border-amber-500/40 bg-amber-500/10 p-4"
    >
      <div className="flex gap-3">
        <TriangleAlert
          aria-hidden
          className="mt-0.5 h-5 w-5 shrink-0 text-amber-400"
        />
        <div className="min-w-0">
          <p className="font-semibold text-amber-200">
            Degraded mode — no radio
          </p>
          <p className="mt-1 text-sm text-amber-200/80">
            {disabledByConfig
              ? "Radio support is turned off in the configuration file. "
              : "The local radio is not connected. "}
            Everything below is served from the database and is accurate as of
            each node&rsquo;s last check-in, but nothing is updating and remote
            operations are unavailable.
          </p>

          <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-amber-200/60">
            <div className="flex gap-1.5">
              <dt>Port:</dt>
              <dd className="data">{radio.portPath || "not configured"}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt>Last connected:</dt>
              <dd title={absoluteTime(radio.lastConnectedAt)}>
                {radio.lastConnectedAt
                  ? relativeTime(radio.lastConnectedAt)
                  : "not since startup"}
              </dd>
            </div>
            {!disabledByConfig && (
              <div className="flex gap-1.5">
                <dt>Status:</dt>
                <dd>retrying automatically</dd>
              </div>
            )}
          </dl>

          {radio.lastErrorText && (
            <p className="data mt-2 text-xs break-words text-amber-200/50">
              {radio.lastErrorText}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function RadioPill({ radio }: { radio: RadioStatus }) {
  if (radio.connected) {
    // Undecodable frames are surfaced only in the tooltip: a handful after
    // connect is normal resynchronization, so promoting it to a visible
    // warning would cry wolf. Someone chasing missing packets will look.
    const decodeNote =
      radio.decodeErrors > 0
        ? ` · ${radio.decodeErrors} undecodable frame${radio.decodeErrors === 1 ? "" : "s"} since connect`
        : "";

    return (
      <span
        title={`${radio.portPath}${radio.configured ? "" : " (still configuring)"}${decodeNote}`}
        className="inline-flex items-center gap-2 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300 [corner-shape:bevel]"
      >
        <span aria-hidden className="h-2 w-2 rounded-full bg-emerald-500" />
        {radio.configured ? "Radio connected" : "Radio configuring"}
      </span>
    );
  }

  const detail = radio.lastConnectedAt
    ? `Last connected ${relativeTime(radio.lastConnectedAt)}.`
    : "Never connected since startup.";

  // Matches the banner's amber: the console works, it is just read-only.
  return (
    <span
      title={`${detail}${radio.lastErrorText ? ` ${radio.lastErrorText}` : ""}`}
      className="inline-flex items-center gap-2 rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-300 [corner-shape:bevel]"
    >
      <span aria-hidden className="h-2 w-2 rounded-full bg-amber-500" />
      {radio.enabled ? "Radio disconnected" : "Radio off"}
      <span className="hidden sm:inline">— read-only</span>
    </span>
  );
}
