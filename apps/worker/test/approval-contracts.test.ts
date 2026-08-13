import { describe, expect, it } from "vitest";
import {
  DecisionInputError,
  outboundText,
  validateDecisionInput,
  type ApprovalRow,
} from "../src/approval/contracts";

function row(overrides: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id: "apr:1",
    runId: "run:1",
    generationId: "gen:1",
    draft: "the draft text",
    why: "closes the thread",
    channelId: "C1",
    threadTs: "1720000000.123456",
    shadow: false,
    decision: "pending",
    decidedBy: null,
    decidedAt: null,
    editedText: null,
    rejectReason: null,
    delivery: "none",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("outboundText", () => {
  it("returns the draft for a pending row", () => {
    expect(outboundText(row())).toBe("the draft text");
  });

  it("returns the draft for an approved row", () => {
    expect(outboundText(row({ decision: "approved", decidedBy: "a@zellify.app", decidedAt: 2 }))).toBe(
      "the draft text",
    );
  });

  it("returns the edited text for an edited row", () => {
    expect(
      outboundText(
        row({ decision: "edited", editedText: "the corrected text", decidedBy: "a@zellify.app", decidedAt: 2 }),
      ),
    ).toBe("the corrected text");
  });

  it("falls back to the draft for a decision:edited row with no edited text somehow present", () => {
    // Defensive: repository.ts is the sole writer and never produces this
    // shape, but outboundText must not throw or return null on it.
    expect(outboundText(row({ decision: "edited", editedText: null }))).toBe("the draft text");
  });
});

describe("validateDecisionInput", () => {
  it("accepts approve", () => {
    expect(() => validateDecisionInput({ action: "approve" })).not.toThrow();
  });

  it("accepts edit with non-blank text", () => {
    expect(() => validateDecisionInput({ action: "edit", text: "fixed text" })).not.toThrow();
  });

  it("accepts reject with non-blank reason", () => {
    expect(() => validateDecisionInput({ action: "reject", reason: "not accurate" })).not.toThrow();
  });

  it("refuses edit with empty text", () => {
    expect(() => validateDecisionInput({ action: "edit", text: "" })).toThrow(DecisionInputError);
    try {
      validateDecisionInput({ action: "edit", text: "" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DecisionInputError);
      expect((err as DecisionInputError).code).toBe("edit_requires_text");
    }
  });

  it("refuses edit with whitespace-only text", () => {
    expect(() => validateDecisionInput({ action: "edit", text: "   " })).toThrow(DecisionInputError);
  });

  it("refuses reject with empty reason", () => {
    expect(() => validateDecisionInput({ action: "reject", reason: "" })).toThrow(DecisionInputError);
    try {
      validateDecisionInput({ action: "reject", reason: "" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DecisionInputError);
      expect((err as DecisionInputError).code).toBe("reject_requires_reason");
    }
  });

  it("refuses reject with whitespace-only reason", () => {
    expect(() => validateDecisionInput({ action: "reject", reason: "  \n " })).toThrow(DecisionInputError);
  });
});
