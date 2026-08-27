import { env } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { FirefighterConnector } from "../src/capabilities/connector";
import {
  newCodeExecution,
  PRODUCTION_LIMITS,
  staleGeneration,
} from "../src/capabilities/execution";
import {
  auditedCapability,
  type BindingContext,
} from "../src/capabilities/registry";
import { chatRunKey } from "../src/run/keys";
import { createOrGetRun } from "../src/run/repository";

/** A bound run: the D1 row the scope resolves from, plus the agent stub. */
async function boundRun() {
  const key = chatRunKey(crypto.randomUUID());
  const run = await createOrGetRun(env.DB, {
    key,
    origin: "chat",
    channelId: null,
    threadTs: null,
  });
  const stub = await getAgentByName(env.RUN_AGENTS, key);
  await stub.bindRun({ runId: run.id, channel: "web" });
  return { run, stub };
}

describe("the freshness guard at the tool boundary", () => {
  it("allows a tool call on a current turn", async () => {
    const { stub } = await boundRun();
    await stub.noteInput();
    await stub.beforeTurnForTest();
    expect(await stub.toolCallDecisionForTest()).toBeUndefined();
  });

  it("substitutes stale_generation when a newer message arrived mid-turn", async () => {
    const { stub } = await boundRun();
    await stub.noteInput();
    await stub.beforeTurnForTest(); // the turn snapshots revision 1
    await stub.noteInput(); // …and revision 2 arrives while it works

    const decision = await stub.toolCallDecisionForTest();
    // An OBJECT with an `error`, not a thrown error: the model has to be able to
    // read what happened and change course, which a rejected tool call does not
    // let it do.
    expect(decision).toEqual({
      action: "substitute",
      output: {
        error: "stale_generation",
        message: expect.stringContaining("newer message"),
      },
    });
  });

  it("blocks tool work while the run is parked on a human decision", async () => {
    const { stub } = await boundRun();
    await stub.noteInput();
    await stub.beforeTurnForTest();
    await stub.setOpenApproval("apr:1");

    const decision = await stub.toolCallDecisionForTest();
    expect(decision?.action).toBe("block");
    // `block` and not `substitute`: being parked is a state, not a failure, and
    // the reason reaches the model as the tool result so it can stop and wait.
    expect(decision).toMatchObject({
      reason: expect.stringContaining("paused"),
    });

    await stub.setOpenApproval(null);
    expect(await stub.toolCallDecisionForTest()).toBeUndefined();
  });

  it("takes precedence over freshness, because waiting is the stronger answer", async () => {
    const { stub } = await boundRun();
    await stub.noteInput();
    await stub.beforeTurnForTest();
    await stub.noteInput();
    await stub.setOpenApproval("apr:2");
    expect((await stub.toolCallDecisionForTest())?.action).toBe("block");
  });
});

describe("the freshness guard inside a capability call", () => {
  it("refuses at the NEXT capability call, not only at the next tool call", async () => {
    // One run_code block can spend ten seconds making twenty capability calls.
    // beforeToolCall never runs during that, so without this guard the whole
    // plan would execute against input somebody has already replaced.
    const { stub } = await boundRun();
    await stub.noteInput();
    await stub.beforeTurnForTest();
    expect(await stub.freshnessForTest()).toBeNull();

    await stub.noteInput();
    expect(await stub.freshnessForTest()).toBe("stale_generation");
  });

  it("is not stale before any turn has started", async () => {
    const { stub } = await boundRun();
    await stub.noteInput();
    expect(await stub.freshnessForTest()).toBeNull();
  });
});

describe("the per-execution call budget", () => {
  it("trips once one execution has spent its calls", async () => {
    // The budget belongs to ONE run_code execution. Before the context was
    // memoised per executionId it was rebuilt per call, so the counter reset
    // every time and could never trip.
    const scope = {
      runId: "r",
      turnId: "t",
      origin: "chat" as const,
      shadow: false,
      customerSlug: null,
      customerSlugTrusted: false,
      slackThread: null,
      actor: null,
    };

    const connector = new FirefighterConnector<BindingContext>(
      {} as ExecutionContext,
      env,
      {
        name: "demo",
        build: (ctx) => ({
          // auditedCapability is the chokepoint that attaches the budget. A
          // bare defineCapability has none, which is exactly why the registry
          // refuses to assemble one.
          ping: auditedCapability(ctx, "demo", "ping", {
            description: "does nothing",
            effect: "read",
            input: z.object({}).default({}),
            output: z.object({ ok: z.boolean() }),
            run: async () => ({ ok: true }),
          }),
        }),
      },
      async (executionId) => ({
        scope,
        deps: {} as never,
        limits: PRODUCTION_LIMITS,
        execution: newCodeExecution({
          outerToolCallId: executionId,
          audit: {
            async started() {},
            async completed() {},
            async failed() {},
          },
          guard: { async assertFresh() {} },
          limits: PRODUCTION_LIMITS,
          clock: () => 0,
        }),
      })
    );

    const limit = PRODUCTION_LIMITS.maxCapabilityCalls;
    for (let i = 0; i < limit; i += 1) {
      await connector.executeTool("ping", {}, { executionId: "e1" });
    }
    await expect(
      connector.executeTool("ping", {}, { executionId: "e1" })
    ).rejects.toThrow(/budget of 40 capability calls/);

    // A different execution starts with its own budget.
    await expect(
      connector.executeTool("ping", {}, { executionId: "e2" })
    ).resolves.toBeDefined();
  });
});

describe("the refusal itself", () => {
  it("uses one vocabulary wherever supersession is caught", () => {
    // The tool-boundary substitute and the capability-layer throw must name the
    // same code, or an operator reading a transcript sees two different faults.
    expect(staleGeneration().code).toBe("stale_generation");
  });
});
