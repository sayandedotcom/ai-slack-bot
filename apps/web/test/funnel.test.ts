import { describe, expect, it } from "vitest";

import { funnelStages, isQuiet } from "@/lib/api/counters";

const day = {
  heard: 148,
  ingested: 140,
  triaged: 140,
  woken: 17,
  dropped: 123,
  escalated: 1,
};

describe("funnelStages", () => {
  it("scales every stage against heard, in order", () => {
    const stages = funnelStages(day);
    expect(stages.map((s) => s.key)).toEqual([
      "heard",
      "triaged",
      "woken",
      "escalated",
    ]);
    expect(stages[0]!.ratio).toBe(1);
    expect(stages[3]!.ratio).toBeCloseTo(1 / 148);
    expect(stages[3]!.accent).toBe(true);
    expect(stages.filter((s) => s.accent)).toHaveLength(1);
  });

  it("never divides by zero and never yields NaN", () => {
    const zero = {
      heard: 0,
      ingested: 0,
      triaged: 0,
      woken: 0,
      dropped: 0,
      escalated: 0,
    };
    for (const s of funnelStages(zero)) {
      expect(Number.isFinite(s.ratio)).toBe(true);
      expect(s.ratio).toBe(0);
    }
    expect(isQuiet(zero)).toBe(true);
    expect(isQuiet(day)).toBe(false);
  });
});
