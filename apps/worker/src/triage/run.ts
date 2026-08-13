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
  AI_GATEWAY_TOKEN?: string;
}): TriageRunner {
  const gatewayUrl = env.AI_GATEWAY_ANTHROPIC_URL?.trim();
  const gatewayToken = env.AI_GATEWAY_TOKEN?.trim();

  // The gateway is created with authentication ON, so routing through it
  // without `cf-aig-authorization` is a 401 on EVERY message — which the
  // consumer's `catch { message.retry() }` turns into a silent drain to the
  // DLQ. Setting only the URL used to look like a safe opt-in and is not:
  // the URL is what switches the base URL, and the token is what makes the
  // switched URL answer. They are one setting in two variables.
  if (gatewayUrl && !gatewayToken) {
    throw new Error(
      "AI_GATEWAY_ANTHROPIC_URL is set without AI_GATEWAY_TOKEN; the gateway is authenticated and would reject every triage call",
    );
  }

  const anthropic = createAnthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    // When the AI Gateway URL is set (Phase 10 formalizes it), requests route
    // through it for cost observability; unset falls straight to Anthropic.
    ...(gatewayUrl
      ? {
          baseURL: gatewayUrl,
          headers: { "cf-aig-authorization": `Bearer ${gatewayToken}` },
        }
      : {}),
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
