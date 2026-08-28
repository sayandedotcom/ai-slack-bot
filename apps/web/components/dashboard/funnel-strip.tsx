"use client";

import { Button } from "@workspace/ui/components/button";
import { cn } from "@workspace/ui/lib/utils";
import { Gauge } from "lucide-react";

import { Empty } from "@/components/common/empty";
import { SectionHeader } from "@/components/common/section-header";
import {
  type Counters,
  type CountersWindow,
  funnelStages,
  isQuiet,
} from "@/lib/api/counters";
import type { PanelState } from "@/lib/panel-state";

const WINDOWS: readonly CountersWindow[] = ["24h", "7d"];

/**
 * The thesis of the whole system, rendered as the shape it actually is: an
 * ATTENUATION. A cheap model hears everything the team hears so an expensive
 * one wakes rarely, and a human is interrupted rarer still — so each stage
 * carries a bar scaled against `heard`, and the bars visibly collapse across
 * the row. The accent is spent on exactly one stage, `escalated` — the only
 * one that costs somebody's attention.
 *
 * Every ratio comes from `funnelStages`, which clamps to [0, 1] and never
 * divides by zero — this component does no arithmetic of its own. That is
 * deliberate: the old dashboard once rendered a literal `NaN` width here.
 */
export function FunnelStrip({
  state,
  window,
  onWindow,
}: {
  state: PanelState<Counters>;
  window: CountersWindow;
  onWindow: (w: CountersWindow) => void;
}) {
  const switcher = (
    <div className="flex gap-1">
      {WINDOWS.map((w) => (
        <Button
          key={w}
          type="button"
          variant={w === window ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={w === window}
          onClick={() => onWindow(w)}
        >
          {w}
        </Button>
      ))}
    </div>
  );

  return (
    <section className="space-y-3">
      <SectionHeader
        eyebrow={`Last ${window}`}
        title="How little reaches a human"
        action={switcher}
      />

      {state.kind === "ready" ? (
        isQuiet(state.data.counters) ? (
          <Empty
            icon={Gauge}
            title="Quiet"
            hint="Nothing was heard in this window. That is the good outcome."
          />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-4">
              {funnelStages(state.data.counters).map((stage) => (
                <div key={stage.key} className="min-w-0 space-y-1.5">
                  <div
                    className={cn(
                      "machine font-medium text-2xl tabular-nums leading-none",
                      stage.accent && "text-attention"
                    )}
                  >
                    {stage.value}
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {stage.label}
                  </div>
                  <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      data-slot="funnel-bar"
                      className={cn(
                        "h-full min-w-[3px] rounded-full",
                        stage.accent ? "bg-attention" : "bg-muted-foreground/60"
                      )}
                      style={{
                        width: `${Math.max(stage.ratio * 100, 0.8)}%`,
                      }}
                    />
                  </div>
                  {stage.key === "triaged" ? (
                    <p className="text-[11px] text-muted-foreground italic">
                      {state.data.counters.dropped} dropped
                    </p>
                  ) : null}
                </div>
              ))}
            </div>

            <p className="text-muted-foreground text-xs">
              Last {window}, since{" "}
              <time
                className="machine"
                dateTime={new Date(state.data.since).toISOString()}
              >
                {new Date(state.data.since).toLocaleString()}
              </time>
            </p>
          </>
        )
      ) : state.kind === "error" ? (
        <p className="text-muted-foreground text-sm" role="alert">
          Counters didn&apos;t load.
        </p>
      ) : (
        <div
          className="h-20 animate-pulse rounded-lg bg-muted"
          aria-hidden="true"
        />
      )}
    </section>
  );
}
