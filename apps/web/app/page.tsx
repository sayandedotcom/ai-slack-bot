"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

import { FunnelStrip } from "@/components/dashboard/funnel-strip";
import { RunSheet } from "@/components/dashboard/run-sheet";
import { RunsFeed } from "@/components/dashboard/runs-feed";
import { SpeakerHero } from "@/components/dashboard/speaker-hero";
import { PageHeader } from "@/components/shell/page-header";
import { useCounters, useRoster } from "@/lib/hooks/use-dashboard-data";

/**
 * The dashboard, in the order a stranger needs to read it: whose voice the
 * agent uses, how little of what it hears reaches a human, and what it is
 * doing.
 *
 * The approvals queue, team table, channels panel and shadow corpus each have
 * their own route now (`/approvals`, `/team`, `/channels`, `/eval`) — Task 16
 * rewrites this page properly; for now it keeps the pieces that have no other
 * home yet.
 */
export default function DashboardPage() {
  const roster = useRoster();
  const counters = useCounters("24h");
  const router = useRouter();
  const search = useSearchParams();

  // Slack's Review buttons already point at `/?approval=<id>` in threads that
  // exist today — this keeps them working by handing the id to the approvals
  // queue's own route instead of duplicating that queue here.
  useEffect(() => {
    const approval = search.get("approval");
    if (approval)
      router.replace(`/approvals?approval=${encodeURIComponent(approval)}`);
  }, [search, router]);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 pb-16 sm:p-6">
      <PageHeader eyebrow="Last 24 hours" title="Who answers the fire today">
        The agent listens to every customer channel, wakes on the few messages
        that need it, and speaks as a fire-fighter — but never sends a committal
        reply without one of you saying yes.
      </PageHeader>

      <SpeakerHero state={roster} />

      <FunnelStrip state={counters} />

      <RunsFeed />

      <RunSheet />
    </div>
  );
}
