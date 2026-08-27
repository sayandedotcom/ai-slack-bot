"use client";

import { Inbox } from "lucide-react";

import { Panel } from "@/components/common/panel";
import type { Role } from "@/lib/api/identity";
import { useApprovals } from "@/lib/hooks/use-approvals";
import { ApprovalCard } from "./approval-card";

/**
 * The queue of decisions, and the only surface on this page with a human on the
 * other end of it.
 *
 * The panel's job beyond layout is the empty state. An operator seeing this
 * blank should read "you're clear", not "something failed to load" — which is
 * why the hint names the agent's escalation rule instead of just saying there
 * is nothing here.
 */
export function ApprovalsQueue({ role }: { role: Role }) {
  const { state, openCount, decideCard } = useApprovals();

  return (
    <Panel
      title="Waiting on you"
      icon={Inbox}
      state={state}
      aside={
        openCount > 0 ? (
          <span className="machine rounded-full bg-primary px-2 py-0.5 font-medium text-[11px] text-primary-foreground">
            {openCount}
          </span>
        ) : null
      }
      description="Approving sends the reply to Slack under a fire-fighter's own account."
    >
      {(cards) => (
        <ul className="space-y-2.5">
          {/* Newest first: the freshest escalation is the one still likely to be
              worth answering in the thread it came from. */}
          {[...cards]
            .sort((a, b) => b.card.createdAt - a.card.createdAt)
            .map((cardState) => (
              <ApprovalCard
                key={cardState.card.id}
                state={cardState}
                role={role}
                onDecide={(action) => decideCard(cardState.card.id, action)}
              />
            ))}
        </ul>
      )}
    </Panel>
  );
}
