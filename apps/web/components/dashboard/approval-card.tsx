"use client";

import { Button } from "@workspace/ui/components/button";
import { Textarea } from "@workspace/ui/components/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip";
import { cn } from "@workspace/ui/lib/utils";
import { Check, Eye, Hash, Pencil, X } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useState } from "react";

import type { DecideAction, Decision, OpenApproval } from "@/lib/api/approvals";
import { ago, shortThread } from "@/lib/format";
import { useNow } from "@/lib/hooks/use-now";
import { approvalDomId } from "@/lib/hooks/use-selected-approval";
import type { CardState } from "@/lib/store/approvals-overlay";

/**
 * One approval, rendered as the thing a fire-fighter actually acts on.
 *
 * The card is deliberately inert: it fetches nothing and owns no approval state
 * beyond the two transient composers below. Everything durable arrives as
 * `state` and every decision leaves as `onDecide` — so the same card renders
 * identically from a poll, an optimistic write, and a 409 replay.
 *
 * The three actions are not symmetric and the layout says so. Approve is one
 * click, because the draft being right is the common case. Edit opens inline
 * rather than in a modal: a modal would hide the `why` and the thread context
 * at the exact moment the operator is rewriting against them. Reject costs a
 * sentence, on purpose — that sentence is training data, so the button stays
 * disabled until it exists, and the API enforces the same rule with a 422 in
 * case anything ever reaches it around this UI.
 */
export type ApprovalCardProps = {
  state: CardState;
  role: "firefighter" | "viewer";
  /** Ringed because a Slack nudge deep-linked here. Transient; see the queue. */
  highlighted?: boolean;
  onDecide: (action: DecideAction) => void;
};

/**
 * The deep-link ring. Applied to the card itself rather than an overlay so it
 * survives both card shapes, and so it cannot cover the buttons it is pointing
 * the reader at.
 */
const HIGHLIGHT = "ring-2 ring-primary ring-offset-2 ring-offset-background";

/** The affirmative action's tone, used by both send buttons. */
const APPROVE = "bg-success text-success-foreground hover:bg-success/85";

/**
 * Past-tense verb per terminal decision. `pending` cannot reach a resolved
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
 * Three shapes, and the name-less one is not an edge case: the worker's 409
 * body carries the winning decision but never the winner, so a conflict renders
 * with `decidedBy: null` far more often than not. Copy that assumed a name
 * would read as a bug on the most common conflict path.
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
    if (decision === "edited") return "You edited and sent this";
    if (decision === "rejected") return "You rejected this";
    return "You closed this";
  }
  if (decidedBy !== null)
    return `${decidedBy} ${VERB[decision]} this before you`;
  return `Someone else ${VERB[decision]} this first`;
}

function Meta({ card, now }: { card: OpenApproval; now: number }): ReactNode {
  return (
    <div className="machine flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-0.5 rounded border border-border bg-muted px-1.5 py-0.5">
        <Hash className="size-2.5" aria-hidden="true" />
        {card.channelId}
      </span>
      <Tooltip>
        <TooltipTrigger render={<span className="cursor-default" />}>
          thread {shortThread(card.threadTs)}
        </TooltipTrigger>
        <TooltipContent>{card.threadTs}</TooltipContent>
      </Tooltip>
      {/*
        The way to read a draft before committing to it. A card shows WHAT the
        agent wants to send and WHY it asked, but not what it did to get there
        — the thread it read, the queries it ran, what came back. Approving is
        a promise made in a customer's thread under a person's name, so the
        evidence has to be one click away, not a hunt through another page.
        The run route renders this same card inside its transcript, so the
        decision can be made there: this is a link to more context, not a
        detour away from the task.
      */}
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              href={`/runs/${encodeURIComponent(card.runId)}`}
              className="inline-flex items-center gap-1 rounded px-1 underline-offset-4 hover:text-foreground hover:underline"
            />
          }
        >
          <Eye className="size-2.5" aria-hidden="true" />
          open run
        </TooltipTrigger>
        <TooltipContent>
          Read the whole run — what it did, what it spent — then approve from
          there.
        </TooltipContent>
      </Tooltip>
      <span className="ml-auto shrink-0">{ago(card.createdAt, now)}</span>
    </div>
  );
}

export function ApprovalCard({
  state,
  role,
  highlighted = false,
  onDecide,
}: ApprovalCardProps): ReactNode {
  const card = state.card;
  const viewer = role === "viewer";

  // Composer state lives per-card and is intentionally not lifted: an abandoned
  // edit or half-typed reason has no meaning outside this card's lifetime.
  const [composer, setComposer] = useState<"none" | "edit" | "reject">("none");
  const [editText, setEditText] = useState(card.draft);
  const [reason, setReason] = useState("");

  const now = useNow();

  if (state.kind === "resolved") {
    return (
      <li
        id={approvalDomId(card.id)}
        className={cn(
          "rounded-lg border bg-card px-3 py-2.5",
          highlighted && HIGHLIGHT
        )}
      >
        <p className="flex items-center gap-2 text-muted-foreground text-sm">
          <Check
            className="size-3.5 shrink-0 text-success"
            aria-hidden="true"
          />
          {resolvedLine(state.decision, state.decidedBy, state.mine)}
        </p>
        <p className="mt-1 truncate pl-5.5 text-muted-foreground/70 text-xs">
          {card.why}
        </p>
      </li>
    );
  }

  const deciding = state.kind === "deciding";
  // Viewers and in-flight decisions lock for different reasons but identically:
  // no double-submit, and no editing a draft that is already being approved.
  const locked = viewer || deciding;
  const editing = composer === "edit" && !locked;
  const rejecting = composer === "reject" && !locked;

  return (
    <li
      id={approvalDomId(card.id)}
      className={cn(
        "flex flex-col gap-2.5 rounded-lg border bg-card px-3 py-3",
        highlighted && HIGHLIGHT
      )}
    >
      <Meta card={card} now={now} />

      {/* The `why` leads. It is the answer to "why am I being interrupted?",
          and an operator who skips it is deciding blind. */}
      <p className="text-pretty font-medium text-sm">{card.why}</p>

      {editing ? (
        <Textarea
          value={editText}
          onChange={(event) => setEditText(event.target.value)}
          rows={7}
          aria-label="Edited reply"
          className="resize-y text-sm"
        />
      ) : (
        /*
         * The draft as the agent wrote it, set in SANS — not mono. Everything
         * else the machine produced on this page is mono, and the exception is
         * the point: this text is about to be sent to a customer under a
         * person's name, and it should be read the way they will read it.
         *
         * Capped rather than truncated: an operator approving a reply must be
         * able to read all of it, but a long draft must not push the actions
         * below the fold on a card they are meant to act on quickly.
         */
        <blockquote className="max-h-52 overflow-y-auto whitespace-pre-wrap border-primary/40 border-l-2 bg-muted/40 px-3 py-2 text-sm">
          {card.draft}
        </blockquote>
      )}

      {rejecting ? (
        <div className="space-y-1">
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="What's wrong with it?"
            aria-label="Rejection reason"
            rows={2}
            className="resize-y text-sm"
          />
          <p className="text-[11px] text-muted-foreground">
            The reason is what teaches the agent not to write this again.
            It&apos;s required.
          </p>
        </div>
      ) : null}

      {state.kind === "open" && state.error !== undefined ? (
        <p role="alert" className="text-destructive text-xs">
          {state.error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {editing ? (
          <>
            <Button
              size="sm"
              className={APPROVE}
              disabled={locked || editText.trim().length === 0}
              onClick={() => onDecide({ action: "edit", text: editText })}
            >
              <Check data-icon="inline-start" />
              Send edited
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setComposer("none")}
            >
              Cancel
            </Button>
          </>
        ) : rejecting ? (
          <>
            <Button
              variant="destructive"
              size="sm"
              disabled={locked || reason.trim().length === 0}
              onClick={() => onDecide({ action: "reject", reason })}
            >
              <X data-icon="inline-start" />
              Reject
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setComposer("none")}
            >
              Cancel
            </Button>
          </>
        ) : viewer ? (
          <p className="text-muted-foreground text-xs">
            Fire-fighters decide. You can read the draft and the reason it was
            escalated.
          </p>
        ) : (
          <>
            <Button
              size="sm"
              disabled={locked}
              onClick={() => onDecide({ action: "approve" })}
              // Not the ember primary. Ember is this page's attention colour —
              // the escalated stage, the waiting count — and a red-filled
              // button next to a Reject reads as "stop", which is the opposite
              // of what this one does. Approve is the safe, common, green path.
              className={APPROVE}
            >
              <Check data-icon="inline-start" />
              {deciding ? "Sending…" : "Approve & send"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={locked}
              onClick={() => setComposer("edit")}
            >
              <Pencil data-icon="inline-start" />
              Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={locked}
              onClick={() => setComposer("reject")}
              className={cn(
                "text-muted-foreground",
                !locked && "hover:text-destructive"
              )}
            >
              Reject
            </Button>
          </>
        )}
      </div>
    </li>
  );
}
