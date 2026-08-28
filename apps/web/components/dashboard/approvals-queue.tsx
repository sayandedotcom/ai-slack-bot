"use client";

import { useEffect, useRef, useState } from "react";

import { Panel } from "@/components/common/panel";
import type { Role } from "@/lib/api/identity";
import { useApprovals } from "@/lib/hooks/use-approvals";
import {
  approvalDomId,
  nextApprovalFocus,
  useSelectedApproval,
} from "@/lib/hooks/use-selected-approval";
import { ApprovalCard } from "./approval-card";

/** How long a deep-linked card stays ringed after the jump. */
const HIGHLIGHT_MS = 4_000;

/**
 * The queue of decisions, and the only surface on this page with a human on the
 * other end of it. `/approvals` owns the section chrome (title, description) —
 * this renders bare, as a list inside that page.
 *
 * Oldest first: the card that has waited longest is the one to answer, not the
 * one that would still make sense in the thread it came from.
 *
 * It is also where a Slack nudge lands. `?approval=<id>` scrolls that card into
 * view and rings it; see `useSelectedApproval`. The jump is deliberately once
 * per id rather than once per render — this list refetches every three seconds,
 * and a scroll on every tick would fight the reader for the scrollbar.
 */
export function ApprovalsQueue({ role }: { role: Role }) {
  const { state, openCount, decideCard } = useApprovals();

  const requested = useSelectedApproval();
  const focusedRef = useRef<string | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);

  useEffect(() => {
    const target = nextApprovalFocus({
      requested,
      alreadyFocused: focusedRef.current,
      present: state.kind === "ready" ? state.data.map((c) => c.card.id) : [],
    });
    if (target === null) return;

    focusedRef.current = target;
    document
      .getElementById(approvalDomId(target))
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlighted(target);
  }, [requested, state]);

  /*
   * The ring's lifetime is its own effect, keyed on the ring rather than on the
   * queue. Folded into the effect above it would be cleared by the next poll:
   * that effect re-runs on every `state` change, its cleanup would cancel the
   * timer, and the early return means no replacement is ever scheduled — a
   * highlight that never goes away.
   */
  useEffect(() => {
    if (highlighted === null) return;
    const timer = setTimeout(() => setHighlighted(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlighted]);

  return (
    <div className="space-y-2.5">
      {openCount > 0 ? (
        <div className="flex justify-end">
          <span className="machine rounded-full bg-attention px-2 py-0.5 font-medium text-[11px] text-attention-foreground">
            {openCount}
          </span>
        </div>
      ) : null}
      <Panel title="Waiting on you" state={state} bare>
        {(cards) => (
          <ul className="space-y-2.5">
            {/* Oldest first: the card that has waited longest is on top. */}
            {[...cards]
              .sort((a, b) => a.card.createdAt - b.card.createdAt)
              .map((cardState) => (
                <ApprovalCard
                  key={cardState.card.id}
                  state={cardState}
                  role={role}
                  highlighted={highlighted === cardState.card.id}
                  onDecide={(action) => decideCard(cardState.card.id, action)}
                />
              ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
