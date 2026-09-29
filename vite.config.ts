import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const abs = (p: string) => fileURLToPath(new URL(p, import.meta.url));

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
      "/api": {
        target: "http://127.0.0.1:8080",
        changeOrigin: false,
      },
    },
    watch: {
      // Bind-mounted volumes don't reliably deliver native change events.
      usePolling: process.env.DOCKER === "true",
    },
  },
});
