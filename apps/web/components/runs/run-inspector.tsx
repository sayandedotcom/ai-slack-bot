"use client";

import { Skeleton } from "@workspace/ui/components/skeleton";
import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";

import { SpecBadge } from "@/components/common/badge";
import { CopyId } from "@/components/common/copy-id";
import { Panel } from "@/components/common/panel";
import { effectUrl, type RunEffect } from "@/lib/api/effects";
import type { RunDetail } from "@/lib/api/runs";
import { ago, shortThread, usd } from "@/lib/format";
import {
  useRunApprovals,
  useRunEffects,
  useRunUsage,
} from "@/lib/hooks/use-dashboard-data";
import {
  decisionBadge,
  effectStateBadge,
  originBadge,
  runStatusBadge,
  SHADOW_BADGE,
} from "@/lib/status";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <dt className="eyebrow">{label}</dt>
      <dd className="machine min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}

function groupByNamespace(effects: RunEffect[]): Map<string, RunEffect[]> {
  const out = new Map<string, RunEffect[]>();
  for (const e of effects)
    out.set(e.namespace, [...(out.get(e.namespace) ?? []), e]);
  return out;
}

/**
 * The right-hand panel of the runs workbench: everything about ONE run that
 * doesn't live in its transcript — the facts, what it spent, what it did to
 * the outside world, and who decided its approvals.
 */
export function RunInspector({ run, now }: { run: RunDetail; now: number }) {
  const usage = useRunUsage(run.id);
  const approvals = useRunApprovals(run.id);
  const effects = useRunEffects(run.id);

  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto p-4">
      <section className="space-y-2">
        <div className="flex flex-wrap gap-1.5">
          <SpecBadge spec={runStatusBadge(run.status)} />
          <SpecBadge spec={originBadge(run.origin)} />
          {run.shadow ? <SpecBadge spec={SHADOW_BADGE} /> : null}
        </div>
        <dl className="space-y-1.5">
          <Row label="Run">
            <CopyId value={run.id} label="run id" truncate />
          </Row>
          {run.channelId ? <Row label="Channel">{run.channelId}</Row> : null}
          {run.threadTs ? (
            <Row label="Thread">{shortThread(run.threadTs)}</Row>
          ) : null}
          <Row label="Started">{ago(run.createdAt, now)}</Row>
          <Row label="Last activity">{ago(run.updatedAt, now)}</Row>
          <Row label="Spend">
            {usage.kind === "ready" ? (
              usd(usage.data)
            ) : usage.kind === "error" ? (
              "unavailable"
            ) : (
              <Skeleton className="inline-block h-3 w-12" />
            )}
          </Row>
        </dl>
      </section>

      <Panel title="Did" state={effects} bare>
        {(rows) => (
          <ul className="space-y-3">
            {[...groupByNamespace(rows)].map(([ns, list]) => (
              <li key={ns} className="space-y-1">
                <p className="eyebrow">{ns}</p>
                <ul className="space-y-1">
                  {list.map((e, i) => {
                    const url = effectUrl(e);
                    return (
                      <li
                        // The API's effect rows carry no id (invariant 7 keeps
                        // args/keys server-side), and the Workers runtime only
                        // advances its clock on I/O — two same-turn,
                        // same-method claims issued back-to-back can share a
                        // millisecond, which the demo fixture's hand-spaced
                        // timestamps never exercise. `i` is a tiebreaker
                        // alongside the semantic parts, not a replacement for
                        // them.
                        // biome-ignore lint/suspicious/noArrayIndexKey: index is a tiebreaker alongside real fields, not the key on its own.
                        key={`${e.turnId}:${e.method}:${e.createdAt}:${i}`}
                        className="flex items-center gap-2 text-xs"
                      >
                        <span className="machine truncate">{e.method}</span>
                        <SpecBadge
                          spec={effectStateBadge(e.state)}
                          size="sm"
                          className="ml-auto"
                        />
                        {url ? (
                          <a
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-foreground underline-offset-4 hover:underline"
                            aria-label={`open ${e.method} result`}
                          >
                            <ExternalLink className="size-3" />
                          </a>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Approvals" state={approvals} bare>
        {(rows) => (
          <ul className="space-y-2">
            {rows.map((a) => (
              <li
                key={a.id}
                className="space-y-1 rounded-md border p-2 text-xs"
              >
                <div className="flex items-center justify-between gap-2">
                  <SpecBadge spec={decisionBadge(a.decision)} />
                  <span className="machine text-muted-foreground">
                    {ago(a.decidedAt ?? a.createdAt, now)}
                  </span>
                </div>
                {a.decidedBy ? (
                  <p className="machine text-muted-foreground">{a.decidedBy}</p>
                ) : null}
                {a.rejectReason ? (
                  <p className="text-pretty">{a.rejectReason}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
