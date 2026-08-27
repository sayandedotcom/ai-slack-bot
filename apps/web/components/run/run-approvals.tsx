"use client";

import { ApprovalCard } from "@/components/dashboard/approval-card";
import type { Role } from "@/lib/api/identity";
import { useApprovals } from "@/lib/hooks/use-approvals";

/**
 * This run's approvals, rendered inside its transcript.
 *
 * The same cards the dashboard queue shows, filtered to one run and reading the
 * same cache — `useApprovals` is one TanStack query key, so opening a run does
 * not add a second poll and a decision made here is a decision the queue and
 * the sidebar badge see immediately.
 *
 * Why here at all, when there is a queue: a run parks mid-answer and the reader
 * is looking at the transcript. Making them find the queue behind this view is
 * how a customer waits ten minutes for a reply that was already written.
 *
 * The decision still leaves over `PATCH /api/approvals/:id`. Nothing about this
 * placement goes around the roster check or the D1 CAS.
 */
export function RunApprovals({ runId, role }: { runId: string; role: Role }) {
  const { state, decideCard } = useApprovals();
  if (state.kind !== "ready") return null;

  const mine = state.data.filter((entry) => entry.card.runId === runId);
  if (mine.length === 0) return null;

  return (
    <ul className="space-y-2.5 pt-1">
      {mine
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
  );
}
