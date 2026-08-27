import type { ReactNode } from "react";

import type { PanelState } from "../components/panel";
import type { DecideAction } from "./api";
import { ApprovalCard, type CardState } from "./approval-card";

/**
 * This run's escalations, inside the run view.
 *
 * The dashboard grid already has one approvals queue, and this is deliberately
 * not a second copy of it: it takes the SAME `useApprovals` state the shell
 * owns and filters it to one run. Two independent pollers would mean two
 * requests a second for one answer and two local decision layers that could
 * disagree about who won a 409 — the exact reconciliation bug the hook exists
 * to prevent.
 *
 * Why it belongs here at all: on the Think chassis a run parks in
 * `awaiting_approval` mid-transcript, and the reader is looking at the
 * transcript. Making them find the card in the grid behind the drawer is how a
 * customer waits ten minutes for a reply that was already written.
 *
 * The decision goes out over `PATCH /api/approvals/:id`, which is what routes
 * to `RunAgent.resolveApproval` on the active chassis. It is NOT an agent RPC:
 * `resolveApproval` and `pendingApprovalsForRun` are plain methods on the DO and
 * deliberately not `@callable`, so a browser cannot reach them without passing
 * the roster check that route performs first.
 */

export function RunApprovals({
  runId,
  state,
  role,
  onDecide,
}: {
  runId: string;
  state: PanelState<CardState[]>;
  role: "firefighter" | "viewer";
  onDecide: (id: string, action: DecideAction) => void;
}): ReactNode {
  if (state.kind === "loading") {
    return (
      <div
        role="status"
        aria-label="Loading approvals"
        className="space-y-2 rounded-lg border p-3"
      >
        <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
        <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div
        role="alert"
        className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
      >
        Could not load this run&apos;s approvals — the queue in the dashboard
        behind this drawer is the fallback.
      </div>
    );
  }

  // `empty` is the shell's word for "nothing anywhere", which says nothing
  // about this run; either way there is no card here, and a run with no
  // pending decision should show no chrome at all rather than an empty box.
  const cards =
    state.kind === "ready"
      ? state.data.filter((entry) => entry.card.runId === runId)
      : [];
  if (cards.length === 0) return null;

  return (
    <section aria-label="Waiting on you" className="space-y-2">
      <h3 className="text-[11px] uppercase tracking-wide text-muted-foreground">
        Waiting on you
      </h3>
      <ul className="space-y-3">
        {[...cards]
          .sort((a, b) => b.card.createdAt - a.card.createdAt)
          .map((cardState) => (
            <ApprovalCard
              key={cardState.card.id}
              state={cardState}
              role={role}
              onDecide={(action) => onDecide(cardState.card.id, action)}
            />
          ))}
      </ul>
    </section>
  );
}
