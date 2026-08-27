"use client";

import { buttonVariants } from "@workspace/ui/components/button";

import { Card, CardContent } from "@workspace/ui/components/card";
import { Flame } from "lucide-react";
import { nameOf } from "@/lib/format";
import { useApprovals } from "@/lib/hooks/use-approvals";
import { useRoster } from "@/lib/hooks/use-dashboard-data";

/**
 * The Block Kit DM as it reaches the person who has to decide.
 *
 * It is here so that the notification and the decision are visibly separate
 * things. The DM is a NOTIFICATION, not a control surface — its button is a
 * plain link and needs no handler anywhere, because there is no Slack
 * interactivity endpoint and no two-surface state to keep in sync. Approval
 * happens on this page and only on this page.
 */
export function NudgePreview() {
  const roster = useRoster();
  const { state } = useApprovals();

  const speaker = roster.kind === "ready" ? roster.data.speaker : null;
  const oldest =
    state.kind === "ready"
      ? [...state.data]
          .filter((entry) => entry.kind === "open")
          .sort((a, b) => a.card.createdAt - b.card.createdAt)[0]?.card
      : undefined;

  if (oldest === undefined) return null;

  return (
    <section aria-labelledby="nudge-heading" className="space-y-3">
      <h2 id="nudge-heading" className="eyebrow">
        The nudge, as it arrives
      </h2>
      <Card>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2 border-b pb-2.5 text-muted-foreground text-xs">
            <Flame className="size-3.5 text-primary" aria-hidden="true" />
            <span className="font-medium text-foreground">Firefighter</span>
            <span>direct message</span>
            {speaker ? (
              <span className="machine ml-auto">
                to {nameOf(speaker.email)}
              </span>
            ) : null}
          </div>

          <p className="text-sm">
            A draft is waiting on you in{" "}
            <span className="machine text-muted-foreground">
              #{oldest.channelId}
            </span>
            :
          </p>

          <blockquote className="border-primary/40 border-l-2 bg-muted/40 px-3 py-2 text-muted-foreground text-sm">
            {oldest.draft.length > 140
              ? `${oldest.draft.slice(0, 140)}…`
              : oldest.draft}
          </blockquote>

          {/* Rendered as the link it is. Making this a Button would imply a
              click here does something, and it does not — it opens the page
              you are already looking at. */}
          <span
            className={buttonVariants({ variant: "outline", size: "sm" })}
            aria-hidden="true"
          >
            Review in dashboard →
          </span>

          <p className="text-pretty text-muted-foreground text-xs">
            Push reaches phone and desktop. The button is a plain link —
            approving happens above, never in Slack.
          </p>
        </CardContent>
      </Card>
    </section>
  );
}
