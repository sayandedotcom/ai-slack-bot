"use client";

import { ApprovalsQueue } from "@/components/dashboard/approvals-queue";
import { FunnelStrip } from "@/components/dashboard/funnel-strip";
import { NudgePreview } from "@/components/dashboard/nudge-preview";
import { RosterCard } from "@/components/dashboard/roster-card";
import { RunSheet } from "@/components/dashboard/run-sheet";
import { RunsFeed } from "@/components/dashboard/runs-feed";
import { ShadowPanel } from "@/components/dashboard/shadow-panel";
import { SpeakerHero } from "@/components/dashboard/speaker-hero";
import { TeamTable } from "@/components/dashboard/team-table";
import { TokenExplainer } from "@/components/dashboard/token-explainer";
import { PageHeader } from "@/components/shell/page-header";
import {
  useCounters,
  useIdentityQuery,
  useRoster,
} from "@/lib/hooks/use-dashboard-data";

/**
 * The dashboard, in the order a stranger needs to read it: whose voice the
 * agent uses, how little of what it hears reaches a human, what it is doing,
 * and what is waiting on you.
 *
 * The roster is read here AND inside the team table, deliberately. Both call
 * `useRoster()`, the cache answers once, and neither has to be handed the other
 * one's data — which is what the Vite dashboard has to do, and says so in a
 * comment, because it has no cache to dedupe with.
 */
export default function DashboardPage() {
  const roster = useRoster();
  const counters = useCounters();
  const { identity } = useIdentityQuery();
  const role = identity?.role ?? "viewer";

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 pb-16 sm:p-6">
      <PageHeader eyebrow="Last 24 hours" title="Who answers the fire today">
        The agent listens to every customer channel, wakes on the few messages
        that need it, and speaks as a fire-fighter — but never sends a committal
        reply without one of you saying yes.
      </PageHeader>

      <div className="grid gap-4 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <SpeakerHero state={roster} />
        </div>
        <div className="lg:col-span-5">
          <RosterCard state={roster} />
        </div>
      </div>

      <FunnelStrip state={counters} />

      <div className="grid items-start gap-4 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <RunsFeed />
        </div>
        {/*
          Sticky, and that is the point of the two-column split: the run history
          is long and worth scrolling, and the thing with a human waiting on the
          other end of it should not scroll away while you do.
        */}
        <div className="lg:sticky lg:top-20 lg:col-span-5">
          <ApprovalsQueue role={role} />
        </div>
      </div>

      {/* The nudge and the two tokens are one idea — how a decision reaches a
          human and comes back — so they sit together rather than the nudge
          floating beside the queue it describes. */}
      <div className="grid items-start gap-4 lg:grid-cols-12">
        <div className="lg:col-span-5">
          <NudgePreview />
        </div>
        <div className="lg:col-span-7">
          <TokenExplainer />
        </div>
      </div>

      <TeamTable state={roster} identity={identity} />

      <ShadowPanel />

      <RunSheet />
    </div>
  );
}
