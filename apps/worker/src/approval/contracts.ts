/**
 * State contracts for one human decision on one proposed customer Slack
 * reply. See `docs/superpowers/plans/phase-11-approval.md`, "Persistence
 * design", and `phase-11-approval/shared-contracts.md` for the state
 * machines and the exact table this row is read from.
 *
 * `ApprovalPort` is Task 3's to add — this file stops at the row shape and
 * the two small pure helpers every later task needs.
 */

export type ApprovalDecision = "pending" | "approved" | "edited" | "rejected" | "withdrawn";

export type ApprovalDelivery = "none" | "sending" | "sent" | "blocked" | "suppressed" | "in_doubt";

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
};

export type DecisionInput =
  | { action: "approve" }
  | { action: "edit"; text: string }
  | { action: "reject"; reason: string };

export type DecisionInputErrorCode = "edit_requires_text" | "reject_requires_reason";

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
  delivery: ApprovalDelivery;
  deliveryError: string | null;
}): string {
  if (input.decision === "rejected") {
    return [
      "A human REJECTED the reply you asked to send, and it was not sent.",
      `Their reason: ${input.reason ?? "(none given)"}`,
      "Do not send that draft. Treat the reason as a correction: it is what this team will not say to this customer.",
    ].join("\n\n");
  }

  const opening =
    input.decision === "edited"
      ? "A human EDITED and approved the reply you asked to send. This is the final text, and the only version that may ever go out:"
      : "A human APPROVED the reply you asked to send, unchanged:";

  return [opening, input.text ?? "", deliveryLine(input.delivery, input.deliveryError)].join("\n\n");
}

function deliveryLine(delivery: ApprovalDelivery, error: string | null): string {
  switch (delivery) {
    case "sent":
      return "It has been sent to the customer thread. Carry on from there.";
    case "blocked":
      // The honest version of Phase 11's terminal state. The run resumes on
      // this, so the model has to be told what is still owed to the customer.
      return (
        `It was NOT sent (${error ?? "blocked"}), and it will not be sent automatically.`
        + " Sending as the on-duty engineer is not available yet, so the approved text above has to be posted by a human."
        + " Say so plainly in your answer, and do not try to send it another way."
      );
    case "suppressed":
      return (
        "This run is shadowing a conversation it must never write to, so nothing was sent"
        + " and nothing will be. The approved text is on the record for review only."
      );
    case "in_doubt":
      return (
        `The send was attempted and its outcome is unknown (${error ?? "unknown"}).`
        + " Do NOT send it again — a duplicate message to a customer cannot be taken back."
        + " A human has to check the thread and reconcile."
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
    | { withdrawn: false; decision: Exclude<ApprovalDecision, "pending" | "withdrawn"> }
  >;
}
