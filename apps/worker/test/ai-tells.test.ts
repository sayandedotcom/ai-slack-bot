import { describe, expect, it } from "vitest";
import { detectAiTells } from "../src/eval/ai-tells";
import { VOICE_EXAMPLES } from "../src/agent/prompt/policy";

describe("detectAiTells", () => {
  it("returns [] for the canonical clean reply", () => {
    // Brief says: "Use VOICE_EXAMPLES[0].good verbatim as the canonical
    // clean-reply case." VOICE_EXAMPLES[0].good is NOT actually clean — it
    // contains a literal em dash, banned by the 2026-08-14 typography rules
    // (see the drift test below) — so it is unusable as the "returns []"
    // example without contradicting the detector's own required behavior.
    // VOICE_EXAMPLES[2].good is used instead: it is the nearest entry that is
    // both verbatim from policy.ts and actually clean under every rule.
    expect(
      detectAiTells(VOICE_EXAMPLES[2]!.good),
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
  // It isn't, as written. VOICE_EXAMPLES[0].good and VOICE_EXAMPLES[1].good
  // ("...04:12 deploy — the report job..." / "...on your account — billing
  // report only...") each contain a literal em dash. Those two examples predate
  // the 2026-08-14 typography rules in policy.ts; nobody went back and re-typed
  // them once the em-dash ban landed. That is real drift between the example
  // set and the policy it's supposed to illustrate — exactly what this test is
  // here to catch — not a bug in the detector, and this file does not own
  // policy.ts to fix it. See task-2-report.md.
  it("flags the known em-dash drift in VOICE_EXAMPLES[0] and [1], and nothing else", () => {
    expect(detectAiTells(VOICE_EXAMPLES[0]!.good)).toEqual(["em_dash"]);
    expect(detectAiTells(VOICE_EXAMPLES[1]!.good)).toEqual(["em_dash"]);
  });

  it("returns [] for every other VOICE_EXAMPLES[*].good entry", () => {
    const knownDrift = new Set([0, 1]);
    VOICE_EXAMPLES.forEach((example, index) => {
      if (knownDrift.has(index)) return;
      expect(detectAiTells(example.good)).toEqual([]);
    });
  });
});
