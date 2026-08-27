"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip";
import { cn } from "@workspace/ui/lib/utils";
import type { ReactNode } from "react";

import type { RunStatus } from "@/lib/api/runs";

/**
 * Statuses that mean "something is happening right now, and it may be waiting
 * on you". These are the only rows that pulse; a pulse on a finished run would
 * train an operator to ignore the one signal that matters.
 */
const LIVE: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "live",
  "awaiting_approval",
]);

const LABEL: Record<RunStatus, string> = {
  live: "live",
  awaiting_approval: "awaiting approval",
  idle: "idle",
  done: "done",
  failed: "failed",
};

/** What the status actually means for the reader, not what it means in the schema. */
const MEANING: Record<RunStatus, string> = {
  live: "The agent is working on this thread right now",
  awaiting_approval: "The agent has drafted a reply and is waiting on a human",
  idle: "Woken, then nothing further to do — it will resume if the thread moves",
  done: "Finished; the thread was answered or closed",
  failed: "The run stopped on an error and did not recover",
};

const TONE: Record<RunStatus, string> = {
  live: "border-success/40 bg-success/10 text-success",
  awaiting_approval: "border-warning/40 bg-warning/10 text-warning",
  idle: "border-border bg-muted text-muted-foreground",
  done: "border-border bg-muted text-muted-foreground",
  failed: "border-destructive/40 bg-destructive/10 text-destructive",
};

export function StatusChip({ status }: { status: RunStatus }): ReactNode {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "machine inline-flex cursor-default items-center gap-1.5 rounded-full border px-2 py-0.5 font-medium text-[11px]",
              TONE[status]
            )}
          />
        }
      >
        {LIVE.has(status) ? (
          // Two layers: a steady dot so the state is readable when the OS is set
          // to reduce motion, plus a ping that draws the eye across the list.
          <span className="relative flex size-1.5" aria-hidden="true">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-70" />
            <span className="relative inline-flex size-1.5 rounded-full bg-current" />
          </span>
        ) : null}
        {LABEL[status]}
      </TooltipTrigger>
      <TooltipContent>{MEANING[status]}</TooltipContent>
    </Tooltip>
  );
}

/** Where a run came from: a Slack thread, or somebody typing on the chat page. */
export function OriginBadge({ origin }: { origin: string }): ReactNode {
  return (
    <span className="machine rounded border border-border bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
      {origin}
    </span>
  );
}

/**
 * Violet, and only ever here. A shadow run is not a status — it is a different
 * KIND of run, one whose writes reach nobody — so it gets a hue no status uses.
 */
export function ShadowBadge({ label }: { label?: string }): ReactNode {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="machine cursor-default rounded border border-shadow-run/40 bg-shadow-run/10 px-1.5 py-0.5 text-[11px] text-shadow-run" />
        }
      >
        {label ?? "shadow"}
      </TooltipTrigger>
      <TooltipContent>
        Shadow run — it drafts and reasons, but nothing it does reaches a
        customer.
      </TooltipContent>
    </Tooltip>
  );
}
