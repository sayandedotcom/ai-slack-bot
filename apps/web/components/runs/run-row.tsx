"use client";

import { StatusBadge } from "@workspace/ui/components/status-badge";
import { cn } from "@workspace/ui/lib/utils";
import { Hand } from "lucide-react";
import Link from "next/link";

import type { RunSummary } from "@/lib/api/runs";
import { ago, usd } from "@/lib/format";
import { runStatusBadge, SHADOW_BADGE } from "@/lib/status";

/** One run in the list. Dense: a status dot, one line of the customer's words, and the machine facts under it. */
export function RunRow({
  run,
  selected,
  now,
  href,
}: {
  run: RunSummary;
  selected: boolean;
  now: number;
  href: string;
}) {
  const status = runStatusBadge(run.status);
  return (
    <li>
      <Link
        href={href}
        aria-current={selected ? "page" : undefined}
        className={cn(
          "block rounded-md border border-transparent px-3 py-2 transition-colors hover:bg-muted/60",
          selected && "border-border bg-muted"
        )}
      >
        <div className="flex items-start gap-2">
          <StatusBadge
            variant="dot"
            tone={status.tone}
            pulse={status.pulse}
            className="mt-1.5"
            aria-label={status.label}
          />
          <div className="min-w-0 flex-1">
            <p
              className={cn(
                "truncate text-sm",
                run.summary === null && "text-muted-foreground italic"
              )}
            >
              {run.summary ?? "No summary yet"}
            </p>
            <div className="machine mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
              {run.channelName ? (
                <span className="truncate">#{run.channelName}</span>
              ) : (
                <span>{run.origin}</span>
              )}
              <span aria-hidden="true">·</span>
              <span>{ago(run.updatedAt, now)}</span>
              <span aria-hidden="true">·</span>
              <span>{usd(run.costUsd)}</span>
              {run.shadow ? (
                <StatusBadge
                  tone={SHADOW_BADGE.tone}
                  size="sm"
                  mono
                  className="ml-auto"
                >
                  shadow
                </StatusBadge>
              ) : null}
            </div>
          </div>
          {run.openApprovalId !== null ? (
            <Hand
              className="mt-1 size-3.5 shrink-0 text-attention"
              aria-label="needs a decision"
            />
          ) : null}
        </div>
      </Link>
    </li>
  );
}
