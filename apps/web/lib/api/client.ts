/**
 * The app's only door to the network. Components never call `fetch`
 * themselves: every request goes through here, so there is exactly one place
 * that decides how a failure is classified and exactly one place that can leak.
 *
 * Paths are always relative. In production `next.config.ts` rewrites `/api/*`
 * to the Worker, so no backend URL and no token ever reaches the bundle — the
 * same property the Vite dashboard gets for free by sharing an origin.
 */

import { ApiError, kindFor } from "./errors";

/**
 * True when the app is running on fixtures instead of the network.
 *
 * `process.env.NEXT_PUBLIC_DEMO` is inlined by Next at build time, so this is
 * a constant in the client bundle rather than a runtime lookup — the whole
 * fixture tree is dropped by the minifier in a live build.
 */
export function isDemo(): boolean {
  return process.env.NEXT_PUBLIC_DEMO === "1";
}

/**
 * How long a fixture takes to "arrive". Two reasons it is not zero:
 *
 * 1. A panel that never renders its skeleton is a panel whose skeleton nobody
 *    has ever seen. Demo mode should exercise the same four states a live
 *    deployment does.
 * 2. `Promise.resolve()` settles in a microtask, which can land in the middle
 *    of React's hydration pass — the query flips to `ready` between the server
 *    HTML and the client's hydration render, and React reports a mismatch.
 *    A real tick puts the resolution safely after hydration.
 */
const FIXTURE_LATENCY_MS = 220;

/** Resolve a fixture as though it had crossed a network. */
export function fixture<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), FIXTURE_LATENCY_MS));
}

/** GET a relative JSON endpoint. Throws `ApiError` for anything that is not a parsed 2xx. */
export async function getJson<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      headers: { accept: "application/json" },
      credentials: "same-origin",
    });
  } catch {
    // Status 0: there was no HTTP response at all.
    throw new ApiError(0, "unavailable", path);
  }

  if (!response.ok) throw new ApiError(response.status, kindFor(response.status), path);

  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError(response.status, "unavailable", path);
  }
}

/** POST a relative JSON endpoint. Mirrors `getJson`; the gate is `ok`, not `=== 200`. */
export async function postJson<T>(path: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "unavailable", path);
  }

  if (!response.ok) throw new ApiError(response.status, kindFor(response.status), path);

  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError(response.status, "unavailable", path);
  }
}

/**
 * PATCH a relative JSON endpoint, returning the status alongside the parsed
 * body so the caller can treat a 409 as data rather than as an exception. The
 * approvals conflict — "someone else decided first, and here is what they
 * chose" — is an answer the UI has to render, not a failure.
 */
export async function patchJson(
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "PATCH",
      headers: { accept: "application/json", "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "unavailable", path);
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new ApiError(response.status, kindFor(response.status), path);
  }

  return { status: response.status, body: parsed };
}
