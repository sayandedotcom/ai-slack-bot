"use client";

import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardHeader } from "@workspace/ui/components/card";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { cn } from "@workspace/ui/lib/utils";
import type { LucideIcon } from "lucide-react";
import { RotateCw } from "lucide-react";
import type { ReactNode } from "react";

import type { ApiError } from "@/lib/api/errors";
import type { PanelState } from "@/lib/panel-state";

export type { PanelState };

/**
 * One line, no jargon, keyed off what the reader can actually do about it. A
 * status number is never shown: 403 is not information to someone who wants to
 * know whether they can approve a reply.
 */
const REASON: Record<ApiError["kind"], string> = {
  unauthorized: "Sign in via Access to see this",
  forbidden: "You're not on the roster",
  unavailable: "The API didn't answer",
};

function PanelSkeleton() {
  return (
    <div className="space-y-2.5" aria-hidden="true">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-2/5" />
    </div>
  );
}

export type PanelProps<T> = {
  /** Set in mono, uppercase: a section label is the system naming its own parts. */
  title: string;
  state: PanelState<T>;
  children: (data: T) => ReactNode;
  /** Right of the title. A count, a caption, a link — never a second heading. */
  aside?: ReactNode;
  /** Shown under the title when the panel needs a sentence to be legible at all. */
  description?: ReactNode;
  icon?: LucideIcon;
  className?: string;
  /** Drop the Card chrome; used where the panel is already inside one. */
  bare?: boolean;
};

/**
 * Every asynchronous region of the app renders through this. Panels do not
 * invent their own spinners or error strings — they hand over a `PanelState`
 * and render only the happy path.
 */
export function Panel<T>({
  title,
  state,
  children,
  aside,
  description,
  icon: Icon,
  className,
  bare = false,
}: PanelProps<T>): ReactNode {
  const body =
    state.kind === "loading" ? (
      <div role="status" aria-label={`${title} loading`}>
        <PanelSkeleton />
      </div>
    ) : state.kind === "error" ? (
      <div
        role="alert"
        className="flex flex-wrap items-center justify-between gap-3"
      >
        <p className="text-muted-foreground text-sm">
          {REASON[state.error.kind]}
        </p>
        <Button variant="outline" size="sm" onClick={state.retry}>
          <RotateCw />
          Try again
        </Button>
      </div>
    ) : state.kind === "empty" ? (
      <p className="text-balance text-muted-foreground text-sm">{state.hint}</p>
    ) : (
      children(state.data)
    );

  if (bare) return body;

  return (
    <Card className={cn("gap-3", className)}>
      <CardHeader className="gap-1.5">
        <div className="flex items-center gap-2">
          {Icon ? (
            <Icon
              className="size-3.5 text-muted-foreground"
              aria-hidden="true"
            />
          ) : null}
          <h2 className="eyebrow">{title}</h2>
          {aside ? (
            <div className="ml-auto flex items-center gap-2">{aside}</div>
          ) : null}
        </div>
        {description ? (
          <p className="text-muted-foreground text-xs">{description}</p>
        ) : null}
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
