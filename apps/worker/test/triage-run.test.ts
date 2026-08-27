import { describe, expect, it } from "vitest";
import {
  haikuCostUsd,
  makeTriageRunner,
  triageSchema,
} from "../src/triage/run";

describe("triage schema", () => {
  it("has exactly wake, why, opening_prompt — no type field can ever appear", () => {
    // THE guard against the banned pipeline. If someone adds `type` or
    // `category`, this fails before any downstream consumer can branch on it.
    expect(Object.keys(triageSchema.shape).sort()).toEqual([
      "opening_prompt",
      "wake",
      "why",
    ]);
  });

  it("parses a valid decision and rejects a smuggled type field in strict mode", () => {
    const ok = triageSchema.safeParse({
      wake: true,
      why: "question",
      opening_prompt: "...",
    });
    expect(ok.success).toBe(true);
    const smuggled = triageSchema
      .strict()
      .safeParse({ wake: true, why: "q", opening_prompt: "p", type: "bug" });
    expect(smuggled.success).toBe(false);
  });
});

describe("makeTriageRunner gateway wiring", () => {
  // Regression: production ran for an hour with AI_GATEWAY_ANTHROPIC_URL set
  // and no token. The gateway is authenticated, so every triage call 401'd and
  // the consumer's `catch { message.retry() }` drained the queue to the DLQ
  // with `outcome: ok` in the logs and nothing in triage_decisions.
  it("refuses a gateway URL without its token instead of 401ing every message", () => {
    expect(() =>
      makeTriageRunner({
        ANTHROPIC_API_KEY: "sk-ant-test",
        AI_GATEWAY_ANTHROPIC_URL:
          "https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic",
      })
    ).toThrow(/AI_GATEWAY_TOKEN/);
  });

  it("composes with both set, and with neither", () => {
    expect(() =>
      makeTriageRunner({
        ANTHROPIC_API_KEY: "sk-ant-test",
        AI_GATEWAY_ANTHROPIC_URL:
          "https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic",
        AI_GATEWAY_TOKEN: "cfut-test",
      })
    ).not.toThrow();
    expect(() =>
      makeTriageRunner({ ANTHROPIC_API_KEY: "sk-ant-test" })
    ).not.toThrow();
  });

  it("treats a blank token as absent, so a cleared secret fails loudly", () => {
    expect(() =>
      makeTriageRunner({
        ANTHROPIC_API_KEY: "sk-ant-test",
        AI_GATEWAY_ANTHROPIC_URL:
          "https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic",
        AI_GATEWAY_TOKEN: "   ",
      })
    ).toThrow(/AI_GATEWAY_TOKEN/);
  });
});

describe("haikuCostUsd", () => {
  it("prices at $1/MTok in, $5/MTok out", () => {
    expect(
      haikuCostUsd({ inputTokens: 1_000_000, outputTokens: 0 })
    ).toBeCloseTo(1.0);
    expect(
      haikuCostUsd({ inputTokens: 0, outputTokens: 1_000_000 })
    ).toBeCloseTo(5.0);
    expect(haikuCostUsd({ inputTokens: 1000, outputTokens: 200 })).toBeCloseTo(
      0.002,
      5
    );
  });
});
