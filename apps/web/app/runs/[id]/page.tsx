"use client";

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@workspace/ui/components/card";
import { Skeleton } from "@workspace/ui/components/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip";
import { ArrowLeft, FlaskConical, Hash } from "lucide-react";
import Link from "next/link";
import { use } from "react";

import { SpecBadge } from "@/components/common/badge";
import { CopyId } from "@/components/common/copy-id";
import { ErrorBoundary } from "@/components/common/error-boundary";
import { RunApprovals } from "@/components/run/run-approvals";
import { RunPanel } from "@/components/run/run-panel";
import { isDemo } from "@/lib/api/client";
import { getRun } from "@/lib/api/runs";
import { ago, usd } from "@/lib/format";
import { useIdentityQuery, useRunUsage } from "@/lib/hooks/use-dashboard-data";
import { useNow } from "@/lib/hooks/use-now";
import { POLL_MS, queryKeys } from "@/lib/query/keys";
import { originBadge, runStatusBadge, SHADOW_BADGE } from "@/lib/status";

/**
 * One run, live.
 *
 * A route rather than a drawer, and that is a change from the Vite dashboard,
 * which renders the session inline under the runs list. A run is the thing an
 * operator pastes into Slack and reloads into at 3am: it deserves a URL that
 * survives a refresh, a back button, and a link in a thread.
 *
 * Everything on the left of the header comes from D1 through `GET /api/runs/:id`
 * — rendering a run must not wake it — and the transcript below comes from the
 * Durable Object over its own socket. The two are separate on purpose: the
 * header still renders when the socket cannot connect.
 */
export default function RunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { identity } = useIdentityQuery();
  const now = useNow();
  const usage = useRunUsage(id);

  const run = useQuery({
    queryKey: queryKeys.run(id),
    queryFn: () => getRun(id),
    // The status moves as the agent works, and the header is the one place the
    // reader looks to know whether it is still going.
    refetchInterval: POLL_MS.runs,
  });

  return (
    <div className="mx-auto flex h-[calc(100svh-3.5rem)] w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <div className="space-y-3">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-muted-foreground text-xs underline-offset-4 hover:text-foreground hover:underline"
        >
          <ArrowLeft className="size-3" aria-hidden="true" />
          Back to the dashboard
        </Link>

        {run.data === undefined ? (
          run.isError ? (
            <p className="text-muted-foreground text-sm">
              This run could not be loaded. It may not exist, or you may not be
              on the roster.
            </p>
          ) : (
            <Skeleton className="h-10 w-2/3" />
          )
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <SpecBadge spec={runStatusBadge(run.data.status)} />
              <SpecBadge spec={originBadge(run.data.origin)} />
              {run.data.shadow ? <SpecBadge spec={SHADOW_BADGE} /> : null}
              {run.data.channelId ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="machine inline-flex cursor-default items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground" />
                    }
                  >
                    <Hash className="size-3" aria-hidden="true" />
                    {run.data.channelId}
                  </TooltipTrigger>
                  <TooltipContent>
                    The Slack channel this run was woken from. The Worker
                    resolves the name; a run row carries the id.
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </div>

            <h1 className="text-balance font-semibold text-lg leading-snug">
              {run.data.summary ?? (
                <span className="text-muted-foreground italic">
                  No summary — the agent was woken but has not written one yet.
                </span>
              )}
            </h1>

            <dl className="flex flex-wrap items-center gap-x-5 gap-y-1 text-muted-foreground text-xs">
              <Fact label="Run">
                <CopyId value={run.data.id} label="run id" truncate />
              </Fact>
              <Fact label="Started">
                <span className="machine">{ago(run.data.createdAt, now)}</span>
              </Fact>
              <Fact label="Spend">
                {usage.kind === "ready" ? (
                  // The decimal string, exactly as the ledger stores it.
                  // Formatting it as a number here would round money.
                  <span className="machine">{usd(usage.data)}</span>
                ) : usage.kind === "error" ? (
                  <span>unavailable</span>
                ) : (
                  <Skeleton className="inline-block h-3 w-12 align-middle" />
                )}
              </Fact>
            </dl>
          </>
        )}
      </div>

      {isDemo() ? <DemoNotice /> : null}

      <Card className="flex min-h-0 flex-1 flex-col">
        <CardContent className="flex min-h-0 flex-1 flex-col">
          <ErrorBoundary message="This transcript could not be rendered.">
            <RunPanel
              runId={id}
              approvals={
                <RunApprovals runId={id} role={identity?.role ?? "viewer"} />
              }
            />
          </ErrorBoundary>
        </CardContent>
      </Card>
    </div>
  );
}

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <dt className="eyebrow">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function DemoNotice() {
  return (
    <div className="flex items-start gap-2.5 rounded-md border border-dashed px-3 py-2 text-muted-foreground text-sm">
      <FlaskConical className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span className="text-pretty">
        A fixture transcript, in the shape the socket broadcasts. A live build
        opens a WebSocket to{" "}
        <code className="machine text-xs">/api/runs/:id/agent</code> and
        steering works from here.
      </span>
    </div>
  );
}
