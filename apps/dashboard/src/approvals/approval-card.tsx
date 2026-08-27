import { useState } from "react";
import type { ReactNode } from "react";

import { Button } from "@workspace/ui/components/button";

import type { Decision, DecideAction, OpenApproval } from "./api";

/**
 * One approval, rendered as the thing a fire-fighter actually acts on. The card
 * is deliberately inert: it fetches nothing and owns no approval state beyond
 * the two transient composers below (the edit textarea, the reject reason).
 * Everything durable arrives as `state` and every decision leaves as
 * `onDecide` — so the same card renders identically from a poll, an optimistic
 * write, and a 409 replay.
 *
 * The three actions are not symmetric and the layout says so. Approve is one
 * click because the agent's draft being right is the common case. Edit opens
 * inline rather than in a modal: a modal would hide the `why` and the thread
 * context at the exact moment the operator is rewriting against them. Reject
 * costs a sentence, on purpose — that sentence is Phase 21 training data, so
 * the send button stays disabled until it exists, and the API enforces the same
 * rule with a 422 in case anything ever reaches it around this UI.
 */

/**
 * Declared here rather than imported from the hook: the card is the component
 * that defines what a renderable approval looks like, and the hook produces it.
 */
export type CardState =
  | { kind: "open"; card: OpenApproval; error?: string }
  | { kind: "deciding"; card: OpenApproval; action: DecideAction }
  | {
      kind: "resolved";
      card: OpenApproval;
      decision: Decision;
      decidedBy: string | null;
      mine: boolean;
    };

export type ApprovalCardProps = {
  state: CardState;
  role: "firefighter" | "viewer";
  onDecide: (action: DecideAction) => void;
};

/** Matches `run-list`'s granularity so two panels never disagree about "now". */
function ago(thenMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const VIEWER_CAPTION = "fire-fighters decide";

/**
 * Past-tense verb for each terminal decision. `pending` cannot reach a resolved
 * card, but the map is total so a new `Decision` member fails the typecheck
 * here instead of rendering an empty banner in production.
 */
const VERB: Record<Decision, string> = {
  pending: "left this open",
  approved: "approved",
  edited: "edited",
  rejected: "rejected",
  withdrawn: "withdrew",
};

/**
 * The resolved banner. Three shapes, and the name-less one is not an edge case:
 * the worker's 409 body carries the winning decision but never the winner, so
 * a conflict renders here with `decidedBy: null` far more often than not. Copy
 * that assumed a name would read as a bug on the most common conflict path.
 */
function resolvedLine(
  decision: Decision,
  decidedBy: string | null,
  mine: boolean
): string {
  // Withdrawal is the agent's own doing — no human decided it, so neither the
  // "you" nor the "someone else" framing is true.
  if (decision === "withdrawn")
    return "The agent withdrew this — the thread moved on";
  if (mine) {
    if (decision === "approved") return "You approved this";
    if (decision === "edited") return "You edited this";
    if (decision === "rejected") return "You rejected this";
    return "You closed this";
  }
  if (decidedBy !== null)
    return `${decidedBy} ${VERB[decision]} this before you`;
  return `Someone else ${VERB[decision]} this first`;
}

function Meta({ card, now }: { card: OpenApproval; now: number }): ReactNode {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
      <span className="rounded border border-border bg-muted px-1.5 py-0.5">
        #{card.channelId}
      </span>
      <span className="tabular-nums">thread {card.threadTs}</span>
      <span className="ml-auto shrink-0 tabular-nums">
        {ago(card.createdAt, now)}
      </span>
    </div>
  );
}

/**
 * The draft as the agent wrote it. Capped rather than truncated: an operator
 * approving a reply must be able to read all of it, but a long draft must not
 * push the actions below the fold on a card they are meant to act on quickly.
 */
function Draft({ text }: { text: string }): ReactNode {
  return (
    <blockquote className="max-h-52 overflow-y-auto whitespace-pre-wrap border-l-2 border-border bg-muted/40 px-3 py-2 text-sm">
      {text}
    </blockquote>
  );
}

export function ApprovalCard({
  state,
  role,
  onDecide,
}: ApprovalCardProps): ReactNode {
  const card = state.card;
  const viewer = role === "viewer";

  // Composer state lives per-card and is intentionally not lifted: an abandoned
  // edit or half-typed reason has no meaning outside this card's lifetime.
  const [composer, setComposer] = useState<"none" | "edit" | "reject">("none");
  const [editText, setEditText] = useState(card.draft);
  const [reason, setReason] = useState("");

  const now = Date.now();

  if (state.kind === "resolved") {
    return (
      <li className="rounded-lg border bg-card px-3 py-2">
        <p className="text-sm text-muted-foreground">
          {resolvedLine(state.decision, state.decidedBy, state.mine)}
        </p>
        <p className="mt-1 truncate text-xs text-muted-foreground/80">
          {card.why}
        </p>
      </li>
    );
  }

  const deciding = state.kind === "deciding";
  // Viewers and in-flight decisions lock for different reasons but identically:
  // no double-submit, and no editing a draft that is already being approved.
  const locked = viewer || deciding;

  return (
    <li className="flex flex-col gap-2 rounded-lg border bg-card px-3 py-3">
      <Meta card={card} now={now} />

      {/* The `why` leads. It is the answer to "why am I being interrupted?",
          and an operator who skips it is deciding blind. */}
      <p className="text-sm font-medium">{card.why}</p>

      {composer === "edit" && !locked ? (
        <textarea
          value={editText}
          onChange={(event) => setEditText(event.target.value)}
          rows={8}
          aria-label="Edited reply"
          className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        />
      ) : (
        <Draft text={card.draft} />
      )}

      {composer === "reject" && !locked ? (
        <div className="flex flex-col gap-1">
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why is this wrong?"
            aria-label="Rejection reason"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
          <p className="text-[11px] text-muted-foreground">
            The reason trains the agent — it is required.
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {composer === "edit" ? (
          <>
            <Button
              size="sm"
              disabled={locked || editText.trim().length === 0}
              onClick={() => onDecide({ action: "edit", text: editText })}
            >
              Send edit
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={deciding}
              onClick={() => {
                setComposer("none");
                setEditText(card.draft);
              }}
            >
              Cancel
            </Button>
          </>
        ) : composer === "reject" ? (
          <>
            <Button
              size="sm"
              variant="destructive"
              // Empty or whitespace-only is not a reason. Enforced here so the
              // operator learns the rule before the API's 422 teaches it.
              disabled={locked || reason.trim().length === 0}
              onClick={() => onDecide({ action: "reject", reason })}
            >
              Send rejection
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={deciding}
              onClick={() => {
                setComposer("none");
                setReason("");
              }}
            >
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              disabled={locked}
              onClick={() => onDecide({ action: "approve" })}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={locked}
              onClick={() => setComposer("edit")}
            >
              Edit
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={locked}
              onClick={() => setComposer("reject")}
            >
              Reject
            </Button>
          </>
        )}

        {viewer ? (
          <span className="text-[11px] text-muted-foreground">
            {VIEWER_CAPTION}
          </span>
        ) : deciding ? (
          // Deliberately quiet: the locked buttons already say "in flight", and
          // a spinner on a sub-second PATCH is more flicker than feedback.
          <span role="status" className="text-[11px] text-muted-foreground">
            Sending…
          </span>
        ) : null}
      </div>

      {state.kind === "open" && state.error !== undefined ? (
        <p role="alert" className="text-xs text-destructive">
          {state.error}
        </p>
      ) : null}
    </li>
  );
}
