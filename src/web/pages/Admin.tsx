import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, KeyRound, Trash2, TriangleAlert, UserPlus } from "lucide-react";
import type { ManagedUser, SessionUser } from "../../shared/types";
import { ROLE_DESCRIPTIONS, USER_ROLES, type UserRole } from "../../shared/roles";
import { api, ApiError } from "../api";
import { absoluteTime, relativeTime } from "../components/format";

/**
 * Account management and the destructive maintenance actions.
 *
 * Reachable only by admins, and the server enforces that independently --
 * everything here 403s for other roles regardless of what the UI shows.
 */
export function Admin({
  currentUser,
  onBack,
}: {
  currentUser: SessionUser;
  onBack: () => void;
}) {
  const [users, setUsers] = useState<ManagedUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setUsers((await api.listUsers()).users);
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const report = (message: string) => {
    setNotice(message);
    setError(null);
  };
  const fail = (cause: unknown) => {
    setError(cause instanceof ApiError ? cause.message : String(cause));
    setNotice(null);
  };

  return (
    <div className="space-y-6">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-2 text-sm text-neutral-500 transition hover:text-amber-400"
      >
        <ArrowLeft aria-hidden className="h-4 w-4" />
        All nodes
      </button>

      <h1 className="text-2xl font-bold tracking-tight text-white">
        Administration
      </h1>

      {notice && (
        <p role="status" className="card border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-200">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="card border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
          {error}
        </p>
      )}

      <CreateUser onCreated={(m) => { report(m); void load(); }} onError={fail} />

      <UserTable
        users={users}
        currentUser={currentUser}
        onChanged={(m) => { report(m); void load(); }}
        onError={fail}
      />

      <DangerZone onDone={(m) => { report(m); void load(); }} onError={fail} />
    </div>
  );
}

function CreateUser({
  onCreated,
  onError,
}: {
  onCreated: (message: string) => void;
  onError: (cause: unknown) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("viewer");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api.createUser(username.trim(), password, role);
      onCreated(`Created ${username.trim()} as ${role}.`);
      setUsername("");
      setPassword("");
      setRole("viewer");
    } catch (cause) {
      onError(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card p-6" aria-label="Add a user">
      <h2 className="mb-4 text-sm font-medium tracking-wide text-neutral-500 uppercase">
        Add a user
      </h2>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-4">
        <Field label="Username">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="off"
            className={INPUT}
          />
        </Field>
        <Field label="Password">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            placeholder="at least 8 characters"
            className={INPUT}
          />
        </Field>
        <Field label="Role">
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as UserRole)}
            className={`${INPUT} [&>option]:bg-neutral-900`}
          >
            {USER_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </Field>
        <div className="flex items-end">
          <button
            type="submit"
            disabled={busy || username.trim() === "" || password === ""}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/15 px-4 py-2 text-sm font-medium text-amber-300 transition [corner-shape:bevel] hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <UserPlus aria-hidden className="h-4 w-4" />
            {busy ? "Adding…" : "Add user"}
          </button>
        </div>
      </form>

      <dl className="mt-4 space-y-1 border-t border-neutral-800 pt-4 text-xs text-neutral-500">
        {USER_ROLES.map((r) => (
          <div key={r} className="flex gap-2">
            <dt className="w-16 shrink-0 text-amber-500/70 capitalize">{r}</dt>
            <dd>{ROLE_DESCRIPTIONS[r]}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function UserTable({
  users,
  currentUser,
  onChanged,
  onError,
}: {
  users: ManagedUser[] | null;
  currentUser: SessionUser;
  onChanged: (message: string) => void;
  onError: (cause: unknown) => void;
}) {
  if (users === null) {
    return <p className="p-6 text-neutral-500">Loading accounts…</p>;
  }

  return (
    <section className="card overflow-hidden" aria-label="User accounts">
      <h2 className="border-b border-neutral-800 px-6 py-4 text-sm font-medium tracking-wide text-neutral-500 uppercase">
        Accounts
      </h2>

      <div className="border-b border-neutral-800 bg-neutral-950/40 px-6 py-3 text-xs text-neutral-500">
        <span className="data text-amber-500/80">admin</span> is defined in
        config.yaml and is not listed here. It cannot be deleted or demoted
        from the console, which is what keeps the app reachable if these
        accounts are lost — change its password in the config file.
      </div>

      {users.length === 0 ? (
        <p className="px-6 py-8 text-center text-sm text-neutral-500">
          No additional accounts yet.
        </p>
      ) : (
        <ul className="divide-y divide-neutral-800/60">
          {users.map((user) => (
            <UserRow
              key={user.id}
              user={user}
              isSelf={
                user.username.toLowerCase() ===
                currentUser.username.toLowerCase()
              }
              onChanged={onChanged}
              onError={onError}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function UserRow({
  user,
  isSelf,
  onChanged,
  onError,
}: {
  user: ManagedUser;
  isSelf: boolean;
  onChanged: (message: string) => void;
  onError: (cause: unknown) => void;
}) {
  const [resetting, setResetting] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function changeRole(role: UserRole) {
    setBusy(true);
    try {
      const result = await api.updateUser(user.id, { role });
      onChanged(
        `${user.username} is now ${role}.` +
          (result.sessionsRevoked > 0 ? " They have been signed out." : ""),
      );
    } catch (cause) {
      onError(cause);
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api.updateUser(user.id, { password });
      onChanged(`Password reset for ${user.username}. They have been signed out.`);
      setPassword("");
      setResetting(false);
    } catch (cause) {
      onError(cause);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (
      !window.confirm(
        `Delete the account "${user.username}"? They will be signed out immediately. This cannot be undone.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await api.deleteUser(user.id);
      onChanged(`Deleted ${user.username}.`);
    } catch (cause) {
      onError(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="px-6 py-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-white">
            {user.username}
            {isSelf && (
              <span className="ml-2 text-xs font-normal text-amber-400">you</span>
            )}
          </p>
          <p className="mt-0.5 text-xs text-neutral-500">
            Added <span title={absoluteTime(user.createdAt)}>{relativeTime(user.createdAt)}</span>
            {" · last signed in "}
            <span title={absoluteTime(user.lastLoginAt)}>
              {user.lastLoginAt ? relativeTime(user.lastLoginAt) : "never"}
            </span>
          </p>
        </div>

        <label className="sr-only" htmlFor={`role-${user.id}`}>
          Role for {user.username}
        </label>
        <select
          id={`role-${user.id}`}
          value={user.role}
          disabled={busy}
          onChange={(e) => void changeRole(e.target.value as UserRole)}
          className="rounded-lg border border-neutral-800 bg-neutral-950/60 px-3 py-1.5 text-sm text-neutral-200 [corner-shape:bevel] focus:border-amber-500/50 disabled:opacity-40 [&>option]:bg-neutral-900"
        >
          {USER_ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => setResetting((v) => !v)}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-lg border border-neutral-800 px-3 py-1.5 text-xs text-neutral-400 transition [corner-shape:bevel] hover:border-amber-500/40 hover:text-amber-400 disabled:opacity-40"
        >
          <KeyRound aria-hidden className="h-3.5 w-3.5" />
          Reset password
        </button>

        <button
          type="button"
          onClick={() => void remove()}
          disabled={busy || isSelf}
          title={isSelf ? "You cannot delete the account you are signed in as" : undefined}
          className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 px-3 py-1.5 text-xs text-red-300 transition [corner-shape:bevel] hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Trash2 aria-hidden className="h-3.5 w-3.5" />
          Delete
        </button>
      </div>

      {resetting && (
        <form onSubmit={resetPassword} className="mt-3 flex flex-wrap items-end gap-3">
          <label className="min-w-48 flex-1">
            <span className="text-xs tracking-wide text-neutral-500 uppercase">
              New password for {user.username}
            </span>
            <input
              type="password"
              value={password}
              autoComplete="new-password"
              onChange={(e) => setPassword(e.target.value)}
              placeholder="at least 8 characters"
              className={`mt-1 ${INPUT}`}
            />
          </label>
          <button
            type="submit"
            disabled={busy || password === ""}
            className="rounded-lg border border-amber-500/40 bg-amber-500/15 px-4 py-2 text-sm font-medium text-amber-300 transition [corner-shape:bevel] hover:bg-amber-500/25 disabled:opacity-40"
          >
            {busy ? "Saving…" : "Set password"}
          </button>
        </form>
      )}
    </li>
  );
}

/**
 * The destructive actions, kept visually apart and behind a typed
 * confirmation. The server demands the same word again, so a mis-wired
 * button cannot delete a fleet on its own.
 */
function DangerZone({
  onDone,
  onError,
}: {
  onDone: (message: string) => void;
  onError: (cause: unknown) => void;
}) {
  const [scope, setScope] = useState<"nodes" | "history" | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  async function run() {
    if (scope === null) return;
    setBusy(true);
    try {
      const { purged } = await api.purge(scope);
      onDone(
        `Deleted ${purged.nodes} nodes, ${purged.telemetry} telemetry rows, ` +
          `${purged.positions} positions and ${purged.operations} operation records.`,
      );
      setScope(null);
      setTyped("");
    } catch (cause) {
      onError(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card border-red-500/30 p-6" aria-label="Node database">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-medium tracking-wide text-red-300 uppercase">
        <TriangleAlert aria-hidden className="h-4 w-4" />
        Node database
      </h2>
      <p className="mb-4 max-w-2xl text-sm text-neutral-500">
        These delete collected mesh data. Accounts and settings are untouched.
        Discovery starts again from whatever the radio hears next — and on its
        next reconnect the radio hands over its own node list, so a cleared
        fleet often repopulates within seconds.
      </p>

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => { setScope("history"); setTyped(""); }}
          className="rounded-lg border border-neutral-800 px-4 py-2 text-sm text-neutral-300 transition [corner-shape:bevel] hover:border-red-500/40 hover:text-red-300"
        >
          Clear telemetry and positions
        </button>
        <button
          type="button"
          onClick={() => { setScope("nodes"); setTyped(""); }}
          className="rounded-lg border border-red-500/40 px-4 py-2 text-sm text-red-300 transition [corner-shape:bevel] hover:bg-red-500/10"
        >
          Delete all nodes
        </button>
      </div>

      {scope !== null && (
        <div className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 p-4 [corner-shape:bevel]">
          <p className="text-sm text-red-200">
            {scope === "nodes"
              ? "This deletes every node, along with its telemetry, positions and operation history."
              : "This deletes all telemetry and position history. The nodes themselves stay."}
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="min-w-48 flex-1">
              <span className="text-xs text-red-200/80">
                Type <span className="data font-semibold">{scope}</span> to confirm
              </span>
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                className="data mt-1 w-full rounded-lg border border-red-500/40 bg-neutral-950/60 px-3 py-2 text-sm text-neutral-100 [corner-shape:bevel] focus:border-red-400"
              />
            </label>
            <button
              type="button"
              onClick={() => void run()}
              disabled={busy || typed !== scope}
              className="rounded-lg border border-red-500/50 bg-red-500/20 px-4 py-2 text-sm font-medium text-red-200 transition [corner-shape:bevel] hover:bg-red-500/30 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? "Deleting…" : "Delete permanently"}
            </button>
            <button
              type="button"
              onClick={() => { setScope(null); setTyped(""); }}
              className="rounded-lg border border-neutral-800 px-4 py-2 text-sm text-neutral-400 transition [corner-shape:bevel] hover:text-neutral-200"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

const INPUT =
  "w-full rounded-lg border border-neutral-800 bg-neutral-950/60 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 [corner-shape:bevel] focus:border-amber-500/50";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs tracking-wide text-neutral-500 uppercase">
        {label}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
