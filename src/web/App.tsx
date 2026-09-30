import { useCallback, useEffect, useState } from "react";
import type {
  DiscoverySummary,
  RadioOccupancy,
  RadioStatus,
  RadioTask,
  SessionUser,
} from "../shared/types";
import { canAdminister, canOperateRadio } from "../shared/roles";
import { api, ApiError } from "./api";
import { useRoute } from "./router";
import { Backdrop } from "./components/Backdrop";
import { Layout } from "./components/Layout";
import { Admin } from "./pages/Admin";
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
  const [user, setUser] = useState<SessionUser | null>(null);
  const [radio, setRadio] = useState<RadioStatus | null>(null);
  const [tasks, setTasks] = useState<RadioTask[]>([]);
  const [radioBusy, setRadioBusy] = useState<RadioOccupancy | null>(null);
  const [discovery, setDiscovery] = useState<DiscoverySummary | null>(null);
  const [route, navigate] = useRoute();

  useEffect(() => {
    void api
      .getSession()
      .then((session) => {
        setUser(session.user);
        setAuth(session.authenticated ? "in" : "out");
      })
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
        setRadioBusy(status.radioBusy);
        setDiscovery(status.discovery);
        // Reschedule from the response rather than on a fixed interval, so
        // the cadence follows whether the radio is actually busy.
        // Follows `radioBusy`, not `tasks`: a background sweep disables
        // controls without appearing in the banner, and leaving those
        // disabled for 15s after it finished reads as a broken button.
        timer = setTimeout(
          () => void load(),
          status.radioBusy ? BUSY_REFRESH_MS : STATUS_REFRESH_MS,
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
      setUser(null);
      setRadio(null);
      setTasks([]);
      setRadioBusy(null);
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

  // `auth === "in"` without a user would mean the session endpoint answered
  // affirmatively but told us nothing about who we are; treat it as signed
  // out rather than rendering a shell with no identity.
  if (auth === "out" || user === null) {
    return (
      <>
        <Backdrop />
        <Login
          onSuccess={() =>
            void api.getSession().then((session) => {
              setUser(session.user);
              setAuth("in");
            })
          }
        />
      </>
    );
  }

  return (
    <>
      <Backdrop />
      <Layout
        radio={radio}
        tasks={tasks}
        user={user}
        onCancelTask={(task) => void cancelTask(task)}
        onNavigate={navigate}
        onLogout={() => void logout()}
      >
        {route.name === "admin" ? (
          // A deep link to /admin is reachable by anyone signed in, so the
          // route refuses rather than rendering a shell whose every request
          // 403s. The server is still the actual guard.
          canAdminister(user.role) ? (
            <Admin currentUser={user} onBack={() => navigate("/")} />
          ) : (
            <NotPermitted role={user.role} onBack={() => navigate("/")} />
          )
        ) : route.name === "node" ? (
          <NodeDetail
            nodeId={route.nodeId}
            onBack={() => navigate("/")}
            // Deliberately two props, not one conjunction. A viewer and an
            // operator with an unplugged radio are both "cannot write", but
            // they need different words for it: the viewer should not be told
            // to go and check the radio, and hiding a control from an
            // operator whose radio is merely absent would look like a
            // permissions problem. The page shows nothing to a viewer and a
            // disabled control with the real reason to an operator.
            //
            // Null until the first status poll lands; treating "unknown" as
            // "no radio" keeps mesh controls disabled until we actually know,
            // rather than offering a button that 503s.
            radioConnected={radio?.connected ?? false}
            canOperate={canOperateRadio(user.role)}
            radioBusy={radioBusy}
          />
        ) : (
          <Fleet onOpen={navigate} discovery={discovery} />
        )}
      </Layout>
    </>
  );
}

function NotPermitted({
  role,
  onBack,
}: {
  role: SessionUser["role"];
  onBack: () => void;
}) {
  return (
    <div className="card p-8 text-center">
      <h2 className="text-lg font-semibold text-white">Not available</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-neutral-500">
        Administration requires the admin role. You are signed in as{" "}
        <span className="text-amber-500/80">{role}</span>.
      </p>
      <button
        type="button"
        onClick={onBack}
        className="mt-4 rounded-lg border border-neutral-800 px-3 py-1.5 text-sm text-neutral-400 transition [corner-shape:bevel] hover:border-amber-500/40 hover:text-amber-400"
      >
        Back to the fleet
      </button>
    </div>
  );
}
