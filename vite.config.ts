import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { parse as parseYaml } from "yaml";

const abs = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Where the API server is listening in dev.
 *
 * Read from the same `config/config.yaml` the server reads rather than
 * hardcoded, because the two silently disagreeing is a miserable thing to
 * debug: Vite happily proxies to whatever else answers on the stale port
 * and you get somebody else's HTTP errors in your browser console.
 * `MFM_API_PORT` overrides, for running the API somewhere else entirely.
 */
function apiPort(): number {
  const override = Number(process.env.MFM_API_PORT);
  if (Number.isInteger(override) && override > 0) return override;

  try {
    const parsed = parseYaml(readFileSync(abs("./config/config.yaml"), "utf8")) as {
      server?: { port?: number };
    } | null;
    const port = parsed?.server?.port;
    if (Number.isInteger(port) && (port as number) > 0) return port as number;
  } catch {
    // No config yet, or unreadable. The server would refuse to start on a
    // bad config anyway, so fall through to the documented default.
  }
  return 8080;
}

/**
 * The web UI is a single-page app served by the Fastify process in
 * production, so it builds into `dist/web` next to `dist/server`.
 *
 * In development Vite serves it on :5173 and proxies `/api` to the server
 * on :8080, which keeps the session cookie same-origin -- a cross-origin
 * setup would need CORS plus `SameSite=None`, and the cookie is
 * `SameSite=strict` on purpose.
 */
export default defineConfig({
  root: abs("./src/web"),
  plugins: [react(), tailwindcss()],
  build: {
    outDir: abs("./dist/web"),
    emptyOutDir: true,
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      /*
       * Anchored on the trailing slash, and a regex rather than the bare
       * "/api" prefix, because a plain string key is a *prefix* match:
       * "/api" also captures `/api.ts`, which is how Vite serves
       * `src/web/api.ts` to the browser in dev. That request got proxied
       * to Fastify instead of compiled, and the module load failed with a
       * 400. Every real endpoint lives under `/api/`, so this is exact.
       */
      "^/api/": {
        target: `http://127.0.0.1:${apiPort()}`,
        changeOrigin: false,
      },
    },
    watch: {
      // Bind-mounted volumes don't reliably deliver native change events.
      usePolling: process.env.DOCKER === "true",
    },
  },
});
