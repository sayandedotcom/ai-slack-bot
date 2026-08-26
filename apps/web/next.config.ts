import type { NextConfig } from "next";

/**
 * The Vite dashboard has no backend URL in its bundle: it calls relative
 * `/api/...`, the Worker serves both halves from one origin, and Cloudflare
 * Access gates that origin so the browser already carries the cookie. There is
 * no CORS anywhere, and there is no token in the JavaScript.
 *
 * This app keeps the same contract — every caller in `lib/api` uses a relative
 * path — and the rewrite below is what stands in for the Worker's one-origin
 * property when the app is served from somewhere else (Vercel, `next dev`).
 *
 * It is deliberately NOT a fix for authentication. A rewrite proxies the
 * REQUEST; the request never carried `CF_Authorization` in the first place,
 * because that cookie is scoped to the Worker's hostname. See BACKEND-GAPS.md
 * §1 — until the backend answers that, `NEXT_PUBLIC_DEMO=1` is what renders.
 */
const workerOrigin = process.env.WORKER_ORIGIN?.replace(/\/+$/, "");
const demo = process.env.NEXT_PUBLIC_DEMO === "1";

const nextConfig: NextConfig = {
  // `@workspace/ui` ships raw .tsx from `src/`, with no build step of its own.
  transpilePackages: ["@workspace/ui"],

  async rewrites() {
    // Demo mode never touches the network, so a rewrite would only be a way to
    // send a stray request somewhere unexpected.
    if (demo || !workerOrigin) return [];
    return [
      { source: "/api/:path*", destination: `${workerOrigin}/api/:path*` },
      // Access-bypassed on the Worker; a proof link pasted into Slack has to
      // resolve without a login redirect, and it resolves here too.
      { source: "/proofs/:path*", destination: `${workerOrigin}/proofs/:path*` },
    ];
  },
};

export default nextConfig;
