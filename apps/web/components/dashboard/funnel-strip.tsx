"use client";

import { Card, CardContent } from "@workspace/ui/components/card";
import { Skeleton } from "@workspace/ui/components/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip";
import { cn } from "@workspace/ui/lib/utils";
import { ChevronRight } from "lucide-react";

import { type Counters, deriveFunnel, type Funnel } from "@/lib/api/counters";
import type { PanelState } from "@/lib/panel-state";

/**
 * The thesis of the whole system, rendered as the shape it actually is.
 *
 * Four stat tiles with big numbers would say "here are four numbers". What is
 * true is an ATTENUATION: a cheap model hears everything the team hears so an
 * expensive one wakes rarely, and a human is interrupted rarer still. So each
 * stage carries a bar scaled against `seen`, and the bars visibly collapse
 * across the row. The ember is spent on exactly one stage — `escalated` — the
 * only one that means a person has to do something.
 */
type Stage = {
  key: keyof Funnel;
  label: string;
  meaning: string;
  /** Derived stages are not counted by anyone and must say so. */
  derived?: boolean;
  accent?: boolean;
};

const STAGES: Stage[] = [
  {
    key: "seen",
    label: "heard",
    meaning:
      "Every message in a channel the agent watches. Stored verbatim with its permalink.",
  },
  {
    key: "triaged",
    label: "triaged",
    meaning:
      "Read by the cheap model, which decides only whether the expensive one should wake.",
  },
  {
    key: "dropped",
    label: "dropped",
    meaning:
      "Triaged and judged not worth waking the main agent. Derived as triaged minus woken — the endpoint does not count it.",
    derived: true,
  },
  {
    key: "woken",
    label: "woke the agent",
    meaning: "Threads the main model actually worked on.",
  },
  {
    key: "escalated",
    label: "escalated",
    meaning:
      "Drafts a human was asked to approve. The only stage that costs somebody's attention.",
    accent: true,
  },
];

export function FunnelStrip({ state }: { state: PanelState<Counters> }) {
  if (state.kind !== "ready") {
    return (
      <Card>
        <CardContent>
          {state.kind === "error" ? (
            <p className="text-muted-foreground text-sm" role="alert">
              Counters didn&apos;t load.
            </p>
          ) : (
            <Skeleton className="h-12 w-full" />
          )}
        </CardContent>
      </Card>
    );
  }

  const funnel = deriveFunnel(state.data.counters);
  // Everything is scaled against what came in. A denominator of zero means a
  // quiet day, not a division to guard against downstream.
  const scale = Math.max(funnel.seen, 1);

  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:gap-1">
          {STAGES.map((stage, index) => {
            const value = funnel[stage.key];
            const ratio = value / scale;

            return (
              <div key={stage.key} className="flex flex-1 items-end gap-1">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <div className="min-w-0 flex-1 cursor-default space-y-1" />
                    }
                  >
                    {/* Number over label, not beside it: at five stages across
                        one row, sharing a line clips the longer labels. */}
                    <div
                      className={cn(
                        "machine font-medium text-2xl tabular-nums leading-none",
                        stage.accent && "text-primary"
                      )}
                    >
                      {value}
                    </div>
                    <div
                      className={cn(
                        "pb-1 text-xs",
                        stage.derived
                          ? "text-muted-foreground/70 italic"
                          : "text-muted-foreground"
                      )}
                    >
                      {stage.label}
                    </div>
                    {/*
                      The bar is the argument. `min-w` keeps a stage of 1 out of
                      148 visible — an invisible last stage would read as zero,
                      which is the opposite of the point.
                    */}
                    <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn(
                          "h-full min-w-[3px] rounded-full",
                          stage.accent
                            ? "bg-primary"
                            : stage.derived
                              ? "bg-muted-foreground/30"
                              : "bg-muted-foreground/60"
                        )}
                        style={{ width: `${Math.max(ratio * 100, 0.8)}%` }}
                      />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>{stage.meaning}</TooltipContent>
                </Tooltip>

                {index < STAGES.length - 1 ? (
                  <ChevronRight
                    className="mb-0.5 hidden size-3.5 shrink-0 text-muted-foreground/40 sm:block"
                    aria-hidden="true"
                  />
                ) : null}
              </div>
            );
          })}
        </div>

        <p className="text-muted-foreground text-xs">
          Last 24 hours, since{" "}
          <time
            className="machine"
            dateTime={new Date(state.data.since).toISOString()}
          >
            {new Date(state.data.since).toLocaleString()}
          </time>
        </p>
      </CardContent>
    </Card>
  );
}
