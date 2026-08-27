/**
 * Where the run socket connects, which is NOT where the REST calls go.
 *
 * Everything else in `lib/api` uses a relative path and lets `next.config.ts`
 * rewrite it onto the Worker. A rewrite cannot do the same for the run socket:
 * Next's rewrites proxy an HTTP request and do not carry a WebSocket upgrade
 * through, and on Vercel there is no upgrade path at all. So the browser has to
 * address the Worker's own host, and that host has to be in the bundle.
 *
 * Hence a second, PUBLIC variable. It is a hostname and nothing else — no
 * credential travels with it, and the socket is still gated on the Worker side:
 * `src/api/agents.ts` runs `requireTeamMember` before it names the object.
 *
 * The cross-origin caveat is the one BACKEND-GAPS.md §1 records for every other
 * request, and it bites harder here. A WebSocket handshake is a subresource
 * request, so a `SameSite=Lax` Access cookie is not attached to it even when
 * the reader is signed in on that hostname in another tab.
 */

/**
 * The host to open the socket against, or `undefined` for "this origin".
 *
 * Undefined is right exactly when the app is served from the Worker's own host,
 * which is how the Vite dashboard works; partysocket then falls back to
 * `window.location.host`. It is also what demo mode uses, because demo mode
 * opens no socket at all.
 */
export function socketHost(): string | undefined {
  // Inlined by Next at build time, so this is a constant in the bundle.
  const origin = process.env.NEXT_PUBLIC_WORKER_ORIGIN;
  if (origin === undefined || origin === "") return undefined;
  // partysocket strips the scheme itself and picks ws/wss from whether the host
  // looks local (`partysocket/dist/index.js:32`), so an origin with its scheme
  // is a valid value here and is the friendlier thing to ask someone to paste.
  return origin.replace(/\/+$/, "");
}
