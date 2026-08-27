"use client";

import { Button } from "@workspace/ui/components/button";
import { Flame, RotateCw } from "lucide-react";

import type { ApiError } from "@/lib/api/errors";

/**
 * Rendered INSTEAD of the whole page when identity fails.
 *
 * If `/api/identity` answers 401 or 403, every other panel would fail in
 * exactly the same way — one honest full-page message beats eight separately
 * broken panels each blaming its own endpoint. There is no sign-in button,
 * because Access gates the origin: this app can display an identity, never
 * grant one.
 */
const SIGNED_OUT: Record<ApiError["kind"], { heading: string; body: string }> =
  {
    unauthorized: {
      heading: "Signed out",
      body: "Access didn't recognise this session. Reload to authenticate again.",
    },
    forbidden: {
      heading: "Not on the roster",
      body: "This account isn't a fire-fighter or a viewer, so there's nothing here for it.",
    },
    unavailable: {
      heading: "The API didn't answer",
      body: "Nothing on this page can load until it does. Reload to try again.",
    },
  };

export function SignedOutPage({ error }: { error: ApiError }) {
  const { heading, body } = SIGNED_OUT[error.kind] ?? SIGNED_OUT.unavailable;

  return (
    <div
      role="alert"
      className="flex min-h-svh flex-col items-center justify-center gap-4 px-6 text-center"
    >
      <Flame className="size-6 text-primary" aria-hidden="true" />
      <div className="space-y-1.5">
        <h1 className="font-semibold text-lg tracking-tight">{heading}</h1>
        <p className="max-w-sm text-balance text-muted-foreground text-sm">
          {body}
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={() => location.reload()}>
        <RotateCw />
        Reload
      </Button>
    </div>
  );
}
