/**
 * scoreTriage turns stored triage decisions into precision/recall. Positive
 * class is `wake` (what the model decided); ground truth is `humanEngaged`
 * (a real human replied in-thread within 24h). The scorer must never lie
 * about a denominator being zero -- a null rate ("we never woke anyone") is
 * a different fact than a 0.0 rate ("we woke people and were always wrong"),
 * and callers that render one as the other would be reporting a number that
 * doesn't exist.
 */
import { describe, expect, it } from "vitest";

import { scoreTriage, type TriageOutcomeRow } from "../src/eval/triage-eval";

function row(
  id: string,
  wake: boolean,
  humanEngaged: boolean,
  extra: Partial<TriageOutcomeRow> = {}
): TriageOutcomeRow {
  return {
    eventId: id,
    wake,
    humanEngaged,
    why: extra.why ?? "because",
    text: extra.text ?? "some message text",
    permalink: extra.permalink ?? null,
  };
}

describe("scoreTriage: confusion cells", () => {
  it("counts all four cells correctly", () => {
    const rows = [
      row("tp1", true, true),
      row("tp2", true, true),
      row("fp1", true, false),
      row("fn1", false, true),
      row("fn2", false, true),
      row("fn3", false, true),
      row("tn1", false, false),
      row("tn2", false, false),
      row("tn3", false, false),
      row("tn4", false, false),
    ];
    const score = scoreTriage(rows);
    expect(score.n).toBe(10);
    expect(score.truePos).toBe(2);
    expect(score.falsePos).toBe(1);
    expect(score.falseNeg).toBe(3);
    expect(score.trueNeg).toBe(4);
  });
});

describe("scoreTriage: precision", () => {
  it("is null when wake was never true (nothing woken, no denominator)", () => {
    const rows = [row("a", false, true), row("b", false, false)];
    expect(scoreTriage(rows).precision).toBeNull();
  });

  it("is exactly 1.0 when every wake was engaged (not confused with null)", () => {
    const rows = [
      row("a", true, true),
      row("b", true, true),
      row("c", false, false),
    ];
    const score = scoreTriage(rows);
    expect(score.precision).toBe(1.0);
    expect(score.precision).not.toBeNull();
  });

  it("is exactly 0.0 when every wake was a false positive (not confused with null)", () => {
    const rows = [row("a", true, false), row("b", true, false)];
    const score = scoreTriage(rows);
    expect(score.precision).toBe(0.0);
    expect(score.precision).not.toBeNull();
  });

  it("computes a genuine fraction", () => {
    const rows = [row("a", true, true), row("b", true, false)];
    expect(scoreTriage(rows).precision).toBe(0.5);
  });
});

describe("scoreTriage: recall", () => {
  it("is null when nothing was humanEngaged (no denominator)", () => {
    const rows = [row("a", true, false), row("b", false, false)];
    expect(scoreTriage(rows).recall).toBeNull();
  });

  it("is exactly 1.0 when every engaged row was woken (not confused with null)", () => {
    const rows = [
      row("a", true, true),
      row("b", true, true),
      row("c", false, false),
    ];
    const score = scoreTriage(rows);
    expect(score.recall).toBe(1.0);
    expect(score.recall).not.toBeNull();
  });

  it("is exactly 0.0 when every engaged row was missed (not confused with null)", () => {
    const rows = [row("a", false, true), row("b", false, true)];
    const score = scoreTriage(rows);
    expect(score.recall).toBe(0.0);
    expect(score.recall).not.toBeNull();
  });

  it("computes a genuine fraction", () => {
    const rows = [row("a", true, true), row("b", false, true)];
    expect(scoreTriage(rows).recall).toBe(0.5);
  });
});

describe("scoreTriage: disagreements", () => {
  it("contains exactly the false positives and false negatives, nothing else", () => {
    const rows = [
      row("tp", true, true),
      row("tn", false, false),
      row("fp", true, false),
      row("fn", false, true),
    ];
    const score = scoreTriage(rows);
    const ids = score.disagreements.map((r) => r.eventId).sort();
    expect(ids).toEqual(["fn", "fp"]);
  });

  it("preserves the full row shape for each disagreement", () => {
    const fp = row("fp1", true, false, {
      why: "looked urgent",
      permalink: "https://x/1",
    });
    const score = scoreTriage([fp]);
    expect(score.disagreements).toEqual([fp]);
  });

  it("caps at maxDisagreements, keeping false negatives preferentially", () => {
    // 4 false negatives, 4 false positives, cap at 5 -- all 4 FNs must
    // survive (missed wakes cost more), plus exactly 1 FP.
    const fns = ["fn1", "fn2", "fn3", "fn4"].map((id) => row(id, false, true));
    const fps = ["fp1", "fp2", "fp3", "fp4"].map((id) => row(id, true, false));
    const score = scoreTriage([...fns, ...fps], 5);
    expect(score.disagreements).toHaveLength(5);
    const ids = new Set(score.disagreements.map((r) => r.eventId));
    for (const fn of fns) {
      expect(ids.has(fn.eventId)).toBe(true);
    }
    const survivingFps = score.disagreements.filter((r) =>
      r.eventId.startsWith("fp")
    );
    expect(survivingFps).toHaveLength(1);
  });

  it("drops false negatives beyond the cap only when FNs alone exceed it", () => {
    const fns = ["fn1", "fn2", "fn3", "fn4", "fn5"].map((id) =>
      row(id, false, true)
    );
    const score = scoreTriage(fns, 3);
    expect(score.disagreements).toHaveLength(3);
  });

  it("defaults the cap to 25", () => {
    const fns = Array.from({ length: 30 }, (_, i) =>
      row(`fn${i}`, false, true)
    );
    const score = scoreTriage(fns);
    expect(score.disagreements).toHaveLength(25);
  });

  it("does not cap below the actual count of disagreements", () => {
    const rows = [row("fp1", true, false), row("fn1", false, true)];
    const score = scoreTriage(rows, 25);
    expect(score.disagreements).toHaveLength(2);
  });
});

describe("scoreTriage: n and empty input", () => {
  it("sets n to the input length", () => {
    const rows = [
      row("a", true, true),
      row("b", false, false),
      row("c", true, false),
    ];
    expect(scoreTriage(rows).n).toBe(3);
  });

  it("returns n:0 and null rates for empty input", () => {
    const score = scoreTriage([]);
    expect(score.n).toBe(0);
    expect(score.truePos).toBe(0);
    expect(score.falsePos).toBe(0);
    expect(score.falseNeg).toBe(0);
    expect(score.trueNeg).toBe(0);
    expect(score.precision).toBeNull();
    expect(score.recall).toBeNull();
    expect(score.disagreements).toEqual([]);
  });
});
