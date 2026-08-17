import type { ReactNode } from "react";

import { Panel, type PanelState } from "../components/panel";
import type { DecideAction } from "./api";
import { ApprovalCard, type CardState } from "./approval-card";

/**
 * The dashboard's queue of decisions. Like `SpeakerStrip` and unlike
 * `RunList`, this panel takes its state as a prop rather than polling: the
 * approvals hook owns the clock because a decision and the poll that would
 * overwrite it have to be reconciled in one place.
 *
 * The panel's job beyond layout is the empty state. An operator seeing this
 * panel blank should read "you are clear", not "something failed to load" —
 * which is why the hint names the agent's escalation rule instead of just
 * saying there is nothing here.
 */

const EMPTY_HINT =
  "Nothing needs a decision. The agent escalates only committal replies.";

export type ApprovalsPanelProps = {
  state: PanelState<CardState[]>;
  role: "firefighter" | "viewer";
  onDecide: (id: string, action: DecideAction) => void;
};

export function ApprovalsPanel({ state, role, onDecide }: ApprovalsPanelProps): ReactNode {
  // `Panel` renders `empty` but cannot distinguish a ready-empty list from a
  // ready one, so the emptiness is decided here — same idiom as `RunList`.
  const resolved: PanelState<CardState[]> =
    state.kind === "ready" && state.data.length === 0
      ? { kind: "empty", hint: EMPTY_HINT }
      : state;

  return (
    <Panel title="Waiting on you" state={resolved}>
      {(cards) => (
        <ul className="space-y-3">
          {/* Newest first: the freshest escalation is the one still likely to
              be worth answering in the thread it came from. */}
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
      )}
    </Panel>
  );
}
