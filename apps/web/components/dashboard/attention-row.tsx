"use client";

import { Card, CardContent } from "@workspace/ui/components/card";
import { cn } from "@workspace/ui/lib/utils";
import Link from "next/link";
import type { ReactNode } from "react";

import { SpecBadge } from "@/components/common/badge";
import { ago, nameOf } from "@/lib/format";
import { useApprovals } from "@/lib/hooks/use-approvals";
import { useRoster } from "@/lib/hooks/use-dashboard-data";
import { useNow } from "@/lib/hooks/use-now";
import { useRunsPage } from "@/lib/hooks/use-runs-page";
import { connectBadge } from "@/lib/status";

function AttentionCard({
  href,
  eyebrow,
  destructive = false,
  children,
}: {
  href: string;
  eyebrow: string;
  destructive?: boolean;
  children: ReactNode;
}) {
  return (
    <Link href={href} className="block">
      <Card
        className={cn(
          "h-full transition-colors hover:bg-muted/40",
          destructive && "border-destructive/50 bg-destructive/5"
        )}
      >
        <CardContent className="space-y-1.5">
          <p className="eyebrow">{eyebrow}</p>
          {children}
        </CardContent>
      </Card>
    </Link>
  );
}

/**
 * The three questions a fire-fighter opens the dashboard to answer: is
 * anything waiting on me, is the agent doing anything right now, and whose
 * voice is it using while it does. `--attention` is spent only where a human
 * is genuinely needed — the open-approval count and the "needs you" run count
 * — never as decoration.
 */
export function AttentionRow() {
  const approvals = useApprovals();
  const runs = useRunsPage({});
  const roster = useRoster();
  const now = useNow();

  const openCards =
    approvals.state.kind === "ready"
      ? approvals.state.data.filter((c) => c.kind === "open")
      : [];
  const oldestOpen =
    openCards.length > 0
      ? Math.min(...openCards.map((c) => c.card.createdAt))
      : null;

  // Only `live`, matching what the card links to (`/runs?status=live`) — the
  // filter behind that URL takes one status, not two, so a count that folded
  // in `awaiting_approval` would send a reader who clicked a "3" to a list of
  // 1. `awaiting_approval` still has its own number on the line below
  // (`needsYou`), and its own count one card to the left, so nothing here is
  // lost by not double-counting it.
  const liveRuns =
    runs.state.kind === "ready"
      ? runs.state.data.filter((r) => r.status === "live")
      : [];
  const needsYou =
    runs.state.kind === "ready"
      ? runs.state.data.filter((r) => r.status === "awaiting_approval").length
      : 0;

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <AttentionCard href="/approvals" eyebrow="Waiting on you">
        <p
          className={cn(
            "machine font-semibold text-2xl tabular-nums leading-none",
            approvals.openCount > 0 ? "text-attention" : "text-muted-foreground"
          )}
        >
          {approvals.openCount}
        </p>
        <p className="text-muted-foreground text-xs">
          {oldestOpen !== null
            ? `oldest ${ago(oldestOpen, now)}`
            : "you're clear"}
        </p>
      </AttentionCard>

      <AttentionCard href="/runs?status=live" eyebrow="Live runs">
        <p className="machine font-semibold text-2xl tabular-nums leading-none">
          {liveRuns.length}
        </p>
        <p className="text-muted-foreground text-xs">{needsYou} needs you</p>
      </AttentionCard>

      {roster.kind === "ready" && roster.data.speaker === null ? (
        <AttentionCard href="/team" eyebrow="Speaks as" destructive>
          <p className="text-pretty text-sm">
            Nobody connected — every customer-facing reply is refused
          </p>
        </AttentionCard>
      ) : (
        <AttentionCard href="/team" eyebrow="Speaks as">
          {roster.kind === "ready" && roster.data.speaker !== null ? (
            <>
              <p className="font-semibold text-2xl leading-none tracking-tight">
                {nameOf(roster.data.speaker.email)}
              </p>
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                <SpecBadge
                  spec={connectBadge(
                    roster.data.engineers.find(
                      (e) => e.email === roster.data.speaker?.email
                    )?.slack ?? false,
                    "slack"
                  )}
                  size="sm"
                />
                <SpecBadge
                  spec={connectBadge(
                    roster.data.engineers.find(
                      (e) => e.email === roster.data.speaker?.email
                    )?.github ?? false,
                    "github"
                  )}
                  size="sm"
                />
              </div>
            </>
          ) : (
            <p className="text-muted-foreground text-sm">Loading…</p>
          )}
        </AttentionCard>
      )}
    </div>
  );
}
