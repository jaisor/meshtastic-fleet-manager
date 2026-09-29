import type { ReactNode } from "react";
import { RadioTower, LogOut } from "lucide-react";
import type { RadioStatus } from "../../shared/types";
import { relativeTime } from "./format";

/**
 * Page chrome: the masthead with the local radio's state, and the footer.
 *
 * The radio banner is not decoration. Every number in this app comes from
 * the database, not live from the mesh, so when the USB link is down the
 * page still renders perfectly plausible rows that are hours old. Saying
 * so at the top is the difference between stale data and wrong data.
 */
export function Layout({
  radio,
  onLogout,
  children,
}: {
  radio: RadioStatus | null;
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
          <button
            type="button"
            onClick={onLogout}
            className="inline-flex items-center gap-2 rounded-lg border border-neutral-800 px-3 py-1.5 text-sm text-neutral-400 transition [corner-shape:bevel] hover:border-amber-500/40 hover:text-amber-400"
          >
            <LogOut aria-hidden className="h-4 w-4" />
            <span className="hidden sm:inline">Sign out</span>
            <span className="sr-only sm:hidden">Sign out</span>
          </button>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="mt-10 border-t border-neutral-800 pt-6 text-center text-xs text-neutral-600">
        Meshtastic Fleet Manager
      </footer>
    </div>
  );
}

function RadioPill({ radio }: { radio: RadioStatus }) {
  if (radio.connected) {
    return (
      <span
        title={`${radio.portPath}${radio.configured ? "" : " (still configuring)"}`}
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

  return (
    <span
      title={`${detail}${radio.lastErrorText ? ` ${radio.lastErrorText}` : ""}`}
      className="inline-flex items-center gap-2 rounded-full border border-red-500/40 bg-red-500/10 px-3 py-1 text-xs font-medium text-red-300 [corner-shape:bevel]"
    >
      <span aria-hidden className="h-2 w-2 rounded-full bg-red-500" />
      Radio disconnected
      <span className="hidden sm:inline">— data may be stale</span>
    </span>
  );
}
