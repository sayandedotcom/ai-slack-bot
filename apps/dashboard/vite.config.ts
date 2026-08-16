import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { devAccessStubs } from "./dev-stubs";

/**
 * One origin, always. The SPA calls relative `/api/...` paths in every
 * environment, so there is no backend URL in the bundle and no CORS anywhere:
 * in production the Worker serves both halves, and in development this proxy
 * stands in for that, forwarding `/api`, `/ws` and `/agents` to `wrangler dev`'s
 * 8787.
 *
 * `/agents` is phase 25's addition: it is the Agents SDK's own transport for
 * `RunAgent` — the WebSocket `useAgentChat` speaks plus the `/get-messages` read
 * behind it — and it is a top-level path, so without an entry here it would hit
 * vite's SPA fallback and answer the socket handshake with `index.html`.
 */
export default defineConfig({
  // `devAccessStubs` is `apply: "serve"` — it answers the Access-gated routes
  // in dev so the grid renders at all, and does not exist in a build.
  plugins: [react(), tailwindcss(), devAccessStubs()],
  server: {
    proxy: {
      "/api": "http://localhost:8787",
      "/ws": { target: "ws://localhost:8787", ws: true },
      // `http://`, not `ws://`, and `ws: true` alongside: this one path carries
      // BOTH the upgrade and a plain `GET .../get-messages`, so the target has
      // to be usable by the ordinary proxy as well as the upgrade handler.
      "/agents": { target: "http://localhost:8787", ws: true },
    },
  },
});
