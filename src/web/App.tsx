import { useCallback, useEffect, useState } from "react";
import type { RadioStatus } from "../shared/types";
import { api, ApiError } from "./api";
import { useRoute } from "./router";
import { Backdrop } from "./components/Backdrop";
import { Layout } from "./components/Layout";
import { Fleet } from "./pages/Fleet";
import { Login } from "./pages/Login";
import { NodeDetail } from "./pages/NodeDetail";

/** How often the radio pill refreshes. */
const STATUS_REFRESH_MS = 15_000;

type Auth = "checking" | "in" | "out";

export function App() {
  const [auth, setAuth] = useState<Auth>("checking");
  const [radio, setRadio] = useState<RadioStatus | null>(null);
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
    const load = async () => {
      try {
        const status = await api.getStatus();
        if (!cancelled) setRadio(status.radio);
      } catch (cause) {
        // A 401 here means the session expired underneath us; drop to the
        // login screen rather than leaving a console that silently fails.
        if (cause instanceof ApiError && cause.status === 401) {
          if (!cancelled) setAuth("out");
        }
      }
    };

    void load();
    const timer = setInterval(() => void load(), STATUS_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [auth]);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setAuth("out");
      setRadio(null);
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
      <Layout radio={radio} onLogout={() => void logout()}>
        {route.name === "node" ? (
          <NodeDetail nodeId={route.nodeId} onBack={() => navigate("/")} />
        ) : (
          <Fleet onOpen={navigate} />
        )}
      </Layout>
    </>
  );
}
