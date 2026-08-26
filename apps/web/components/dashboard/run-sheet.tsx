"use client";

import { Info } from "lucide-react";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@workspace/ui/components/sheet";
import { Skeleton } from "@workspace/ui/components/skeleton";

import { CopyId } from "@/components/common/copy-id";
import { OriginBadge, ShadowBadge, StatusChip } from "@/components/common/status-chip";
import { ago, usd } from "@/lib/format";
import { useRunUsage, useRuns } from "@/lib/hooks/use-dashboard-data";
import { useSelectedRun } from "@/lib/hooks/use-selected-run";

/**
 * One run, opened from `?run=`.
 *
 * It shows what `/api/runs` and `/api/runs/:id/usage` actually return, and
 * says plainly that there is no transcript. The agent layer was removed from
 * the Worker and is being rebuilt, so there is no endpoint that could stream
 * one — inventing a "Transcript" tab that renders a permanent spinner would be
 * worse than the sentence.
 */
export function RunSheet() {
  const [selected, selectRun] = useSelectedRun();
  const runs = useRuns();
  const usage = useRunUsage(selected);

  const run =
    runs.kind === "ready" ? runs.data.find((candidate) => candidate.id === selected) : undefined;

  return (
    <Sheet
      open={selected !== null}
      onOpenChange={(open) => {
        if (!open) selectRun(null);
      }}
    >
      <SheetContent className="w-full gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Run</SheetTitle>
          <SheetDescription>
            {run?.channelName
              ? `From #${run.channelName}`
              : run?.origin === "chat"
                ? "Started from the chat surface"
                : "Details for the selected run"}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-5 overflow-y-auto px-4 pb-6">
          {selected === null ? null : run === undefined ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <StatusChip status={run.status} />
                <OriginBadge origin={run.origin} />
                {run.shadow ? <ShadowBadge /> : null}
              </div>

              <p className="text-sm text-pretty">
                {run.summary ?? (
                  <span className="text-muted-foreground italic">
                    No summary — the agent was woken but has not written one yet.
                  </span>
                )}
              </p>

              <dl className="space-y-3 border-t pt-4 text-sm">
                <Row label="Run id">
                  <CopyId value={run.id} label="run id" truncate />
                </Row>
                {run.channelId ? (
                  <Row label="Channel">
                    <CopyId value={run.channelId} label="channel id" />
                  </Row>
                ) : null}
                {run.customerSlug ? (
                  <Row label="Customer">
                    <span className="machine text-xs">{run.customerSlug}</span>
                  </Row>
                ) : null}
                <Row label="Started">
                  <span className="machine text-xs text-muted-foreground">
                    {ago(run.createdAt, Date.now())}
                  </span>
                </Row>
                <Row label="Last activity">
                  <span className="machine text-xs text-muted-foreground">
                    {ago(run.updatedAt, Date.now())}
                  </span>
                </Row>
                <Row label="Spend">
                  {usage.kind === "ready" ? (
                    // The decimal string, exactly as the ledger stores it.
                    // Formatting it as a number here would round money.
                    <span className="machine text-xs">{usd(usage.data)}</span>
                  ) : usage.kind === "error" ? (
                    <span className="text-xs text-muted-foreground">unavailable</span>
                  ) : (
                    <Skeleton className="h-4 w-16" />
                  )}
                </Row>
              </dl>

              <p className="flex items-start gap-2 border-t pt-4 text-xs text-pretty text-muted-foreground">
                <Info className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                There is no transcript here because the Worker exposes no route that returns one.
                See BACKEND-GAPS.md.
              </p>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="eyebrow">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}
