/**
 * State contracts for one human decision on one proposed customer Slack
 * reply. See `docs/superpowers/plans/phase-11-approval.md`, "Persistence
 * design", and `phase-11-approval/shared-contracts.md` for the state
 * machines and the exact table this row is read from.
 *
 * `ApprovalPort` is Task 3's to add — this file stops at the row shape and
 * the two small pure helpers every later task needs.
 */

export type ApprovalDecision =
  | "pending"
  | "approved"
  | "edited"
  | "rejected"
  | "withdrawn";

export type ApprovalDelivery =
  | "none"
  | "sending"
  | "sent"
  | "blocked"
  | "suppressed"
  | "in_doubt";

export type ApprovalRow = {
  id: string;
  runId: string;
  generationId: string;
  draft: string;
  why: string;
  channelId: string;
  threadTs: string;
  shadow: boolean;
  decision: ApprovalDecision;
  decidedBy: string | null;
  decidedAt: number | null;
  editedText: string | null;
  rejectReason: string | null;
  delivery: ApprovalDelivery;
  createdAt: number;
  updatedAt: number;
  nudgedAt: number | null;
  nudgeChannelId: string | null;
  nudgeTs: string | null;
};

export type DecisionInput =
  | { action: "approve" }
  | { action: "edit"; text: string }
  | { action: "reject"; reason: string };

export type DecisionInputErrorCode =
  | "edit_requires_text"
  | "reject_requires_reason";

/**
 * Thrown by `validateDecisionInput` (and, transitively, by
 * `decideApproval`, which calls it before any D1 write) for the two shapes
 * the type system alone cannot refuse: an `edit` whose `text` is blank, or a
 * `reject` whose `reason` is blank. Maps to `422 invalid_action` at the HTTP
 * layer (Task 6).
 */
export class DecisionInputError extends Error {
  readonly code: DecisionInputErrorCode;

  constructor(code: DecisionInputErrorCode) {
    super(code);
    this.name = "DecisionInputError";
    this.code = code;
  }
}

/**
 * Refuses a blank edit text or reject reason. Whitespace-only counts as
 * blank — a human who mashes the reject button with an empty textarea has
 * not actually given a reason. `approve` carries nothing to validate.
 */
export function validateDecisionInput(input: DecisionInput): void {
  if (input.action === "edit" && input.text.trim().length === 0) {
    throw new DecisionInputError("edit_requires_text");
  }
  if (input.action === "reject" && input.reason.trim().length === 0) {
    throw new DecisionInputError("reject_requires_reason");
  }
}

/**
 * The text that will actually be sent: `edited_text` when a human edited the
 * draft, else the model's own draft. Falls back to `draft` even for a
 * `decision: "edited"` row with no `editedText` — `repository.ts` is the
 * sole writer and never produces that shape, but the sender (Task 5) must
 * not throw or send `null` on a row it did not write itself.
 */
export function outboundText(row: ApprovalRow): string {
  if (row.decision === "edited" && row.editedText !== null) {
    return row.editedText;
  }
  return row.draft;
}

/**
 * What the run is told about a human's decision — the whole content of the
 * `appendTurn({source:"approval"})` that re-enters the run.
 *
 * THREE FACTS AND NOTHING ELSE: the decision, the final text (or the reject
 * reason), and what happened to the delivery. In particular NOT `decidedBy`
 * (invariant 12): D1 records which engineer clicked because the dashboard and
 * later audits need it, and the model has no business knowing. A run's answer
 * must not change depending on who was on duty.
 *
 * Prose rather than JSON because this lands in the model's transcript as
 * user-authority input, and the delivery half of it is an INSTRUCTION — under
 * Phase 11's identity-refusing sender the approved text has to be posted by a
 * human, and a bare `"delivery":"blocked"` is not something a model can act on.
 */
export function resolutionTurnContent(input: {
  decision: "approved" | "edited" | "rejected";
  /** The text that was to be sent. Null only for a rejection. */
  text: string | null;
  /** The human's reason. Null unless rejected. */
  reason: string | null;
  /**
   * The model's own draft — the text `approval.escalate` was called with.
   * Required for every decision, not just rejection: memory needs it to
   * learn what this team won't send, and an edited resolution needs it to
   * show the model what its superseded version was.
   */
  draft: string;
  delivery: ApprovalDelivery;
  deliveryError: string | null;
}): string {
  if (input.decision === "rejected") {
    return [
      "A human REJECTED the reply you asked to send, and it was not sent.",
      `Their reason: ${input.reason ?? "(none given)"}`,
      "Do not send that draft. Treat the reason as a correction: it is what this team will not say to this customer.",
      // LAST ON PURPOSE. The MEMORY episode's `asked` field (`readAsked()` in
      // `src/run/session.ts`, capped at `EPISODE_LIMITS.asked` = 1,000 chars
      // by `boundedEpisodeText`, which keeps the HEAD and drops the tail) is
      // built from this same turn content — so whichever field is truncated
      // on a long draft, it must not be the reason. The reason is what makes
      // the rejection useful to a FUTURE memory recall even if the draft
      // itself gets cut off. This cap is a property of the memory episode
      // ONLY: the model's own live transcript reads `turn.content` whole,
      // with no length cap at all (`toInputModelMessage`,
      // `src/agent/prompt/evidence.ts`), so the model always sees the full
      // draft regardless of ordering.
      `The draft that was rejected: ${input.draft}`,
    ].join("\n\n");
  }

  const opening =
    input.decision === "edited"
      ? "A human EDITED and approved the reply you asked to send. This is the final text, and the only version that may ever go out:"
      : "A human APPROVED the reply you asked to send, unchanged:";

  const parts = [opening, input.text ?? ""];
  if (input.decision === "edited") {
    parts.push(`Your original draft, now superseded: ${input.draft}`);
  }
  // deliveryLine goes LAST for the same reason the rejected branch orders
  // itself the way it does, above: it is what a long turn's memory episode
  // sacrifices first. Deliberately so — a future recall wants to know WHAT
  // was edited and WHY, not that this one particular message once needed a
  // human to send it by hand. `input.text` and the superseded draft sit
  // ahead of it so they survive the cap; only the memory episode is capped
  // at all, so the model's own live view of this delivery instruction is
  // never shortened regardless of this ordering.
  parts.push(deliveryLine(input.delivery, input.deliveryError));
  return parts.join("\n\n");
}

function deliveryLine(
  delivery: ApprovalDelivery,
  error: string | null
): string {
  switch (delivery) {
    case "sent":
      // "Do not re-read" is here because a live run did exactly that: told
      // the reply was sent, it spent one step fetching the thread to confirm
      // and another announcing that it had — two model turns to learn what
      // this line already states. Delivery `sent` is the sender's own
      // receipt (the message ts came back from Slack), so it is authoritative;
      // the in_doubt branch below is the one that asks for a check.
      return (
        "It has been sent to the customer thread; that delivery is confirmed, so do not spend a" +
        " step re-reading the thread to check. If the customer asked for nothing else, stop here."
      );
    case "blocked":
      // The honest version of Phase 11's terminal state. The run resumes on
      // this, so the model has to be told what is still owed to the customer.
      return (
        `It was NOT sent (${error ?? "blocked"}), and it will not be sent automatically.` +
        " Sending as the on-duty engineer is not available yet, so the approved text above has to be posted by a human." +
        " Say so plainly in your answer, and do not try to send it another way."
      );
    case "suppressed":
      return (
        "This run is shadowing a conversation it must never write to, so nothing was sent" +
        " and nothing will be. The approved text is on the record for review only."
      );
    case "in_doubt":
      return (
        `The send was attempted and its outcome is unknown (${error ?? "unknown"}).` +
        " Do NOT send it again — a duplicate message to a customer cannot be taken back." +
        " A human has to check the thread and reconcile."
      );
    case "none":
    case "sending":
      // Unreachable for an approved/edited resolution: the caller always
      // settles delivery before building this. Stated rather than thrown,
      // because a resolution turn that fails to build would park the run.
      return "The delivery of this reply is still unresolved; a human has to check the thread.";
  }
}

/**
 * What the `approval` capability namespace (Task 3) is allowed to touch.
 *
 * Deliberately the ONLY seam between model-facing code and approval state.
 * The capability layer never reads or writes D1 or the RunDO's own storage
 * directly — it calls this port, and this port is the thing a later task
 * (RunDO SQLite schema v3, the `approval_state` table, the `approval_card`
 * D1 projection) implements for real. Task 3's tests run against a plain
 * test double of this interface; there is no production implementation yet.
 */
export interface ApprovalPort {
  /**
   * Open one approval for this run: synchronous local write plus an async D1
   * projection enqueue. Returns the minted id. Callers must check
   * `openApprovalId()` first — this method does not itself refuse a second
   * open, because "is one already open" is a question the capability layer
   * answers host-side, before any call reaches this port at all.
   */
  open(input: { draft: string; why: string }): Promise<{ approvalId: string }>;
  /**
   * The id of the currently open (unsettled) approval, if any. Synchronous:
   * this is the local read the generation-finalize latch uses to decide
   * whether to pause a run, and finalize must never wait on D1 to do it.
   */
  openApprovalId(): string | null;
  /**
   * Retract the open approval. Loses gracefully: if a human already decided
   * before the retraction reached this port, the decision wins and comes
   * back instead of a withdrawal.
   */
  withdraw(): Promise<
    | { withdrawn: true }
    | {
        withdrawn: false;
        decision: Exclude<ApprovalDecision, "pending" | "withdrawn">;
      }
  >;
}
