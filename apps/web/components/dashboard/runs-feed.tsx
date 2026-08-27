"use client";

import { cn } from "@workspace/ui/lib/utils";
import { Activity, Hash } from "lucide-react";
import type { ReactNode } from "react";

import { Panel } from "@/components/common/panel";
import {
  OriginBadge,
  ShadowBadge,
  StatusChip,
} from "@/components/common/status-chip";
import type { RunSummary } from "@/lib/api/runs";
import { ago } from "@/lib/format";
import { useRuns } from "@/lib/hooks/use-dashboard-data";
import { useNow } from "@/lib/hooks/use-now";
import { useSelectedRun } from "@/lib/hooks/use-selected-run";

/**
 * The index of agent runs: one row per run, newest activity first.
 *
 * A row is deliberately a summary and not a preview. Everything that costs a
 * second request — the spend, the thread — lives in the detail sheet, so a list
 * of forty runs is still one request.
 */
export function RunsFeed() {
  const state = useRuns();
  const [, selectRun] = useSelectedRun();
  const now = useNow();

  return (
    <Panel
      title="Agent runs"
      icon={Activity}
      state={state}
      aside={<span className="eyebrow">open one to see its spend</span>}
    >
      {(runs) => (
        <ul className="-mx-1 space-y-0.5">
          {/* Arrives sorted by `updatedAt` DESC from the worker. We copy-sort
              anyway: correctness here must not rest on an endpoint's ordering. */}
          {[...runs]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((run) => (
              <RunRow
                key={run.id}
                run={run}
                now={now}
                onSelect={() => selectRun(run.id)}
              />
            ))}
        </ul>
      )}
    </Panel>
  );
}

function RunRow({
  run,
  now,
  onSelect,
}: {
  run: RunSummary;
  now: number;
  onSelect: () => void;
}): ReactNode {
  // The worker joins these for display; a run started from chat has neither.
  const where = run.channelName ?? run.customerSlug;

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "flex w-full flex-col gap-1.5 rounded-lg px-2.5 py-2.5 text-left transition-colors",
          "hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
        )}
      >
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip status={run.status} />
          <OriginBadge origin={run.origin} />
          {run.shadow ? <ShadowBadge /> : null}
          {where === null ? null : (
            <span className="machine inline-flex min-w-0 items-center gap-0.5 truncate text-muted-foreground text-xs">
              <Hash className="size-3 shrink-0" aria-hidden="true" />
              {where}
            </span>
          )}
          <span className="machine ml-auto shrink-0 text-muted-foreground text-xs">
            {ago(run.updatedAt, now)}
          </span>
        </div>
        <p className="line-clamp-2 text-pretty text-sm">
          {/* A run can be woken before it has said anything worth summarising;
              saying so beats an empty row that reads as a rendering bug. */}
          {run.summary ?? (
            <span className="text-muted-foreground italic">No summary yet</span>
          )}
        </p>
      </button>
    </li>
  );
}
