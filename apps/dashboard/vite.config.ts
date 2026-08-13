import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { devAccessStubs } from "./dev-stubs";

/**
 * One origin, always. The SPA calls relative `/api/...` paths in every
 * environment, so there is no backend URL in the bundle and no CORS anywhere:
 * in production the Worker serves both halves, and in development this proxy
 * stands in for that, forwarding `/api` and `/ws` to `wrangler dev`'s 8787.
 */
export default defineConfig({
  // `devAccessStubs` is `apply: "serve"` — it answers the Access-gated routes
  // in dev so the grid renders at all, and does not exist in a build.
  plugins: [react(), tailwindcss(), devAccessStubs()],
  server: {
    proxy: {
      "/api": "http://localhost:8787",
      "/ws": { target: "ws://localhost:8787", ws: true },
    },
  },
});
