import { createAnthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import { buildTriagePrompt, TRIAGE_SYSTEM, type TriageInput } from "./prompt";

/**
 * Exactly three fields. A type/category field here would smuggle the banned
 * per-ticket-type pipeline back in — the shape test in triage-run.test.ts
 * is the enforcement, this comment is the reason.
 */
export const triageSchema = z.object({
  wake: z.boolean(),
  why: z.string(),
  opening_prompt: z.string(),
});

export type TriageDecision = z.infer<typeof triageSchema>;
export type TriageOutcome = TriageDecision & { model: string; cost_usd: number; latency_ms: number };
export type TriageRunner = (input: TriageInput) => Promise<TriageOutcome>;

export const TRIAGE_MODEL = "claude-haiku-4-5";

/** Haiku 4.5 list price: $1/MTok input, $5/MTok output (verified 2026-08-11). */
export function haikuCostUsd(usage: { inputTokens: number; outputTokens: number }): number {
  return (usage.inputTokens * 1 + usage.outputTokens * 5) / 1_000_000;
}

export function makeTriageRunner(env: {
  ANTHROPIC_API_KEY: string;
  AI_GATEWAY_ANTHROPIC_URL?: string;
}): TriageRunner {
  const anthropic = createAnthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    // When the AI Gateway URL is set (Phase 10 formalizes it), requests route
    // through it for cost observability; unset falls straight to Anthropic.
    ...(env.AI_GATEWAY_ANTHROPIC_URL ? { baseURL: env.AI_GATEWAY_ANTHROPIC_URL } : {}),
  });

  return async (input) => {
    const started = Date.now();
    const { object, usage } = await generateObject({
      model: anthropic(TRIAGE_MODEL),
      schema: triageSchema,
      system: TRIAGE_SYSTEM,
      prompt: buildTriagePrompt(input),
    });
    return {
      ...object,
      model: TRIAGE_MODEL,
      // Both usage fields are `number | undefined` in ai@7 — a missing count
      // must read as zero cost, never NaN in the D1 telemetry column.
      cost_usd: haikuCostUsd({
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
      }),
      latency_ms: Date.now() - started,
    };
  };
}
