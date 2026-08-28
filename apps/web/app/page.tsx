"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Panel } from "@/components/common/panel";
import { SectionHeader } from "@/components/common/section-header";
import { AttentionRow } from "@/components/dashboard/attention-row";
import { FunnelStrip } from "@/components/dashboard/funnel-strip";
import { RunRow } from "@/components/runs/run-row";
import type { CountersWindow } from "@/lib/api/counters";
import { useCounters } from "@/lib/hooks/use-dashboard-data";
import { useNow } from "@/lib/hooks/use-now";
import { useRunsPage } from "@/lib/hooks/use-runs-page";

/**
 * The overview: the three things a fire-fighter opens the dashboard to
 * check, in the order they matter — is anything waiting on me, how little of
 * what the agent hears actually reaches a human, and what has it done lately.
 *
 * The approvals queue, team table, channels panel and shadow corpus each have
 * their own route (`/approvals`, `/team`, `/channels`, `/eval`), and the full
 * run history lives at `/runs` — this page is a dashboard onto all of them,
 * not a fifth copy of any one.
 */
export default function OverviewPage() {
  const search = useSearchParams();
  const router = useRouter();
  useEffect(() => {
    // Slack's Review buttons already point at `/?approval=<id>` in threads
    // that exist today — this keeps them working by handing the id to the
    // approvals queue's own route instead of duplicating that queue here.
    const approval = search.get("approval");
    if (approval)
      router.replace(`/approvals?approval=${encodeURIComponent(approval)}`);
  }, [search, router]);

  const [window, setWindow] = useState<CountersWindow>(
    search.get("window") === "7d" ? "7d" : "24h"
  );
  const counters = useCounters(window);
  const recent = useRunsPage({ limit: 8 });
  const now = useNow();

  return (
    <div className="mx-auto w-full max-w-7xl space-y-8 p-6">
      <AttentionRow />
      <FunnelStrip state={counters} window={window} onWindow={setWindow} />
      <section className="space-y-3">
        <SectionHeader
          eyebrow="Recent"
          title="Runs"
          action={
            <Link
              href="/runs"
              className="text-sm underline-offset-4 hover:underline"
            >
              See all →
            </Link>
          }
        />
        <Panel title="Recent runs" state={recent.state} bare>
          {(runs) => (
            <ul className="divide-y rounded-lg border">
              {runs.slice(0, 8).map((run) => (
                <RunRow
                  key={run.id}
                  run={run}
                  selected={false}
                  now={now}
                  href={`/runs/${encodeURIComponent(run.id)}`}
                />
              ))}
            </ul>
          )}
        </Panel>
      </section>
    </div>
  );
}
