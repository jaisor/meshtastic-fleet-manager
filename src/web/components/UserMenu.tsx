import { useEffect, useRef, useState } from "react";
import { ChevronDown, LogOut, ShieldCheck, UserRound } from "lucide-react";
import type { SessionUser } from "../../shared/types";
import { canAdminister } from "../../shared/roles";

/**
 * Who is signed in, what they may do, and the way out.
 *
 * The admin link is hidden for roles that cannot use it -- not as a
 * security measure, since the server refuses those routes regardless, but
 * because offering a door that always slams is worse than no door.
 */
export function UserMenu({
  user,
  onNavigate,
  onLogout,
}: {
  user: SessionUser;
  onNavigate: (path: string) => void;
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    // Escape as well as click-away: a dropdown that can only be dismissed
    // with the mouse strands anyone driving the console from the keyboard.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={container} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-2 rounded-lg border border-neutral-800 px-3 py-1.5 text-sm text-neutral-300 transition [corner-shape:bevel] hover:border-amber-500/40 hover:text-amber-400"
      >
        <UserRound aria-hidden className="h-4 w-4" />
        <span className="hidden max-w-32 truncate sm:inline">{user.username}</span>
        <ChevronDown aria-hidden className="h-4 w-4 text-neutral-600" />
      </button>

      {open && (
        <div
          role="menu"
          className="card absolute right-0 z-20 mt-2 w-60 bg-neutral-900 p-1 shadow-lg shadow-black/40"
        >
          <div className="border-b border-neutral-800 px-3 py-2">
            <p className="truncate text-sm font-medium text-white">
              {user.username}
            </p>
            <p className="mt-0.5 text-xs text-neutral-500">
              <span className="text-amber-500/80 capitalize">{user.role}</span>
              {user.builtIn && " · defined in config.yaml"}
            </p>
          </div>

          {canAdminister(user.role) && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onNavigate("/admin");
              }}
              className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-neutral-300 transition hover:bg-neutral-800 hover:text-amber-400"
            >
              <ShieldCheck aria-hidden className="h-4 w-4" />
              Administration
            </button>
          )}

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
            className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-neutral-300 transition hover:bg-neutral-800 hover:text-amber-400"
          >
            <LogOut aria-hidden className="h-4 w-4" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
