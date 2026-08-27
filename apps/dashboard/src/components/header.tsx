import { useEffect, useState } from "react";

import { Button } from "@workspace/ui/components/button";

import { ApiError, getIdentity } from "../lib/api";
import type { Identity } from "../lib/api";

/**
 * Identity is fetched once, at the shell, and passed down. The header itself
 * never fetches — it only renders what it is given.
 */
export function Header({ identity }: { identity?: Identity }) {
  return (
    <header className="flex items-center justify-between border-b px-6 py-4">
      <span className="text-sm font-semibold tracking-tight">Fire-Fighter</span>
      {identity ? (
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          {identity.email}
          <span className="rounded-full border bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
            {identity.role}
          </span>
        </span>
      ) : null}
    </header>
  );
}

/**
 * One fetch of `/api/identity` at mount — no polling. Who you are does not
 * change while the tab is open; Access decides it before the bundle loads.
 */
export function useIdentity(): { identity?: Identity; error?: ApiError } {
  const [result, setResult] = useState<{
    identity?: Identity;
    error?: ApiError;
  }>({});

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const identity = await getIdentity();
        if (alive) setResult({ identity });
      } catch (cause) {
        if (!alive) return;
        setResult({
          error:
            cause instanceof ApiError
              ? cause
              : new ApiError(0, "unavailable", "/api/identity"),
        });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return result;
}

/** Heading and body per failure kind — the whole page, not a per-panel banner. */
const SIGNED_OUT: Record<ApiError["kind"], { heading: string; body: string }> =
  {
    unauthorized: {
      heading: "Signed out",
      body: "Reload to re-authenticate with Access.",
    },
    forbidden: {
      heading: "Not on the roster",
      body: "This account isn't on the fire-fighter roster.",
    },
    unavailable: {
      heading: "Backend unreachable",
      body: "The API did not answer. Reload to try again.",
    },
  };

/**
 * Rendered by the shell *instead of* the whole panel grid when identity fails.
 * If `/api/identity` says 401 or 403, every other panel would fail in exactly
 * the same way — one honest full-page message beats four separately-broken
 * panels each blaming its own endpoint. There is no sign-in button, because
 * Access gates the origin: the SPA can only display identity, never grant it.
 */
export function SignedOutPage({ error }: { error: ApiError }) {
  const { heading, body } = SIGNED_OUT[error.kind] ?? SIGNED_OUT.unavailable;

  return (
    <div
      role="alert"
      className="flex min-h-svh flex-col items-center justify-center gap-3 px-6 text-center"
    >
      <h1 className="text-lg font-semibold tracking-tight">{heading}</h1>
      <p className="max-w-sm text-sm text-muted-foreground">{body}</p>
      <Button variant="outline" size="sm" onClick={() => location.reload()}>
        Reload
      </Button>
    </div>
  );
}
