import { env } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/index";
import type { RunAgent } from "../src/run/agent";
import { firefighterSystemBlocks, firefighterTurnConfig } from "../src/run/agent-prompt";
import { createOrGetRun } from "../src/run/repository";

/**
 * The prompt hooks are the two SYNCHRONOUS seams of the chassis, so they are
 * exercised here directly rather than through a Durable Object stub: an RPC
 * stub cannot be handed to a local function, and `src/run/agent.ts` (owned by
 * another task) exposes no prompt test surface. The stand-in carries exactly
 * what the hooks read — the run key and the env — and a fresh key per case
 * keeps the shared-storage pool rule.
 */
function standIn(): RunAgent {
  return { name: `chat:${crypto.randomUUID()}`, env } as unknown as RunAgent;
}

describe("RunAgent prompt assembly", () => {
  it("keeps the generated declarations out of the prompt and pins the two turn flags", async () => {
    const agent = standIn();

    // Refreshes the run's facts against real D1 (this run has no `runs` row, so
    // the resolver refuses and the dynamic block says so) and returns the turn
    // configuration in one call — the shape `beforeTurn` forwards.
    const config = await firefighterTurnConfig(agent);
    const system = firefighterSystemBlocks(agent)
      .map((block) => block.content)
      .join("\n");

    // Invariant 24: the capability declarations live ONLY in the `run_code`
    // tool description. A leaked copy in the system prompt is silent — it costs
    // tokens on every request and drifts from the real surface.
    expect(system).not.toContain("declare const");
    expect(system).not.toContain("declare namespace");
    expect(system).not.toContain("{{types}}");
    // ...and the prompt is not empty, so the absence above means something.
    expect(system).toContain("run_code");
    expect(system).toContain("## This run (trusted host facts)");

    // Invariant 27: AI Gateway is the only retry owner. The SDK default of 2
    // would quadruple worst-case spend with nothing thrown.
    expect(config.maxRetries).toBe(0);

    // Invariant 6: one `run_code` call at a time — the effect ledger's
    // at-most-once guarantee and the approval latch are both per-call.
    expect(
      (config.providerOptions?.anthropic as { disableParallelToolUse?: boolean } | undefined)
        ?.disableParallelToolUse,
    ).toBe(true);
  });

  it("tells the model about the approval it is parked on", async () => {
    // Through a REAL agent, not the stand-in: the open approval lives in the
    // Durable Object's own `approvals` table, and the failure this guards is
    // silent — the prompt used to pass `storage: null` to the resolver, so
    // `pendingApproval` was always null and a woken generation was never told
    // a decision was outstanding. It then either escalates a second reply or
    // sends the draft itself, under a real engineer's name.
    const key = `chat:${crypto.randomUUID()}`;
    await createOrGetRun(env.DB, { key, origin: "chat", channelId: null, threadTs: null });
    const agent = await getAgentByName<Env, RunAgent>(env.RUN_AGENTS, key);

    await agent.escalate({
      draft: "The 502s stopped at 14:10 after the rollback.",
      why: "first customer-facing claim about the outage",
    });

    const prompt = (await agent.promptBlocksForTest()).join("\n");

    expect(prompt).toContain("### One reply is waiting on a human");
    // Its own words, read back from the host's record and JSON-quoted.
    expect(prompt).toContain(JSON.stringify("The 502s stopped at 14:10 after the rollback."));
    expect(prompt).toContain("approval: apr:");
  });
});
