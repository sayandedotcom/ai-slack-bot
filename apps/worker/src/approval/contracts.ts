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
