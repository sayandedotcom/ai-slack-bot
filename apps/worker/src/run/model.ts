/**
 * The model composer.
 *
 * A separate module for one reason, and it is a testing reason rather than an
 * aesthetic one: a STATIC import of this from `src/run/agent.ts` would land it
 * in the Worker entry's EAGER module graph, and anything in that graph cannot
 * be `vi.mock`ed under `@cloudflare/vitest-pool-workers` — the graph is
 * evaluated once at pool boot, before any test file runs. That silently
 * disabled six AI-Gateway auth-header assertions in the previous build. The
 * agent reaches this through `await import()` inside
 * `ctx.blockConcurrencyWhile` instead.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";

import type { Env } from "../index";

/** The strong model. Triage runs a cheap one; this loop talks to customers. */
export const AGENT_MODEL = "claude-fable-5";

/**
 * The test seam, and the only one.
 *
 * A turn with no model behind it cannot complete, so under the pool's
 * `AGENT_MODEL_DISABLED` every path that ends in `runTurn` is unassertable past
 * the submit. That is a harness limit rather than a property of the code, and
 * the fix is a model a test controls, not a weaker assertion.
 *
 * Module scope rather than an RPC argument, because a `LanguageModel` is a live
 * object and cannot cross a Durable Object stub. The precedent is
 * `installApprovalApiPorts` in `src/api/approvals.ts`: one nullable module
 * variable that production never writes, installed before the object under test
 * is first addressed.
 *
 * It takes precedence over `AGENT_MODEL_DISABLED` deliberately — a test that
 * installs one is asking for that model and nothing else — and it never reaches
 * the network, so the pool's empty Gateway settings stay the money guarantee
 * for every test that does NOT install one.
 */
let TEST_MODEL: LanguageModel | null = null;

/** Install the model every `RunAgent` built from here on will use. */
export function installTestModel(model: LanguageModel): void {
  TEST_MODEL = model;
}

/** Forget it. Production never calls either of these. */
export function resetTestModel(): void {
  TEST_MODEL = null;
}

/**
 * Build the model, or return null when the pool has switched model
 * construction off.
 *
 * Null rather than throwing, because construction happens in the DO
 * constructor: a test that never runs a turn must still be able to boot the
 * object. `getModel()` is the thing that throws, and it is only called when a
 * turn actually needs a model.
 *
 * There is no direct-Anthropic fallback. Every model call goes through AI
 * Gateway so that spend, retries and logs have exactly one owner.
 */
export function buildModel(env: Env): LanguageModel | null {
  if (TEST_MODEL !== null) return TEST_MODEL;
  if (env.AGENT_MODEL_DISABLED === "true") return null;

  const gatewayUrl = env.AI_GATEWAY_ANTHROPIC_URL;
  if (!gatewayUrl) {
    // Names the variable, never the value (invariant 39).
    throw new Error("AI_GATEWAY_ANTHROPIC_URL is not set");
  }
  if (!env.AI_GATEWAY_TOKEN) {
    throw new Error("AI_GATEWAY_ANTHROPIC_URL is set without AI_GATEWAY_TOKEN");
  }

  const anthropic = createAnthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    baseURL: gatewayUrl,
    headers: { "cf-aig-authorization": `Bearer ${env.AI_GATEWAY_TOKEN}` },
  });

  return anthropic(AGENT_MODEL);
}
