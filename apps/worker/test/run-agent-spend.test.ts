import type { LanguageModelUsage } from "ai";
import { describe, expect, it } from "vitest";

import {
  costBreakdown,
  costNanoUsd,
  DEFAULT_SPEND_CEILING_NANO_USD,
  FABLE_5_MODEL_ID,
  FABLE_5_PRICES,
  normalizeUsage,
  spendCeilingFrom,
  spendDecision,
  spendStopWhen,
  spentNanoUsd,
  UnknownModelPriceError,
  worstCaseStepNanoUsd,
} from "../src/run/agent-spend";
import { AGENT_MODEL } from "../src/run/model";

function usage(over: {
  input?: number;
  noCache?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  reasoning?: number;
  total?: number;
}): LanguageModelUsage {
  return {
    inputTokens: over.input,
    inputTokenDetails: {
      noCacheTokens: over.noCache,
      cacheReadTokens: over.cacheRead,
      cacheWriteTokens: over.cacheWrite,
    },
    outputTokens: over.output,
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: over.reasoning,
    },
    totalTokens: over.total,
  } as LanguageModelUsage;
}

describe("pricing", () => {
  it("prices the model the loop actually calls", () => {
    // Two constants for one string, because agent.ts must not statically import
    // model.ts (the dynamic import is what keeps buildModel mockable under the
    // pool). This is the pin that keeps them equal.
    expect(AGENT_MODEL).toBe(FABLE_5_MODEL_ID);
  });

  it("charges a cache read at a tenth of a fresh input token", () => {
    const fresh = costNanoUsd(
      FABLE_5_MODEL_ID,
      usage({ input: 1_000, noCache: 1_000 })
    );
    const cached = costNanoUsd(
      FABLE_5_MODEL_ID,
      usage({ input: 1_000, cacheRead: 1_000 })
    );
    expect(fresh).toBe(1_000 * FABLE_5_PRICES.input);
    expect(cached).toBe(1_000 * FABLE_5_PRICES.cacheRead);
    expect(cached * 10).toBe(fresh);
  });

  it("charges a cache write at the TTL that was configured", () => {
    const short = costBreakdown({
      modelId: FABLE_5_MODEL_ID,
      usage: normalizeUsage(usage({ input: 100, cacheWrite: 100 })),
    });
    const long = costBreakdown({
      modelId: FABLE_5_MODEL_ID,
      usage: normalizeUsage(usage({ input: 100, cacheWrite: 100 })),
      cacheWriteTtl: "1h",
    });
    expect(short.cacheWriteNanoUsd).toBe(100 * FABLE_5_PRICES.cacheWrite5m);
    expect(long.cacheWriteNanoUsd).toBe(100 * FABLE_5_PRICES.cacheWrite1h);
  });

  it("bills input the provider did not classify rather than reporting a free request", () => {
    const breakdown = costBreakdown({
      modelId: FABLE_5_MODEL_ID,
      usage: normalizeUsage(usage({ input: 900, output: 10 })),
    });
    expect(breakdown.unclassifiedInputTokens).toBe(900);
    expect(breakdown.totalNanoUsd).toBe(
      900 * FABLE_5_PRICES.input + 10 * FABLE_5_PRICES.output
    );
  });

  it("never double-charges a token that is a subset of another count", () => {
    // reasoningTokens is a subset of outputTokens, and the three input details
    // are subsets of inputTokens. Charging either again would bill twice.
    const breakdown = costBreakdown({
      modelId: FABLE_5_MODEL_ID,
      usage: normalizeUsage(
        usage({
          input: 1_000,
          noCache: 400,
          cacheRead: 600,
          output: 200,
          reasoning: 150,
        })
      ),
    });
    expect(breakdown.unclassifiedInputTokens).toBe(0);
    expect(breakdown.totalNanoUsd).toBe(
      400 * FABLE_5_PRICES.input +
        600 * FABLE_5_PRICES.cacheRead +
        200 * FABLE_5_PRICES.output
    );
  });

  it("charges nothing for a response the provider did not bill, but keeps the counts", () => {
    const breakdown = costBreakdown({
      modelId: FABLE_5_MODEL_ID,
      usage: normalizeUsage(usage({ input: 5_000, noCache: 5_000 })),
      billing: "none",
    });
    expect(breakdown.totalNanoUsd).toBe(0);
    expect(breakdown.noCacheNanoUsd).toBe(5_000 * FABLE_5_PRICES.input);
  });

  it("refuses to price a model with no reviewed row", () => {
    expect(() => costNanoUsd("some-other-model", usage({ input: 1 }))).toThrow(
      UnknownModelPriceError
    );
  });

  it("fills in a missing total rather than reporting zero tokens", () => {
    expect(normalizeUsage(usage({ input: 30, output: 12 })).totalTokens).toBe(
      42
    );
    expect(normalizeUsage(undefined).totalTokens).toBe(0);
  });
});

describe("the spend decision", () => {
  const ceiling = 1_000_000_000; // $1.00

  it("allows a step that fits", () => {
    expect(
      spendDecision({
        spentNanoUsd: 100,
        ceilingNanoUsd: ceiling,
        estimateNanoUsd: 100,
      })
    ).toEqual({ allow: true });
  });

  it("refuses a step BEFORE it is bought, not after", () => {
    // Spent alone is under the ceiling. The point of the preflight is that the
    // step which would cross it is exactly the one that must be refused, and a
    // check on `spent` alone is always one step too late.
    const decision = spendDecision({
      spentNanoUsd: ceiling - 10,
      ceilingNanoUsd: ceiling,
      estimateNanoUsd: 1_000,
    });
    expect(decision.allow).toBe(false);
    expect(decision.allow === false && decision.reason).toContain(
      "spend ceiling"
    );
  });

  it("treats a ceiling of zero as unbounded", () => {
    expect(
      spendDecision({
        spentNanoUsd: Number.MAX_SAFE_INTEGER,
        ceilingNanoUsd: 0,
        estimateNanoUsd: 1,
      })
    ).toEqual({ allow: true });
  });

  it("estimates a step at the worst input rate it could be charged", () => {
    // Which class the NEXT step's input lands in is unknown until it is bought,
    // so the reservation assumes the most expensive one.
    const estimate = worstCaseStepNanoUsd({
      modelId: FABLE_5_MODEL_ID,
      promptBytes: 2_000,
      maxOutputTokens: 100,
    });
    expect(estimate).toBe(
      1_000 * FABLE_5_PRICES.cacheWrite1h + 100 * FABLE_5_PRICES.output
    );
  });
});

describe("the stop condition", () => {
  const step = (nanoUsdWorth: number) => ({
    usage: usage({
      input: nanoUsdWorth / FABLE_5_PRICES.input,
      noCache: nanoUsdWorth / FABLE_5_PRICES.input,
    }),
  });

  it("does not fire while the turn is under the ceiling", async () => {
    const stop = spendStopWhen(FABLE_5_MODEL_ID, 1_000_000_000);
    expect(
      await stop({ steps: [step(400_000_000), step(400_000_000)] as never })
    ).toBe(false);
  });

  it("fires once cumulative usage crosses it", async () => {
    const stop = spendStopWhen(FABLE_5_MODEL_ID, 1_000_000_000);
    expect(
      await stop({
        steps: [
          step(400_000_000),
          step(400_000_000),
          step(400_000_000),
        ] as never,
      })
    ).toBe(true);
  });

  it("never fires when the ceiling is unbounded", async () => {
    const stop = spendStopWhen(FABLE_5_MODEL_ID, 0);
    expect(await stop({ steps: [step(9_000_000_000)] as never })).toBe(false);
  });

  it("sums the steps of one turn", () => {
    expect(
      spentNanoUsd(FABLE_5_MODEL_ID, [step(10_000), step(20_000)] as never)
    ).toBe(30_000);
  });
});

describe("reading the ceiling from the environment", () => {
  it("uses the reviewed default when the var is absent or unusable", () => {
    // A typo must not remove the money bound, so every unparseable value falls
    // back to the default rather than to unbounded.
    for (const raw of [undefined, "", "   ", "five dollars", "-1", "1.5"]) {
      expect(spendCeilingFrom(raw)).toBe(DEFAULT_SPEND_CEILING_NANO_USD);
    }
  });

  it("honours an explicit value, including an explicit zero", () => {
    expect(spendCeilingFrom("250000000")).toBe(250_000_000);
    // Unbounded, and deliberately something someone has to type.
    expect(spendCeilingFrom("0")).toBe(0);
  });
});
