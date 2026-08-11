import { describe, expect, it } from "vitest";
import { triageSchema, haikuCostUsd } from "../src/triage/run";

describe("triage schema", () => {
  it("has exactly wake, why, opening_prompt — no type field can ever appear", () => {
    // THE guard against the banned pipeline. If someone adds `type` or
    // `category`, this fails before any downstream consumer can branch on it.
    expect(Object.keys(triageSchema.shape).sort()).toEqual(["opening_prompt", "wake", "why"]);
  });

  it("parses a valid decision and rejects a smuggled type field in strict mode", () => {
    const ok = triageSchema.safeParse({ wake: true, why: "question", opening_prompt: "..." });
    expect(ok.success).toBe(true);
    const smuggled = triageSchema.strict().safeParse({ wake: true, why: "q", opening_prompt: "p", type: "bug" });
    expect(smuggled.success).toBe(false);
  });
});

describe("haikuCostUsd", () => {
  it("prices at $1/MTok in, $5/MTok out", () => {
    expect(haikuCostUsd({ inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(1.0);
    expect(haikuCostUsd({ inputTokens: 0, outputTokens: 1_000_000 })).toBeCloseTo(5.0);
    expect(haikuCostUsd({ inputTokens: 1000, outputTokens: 200 })).toBeCloseTo(0.002, 5);
  });
});
