import type { ReactNode } from "react";

import { Button } from "@workspace/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card";

import type { ApiError } from "../lib/api";

/**
 * Every asynchronous region of the dashboard is in exactly one of these four
 * states. Panels do not invent their own spinners or error strings — they hand
 * a `PanelState` to `Panel` and render only the happy path.
 */
export type PanelState<T> =
  | { kind: "loading" }
  | { kind: "error"; error: ApiError; retry: () => void }
  | { kind: "empty"; hint: string }
  | { kind: "ready"; data: T };

/** One line, no jargon, keyed off what the visitor can actually do about it. */
const REASON: Record<ApiError["kind"], string> = {
  unauthorized: "Sign in via Access",
  forbidden: "You're not on the roster",
  unavailable: "Backend unreachable",
};

function Skeleton() {
  return (
    <div className="space-y-2" aria-hidden="true">
      <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
      <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
    </div>
  );
}

export function Panel<T>({
  title,
  state,
  children,
}: {
  title: string;
  state: PanelState<T>;
  children: (data: T) => ReactNode;
}): ReactNode {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {state.kind === "loading" ? (
          <div role="status" aria-label={`${title} loading`}>
            <Skeleton />
          </div>
        ) : state.kind === "error" ? (
          <div role="alert" className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {REASON[state.error.kind]}
            </p>
            <Button variant="outline" size="sm" onClick={state.retry}>
              Retry
            </Button>
          </div>
        ) : state.kind === "empty" ? (
          <p className="text-sm text-muted-foreground">{state.hint}</p>
        ) : (
          children(state.data)
        )}
      </CardContent>
    </Card>
  );
}
