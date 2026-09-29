import { useCallback, useEffect, useState } from "react";
import type { RadioStatus, RadioTask } from "../shared/types";
import { api, ApiError } from "./api";
import { useRoute } from "./router";
import { Backdrop } from "./components/Backdrop";
import { Layout } from "./components/Layout";
import { Fleet } from "./pages/Fleet";
import { Login } from "./pages/Login";
import { NodeDetail } from "./pages/NodeDetail";

/** How often the radio pill refreshes when nothing is happening. */
const STATUS_REFRESH_MS = 15_000;

/**
 * While an operation is in flight the same poll drives the task banner's
 * presence, so it runs much faster -- at 15s a 30s task would appear late
 * and linger for seconds after finishing, which reads as a broken button.
 */
const BUSY_REFRESH_MS = 2_000;

type Auth = "checking" | "in" | "out";

export function App() {
  const [auth, setAuth] = useState<Auth>("checking");
  const [radio, setRadio] = useState<RadioStatus | null>(null);
  const [tasks, setTasks] = useState<RadioTask[]>([]);
  const [route, navigate] = useRoute();

  useEffect(() => {
    void api
      .getSession()
      .then((session) => setAuth(session.authenticated ? "in" : "out"))
      .catch(() => setAuth("out"));
  }, []);

  useEffect(() => {
    if (auth !== "in") return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const load = async () => {
      try {
        const status = await api.getStatus();
        if (cancelled) return;
        setRadio(status.radio);
        setTasks(status.tasks);
        // Reschedule from the response rather than on a fixed interval, so
        // the cadence follows whether the radio is actually busy.
        timer = setTimeout(
          () => void load(),
          status.tasks.length > 0 ? BUSY_REFRESH_MS : STATUS_REFRESH_MS,
        );
      } catch (cause) {
        // A 401 here means the session expired underneath us; drop to the
        // login screen rather than leaving a console that silently fails.
        if (cause instanceof ApiError && cause.status === 401) {
          if (!cancelled) setAuth("out");
          return;
        }
        if (!cancelled) timer = setTimeout(() => void load(), STATUS_REFRESH_MS);
      }
    };

    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [auth]);

  const cancelTask = useCallback(async (task: RadioTask) => {
    // Drop it from the banner at once; the next poll is authoritative, and
    // a 409 just means it finished on its own between poll and click.
    setTasks((current) => current.filter((t) => t.id !== task.id));
    try {
      await api.cancelTask(task.id);
    } catch {
      // Nothing to recover: either it was already gone, or the next poll
      // will put it back.
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setAuth("out");
      setRadio(null);
      setTasks([]);
    }
  }, []);

  if (auth === "checking") {
    return (
      <>
        <Backdrop />
        <p className="p-8 text-neutral-600">Checking session…</p>
      </>
    );
  }

  if (auth === "out") {
    return (
      <>
        <Backdrop />
        <Login onSuccess={() => setAuth("in")} />
      </>
    );
  }

  return (
    <>
      <Backdrop />
      <Layout
        radio={radio}
        tasks={tasks}
        onCancelTask={(task) => void cancelTask(task)}
        onLogout={() => void logout()}
      >
        {route.name === "node" ? (
          <NodeDetail
            nodeId={route.nodeId}
            onBack={() => navigate("/")}
            // Null until the first status poll lands. Treating "unknown" as
            // "no radio" keeps the mesh-write controls disabled until we
            // actually know, rather than offering a button that 503s.
            radioConnected={radio?.connected ?? false}
          />
        ) : (
          <Fleet onOpen={navigate} />
        )}
      </Layout>
    </>
  );
}
