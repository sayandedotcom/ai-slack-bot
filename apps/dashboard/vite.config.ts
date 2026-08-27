import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { devAccessStubs } from "./dev-stubs";

/**
 * One origin, always. The SPA calls relative `/api/...` paths in every
 * environment, so there is no backend URL in the bundle and no CORS anywhere:
 * in production the Worker serves both halves, and in development this proxy
 * stands in for that, forwarding `/api` and `/ws` to `wrangler dev`'s 8787.
 *
 * `/api` now carries the run SOCKET as well as the JSON routes
 * (`/api/runs/:id/agent`), which is why it needs `ws: true` and an object
 * form: the agent transport moved under `/api` so it inherits the dashboard's
 * own Access application rather than being a second top-level path somebody
 * has to remember to gate. `http://`, not `ws://`, because this one prefix
 * carries BOTH the upgrade and ordinary JSON — the target has to be usable by
 * the plain proxy as well as the upgrade handler.
 */
export default defineConfig({
  // `devAccessStubs` is `apply: "serve"` — it answers the Access-gated routes
  // in dev so the grid renders at all, and does not exist in a build.
  plugins: [react(), tailwindcss(), devAccessStubs()],
  server: {
    proxy: {
      "/api": { target: "http://localhost:8787", ws: true },
      "/ws": { target: "ws://localhost:8787", ws: true },
    },
  },
});
