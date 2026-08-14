import { describe, expect, it } from "vitest";
import { detectAiTells } from "../src/eval/ai-tells";
import { VOICE_EXAMPLES } from "../src/agent/prompt/policy";

describe("detectAiTells", () => {
  it("returns [] for the canonical clean reply", () => {
    // Brief says: "Use VOICE_EXAMPLES[0].good verbatim as the canonical
    // clean-reply case." Phase 21 Task 4 fixed the em-dash drift in
    // VOICE_EXAMPLES[0].good and [1].good (policy.ts), so [0] is usable
    // verbatim again, as originally intended.
    expect(
      detectAiTells(VOICE_EXAMPLES[0]!.good),
    ).toEqual([]);
  });

  describe("preamble", () => {
    it("flags a fixed greeting-opener", () => {
      expect(detectAiTells("Thanks for reaching out! Here is the fix.")).toContain("preamble");
      expect(detectAiTells("I'd be happy to help with that.")).toContain("preamble");
    });

    it("does not flag a reply that merely starts with the word Thanks before substance", () => {
      // Near-miss: superficially similar but not on the fixed opener list.
      expect(detectAiTells("Thanks, that matches what we saw in the logs too.")).not.toContain(
        "preamble",
      );
    });
  });

  describe("great_question", () => {
    it("flags case-insensitively", () => {
      expect(detectAiTells("Great question! Let's dig in.")).toContain("great_question");
      expect(detectAiTells("good question, let me check.")).toContain("great_question");
    });

    it("does not flag unrelated use of the word question", () => {
      expect(detectAiTells("That's a fair question about billing.")).not.toContain(
        "great_question",
      );
    });
  });

  describe("bulleted_recap", () => {
    it("flags a bullet list whose intro line contains summarize/recap", () => {
      const text = "To summarize:\n- exports were broken\n- fix is out now";
      expect(detectAiTells(text)).toContain("bulleted_recap");
    });

    it("flags recap spelling too", () => {
      const text = "To recap:\n- exports were broken\n- fix is out now";
      expect(detectAiTells(text)).toContain("bulleted_recap");
    });

    it("does not flag a plain bullet list without a summary intro", () => {
      const text = "Two things:\n- exports were broken\n- fix is out now";
      expect(detectAiTells(text)).not.toContain("bulleted_recap");
    });

    it("does not flag a summary sentence with no bullet list", () => {
      expect(detectAiTells("To summarize, the fix is out.")).not.toContain("bulleted_recap");
    });
  });

  describe("closing_restatement", () => {
    it("flags a fixed closer", () => {
      expect(
        detectAiTells("The fix is out. Let me know if you have any other questions."),
      ).toContain("closing_restatement");
      expect(detectAiTells("Fixed now. Hope this helps.")).toContain("closing_restatement");
    });

    it("does not flag an unrelated closing sentence", () => {
      expect(detectAiTells("Fixed now. I'll post here if it regresses.")).not.toContain(
        "closing_restatement",
      );
    });
  });

  describe("exclaimed_thanks", () => {
    it("flags exclamation-marked gratitude", () => {
      expect(detectAiTells("Thanks for flagging!")).toContain("exclaimed_thanks");
    });

    it("does not flag plain gratitude without an exclamation mark", () => {
      expect(detectAiTells("Thanks for flagging this.")).not.toContain("exclaimed_thanks");
    });
  });

  describe("typography tells (policy.ts, 2026-08-14)", () => {
    it("flags an em dash", () => {
      expect(detectAiTells("Fixed now — deployed at 04:12.")).toContain("em_dash");
    });

    it("does not flag a hyphen or a plain comma", () => {
      expect(detectAiTells("Fixed now, deployed at 04:12 as a one-off.")).not.toContain(
        "em_dash",
      );
    });

    it("flags a semicolon", () => {
      expect(detectAiTells("Fixed now; deployed at 04:12.")).toContain("semicolon");
    });

    it("does not flag a colon", () => {
      expect(detectAiTells("Two things: exports, imports.")).not.toContain("semicolon");
    });

    it("flags an emoji", () => {
      expect(detectAiTells("Fixed now 🎉")).toContain("emoji");
    });

    it("does not flag plain ASCII text", () => {
      expect(detectAiTells("Fixed now, deployed at 04:12.")).not.toContain("emoji");
    });

    it("flags an exclamation mark", () => {
      expect(detectAiTells("Fixed now!")).toContain("exclamation");
    });

    it("does not flag a full stop", () => {
      expect(detectAiTells("Fixed now.")).not.toContain("exclamation");
    });
  });

  it("reports multiple tells in one text", () => {
    const text = "Great question! Thanks for flagging! Let me know if you have any other questions.";
    const tells = detectAiTells(text);
    expect(tells).toContain("great_question");
    expect(tells).toContain("exclaimed_thanks");
    expect(tells).toContain("closing_restatement");
    expect(tells).toContain("exclamation");
  });

  // REQUIRED assertion (task brief): every VOICE_EXAMPLES[*].good must be clean.
  //
  // Phase 21 Task 4 fixed the em-dash drift that used to live in
  // VOICE_EXAMPLES[0].good and [1].good — the exclusion that used to carve
  // those two out is gone, so this now covers the full set and is the guard
  // against the detector and the policy drifting apart again.
  it("returns [] for every VOICE_EXAMPLES[*].good entry", () => {
    VOICE_EXAMPLES.forEach((example) => {
      expect(detectAiTells(example.good)).toEqual([]);
    });
  });
});
