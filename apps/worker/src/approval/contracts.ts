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
