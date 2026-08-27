import { type NextRequest, NextResponse } from "next/server";

/**
 * LOCAL DEVELOPMENT ONLY. The bridge that lets `next dev` talk to the REAL
 * Worker instead of `lib/fixtures`.
 *
 * The problem it solves, precisely. `apps/worker` reads its identity from the
 * `Cf-Access-Jwt-Assertion` header — see `src/api/identity.ts` and
 * `src/api/approvals.ts`, which are the only two readers — and that header is
 * put there by Cloudflare Access itself, at its edge, after Access has
 * authenticated the request. Nothing downstream of Access can mint it. So a
 * request from `localhost:3000` that reaches the Worker's origin does not get
 * a 401 from our code at all: it gets a `302` from Access, to a login page,
 * which `lib/api/client.ts` then reports as a failure. Confirmed by hand:
 *
 *   $ curl -sI https://firefighter.sayandeten.workers.dev/api/identity
 *   HTTP/2 302
 *   location: https://zellify-firefighter.cloudflareaccess.com/cdn-cgi/access/login/…
 *
 * Access does accept one credential on a programmatic request: a valid user
 * token in `cf-access-token`. It verifies that token, and — this is the part
 * that matters — then injects `Cf-Access-Jwt-Assertion` exactly as it would
 * for a browser session, so the Worker's verifier, roster check and
 * fire-fighter gate all run unchanged. No Worker code knows this file exists.
 *
 * Get a token by authenticating as yourself, which is the point — the roster
 * check is on YOUR email, and `PATCH` routes want a fire-fighter:
 *
 *   cloudflared access login https://firefighter.sayandeten.workers.dev
 *   cloudflared access token --app=https://firefighter.sayandeten.workers.dev
 *
 * Put the result in `apps/web/.env.local` as `CF_ACCESS_TOKEN` (gitignored by
 * the root `.env*` rule) and restart `next dev`. It is short-lived; when the
 * dashboard starts answering "Signed out" again, mint another.
 *
 * WHAT THIS DOES NOT FIX: the run socket. A WebSocket upgrade does not travel
 * through a Next rewrite, so `/runs/:id` dials the Worker's host directly from
 * the browser, where this middleware has no reach and a browser cannot attach
 * a custom header to a handshake anyway. Live transcripts stay a
 * same-origin-only feature. See BACKEND-GAPS.md §1 and §4.
 *
 * NEVER SET `CF_ACCESS_TOKEN` ON VERCEL. It is a bearer credential for a real
 * person's Access session; a deployment holding one would let every visitor
 * act as that person against production. The variable is deliberately not
 * `NEXT_PUBLIC_`, so it stays server-side and out of the bundle, and this file
 * is inert without it — which is why the check below is presence, not a flag.
 */
export default function proxy(request: NextRequest) {
  const token = process.env.CF_ACCESS_TOKEN;
  if (!token) return NextResponse.next();

  // Cloned rather than mutated: `request.headers` is immutable, and the
  // `request.headers` option is what Next forwards to the rewrite destination.
  const headers = new Headers(request.headers);
  headers.set("cf-access-token", token);
  return NextResponse.next({ request: { headers } });
}

/**
 * The two paths `next.config.ts` rewrites, and nothing else. A matcher that
 * caught page routes would attach the credential to requests that never leave
 * this origin, which is pointless rather than dangerous — but the narrower
 * matcher is also the honest description of what the file is for.
 */
export const config = {
  matcher: ["/api/:path*", "/proofs/:path*"],
};
