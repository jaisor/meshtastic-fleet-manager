import { useState, type FormEvent } from "react";
import { RadioTower } from "lucide-react";
import { api, ApiError } from "../api";

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(username, password);
      setPassword("");
      onSuccess();
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : "could not reach the server",
      );
      // The server already delays a failed attempt; nothing to do here but
      // let the operator try again.
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="card w-full max-w-sm p-8">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <RadioTower aria-hidden className="h-8 w-8 text-amber-500" />
          <h1 className="text-xl font-semibold tracking-tight text-white">
            Fleet Manager
          </h1>
          <p className="text-sm text-neutral-500">
            Sign in to continue.
          </p>
        </div>

        <label htmlFor="username" className="sr-only">
          Username
        </label>
        <input
          id="username"
          type="text"
          autoComplete="username"
          autoFocus
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          className="mb-3 w-full rounded-lg border border-neutral-800 bg-neutral-950/60 px-3 py-2 text-neutral-100 placeholder-neutral-600 [corner-shape:bevel] focus:border-amber-500/50"
          placeholder="Username"
        />

        <label htmlFor="password" className="sr-only">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="w-full rounded-lg border border-neutral-800 bg-neutral-950/60 px-3 py-2 text-neutral-100 placeholder-neutral-600 [corner-shape:bevel] focus:border-amber-500/50"
          placeholder="Password"
        />

        {error && (
          <p role="alert" className="mt-3 text-sm text-red-400">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy || username.length === 0 || password.length === 0}
          className="mt-5 w-full rounded-lg border border-amber-500/40 bg-amber-500/15 px-4 py-2 font-medium text-amber-300 transition [corner-shape:bevel] hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
