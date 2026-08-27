import { env } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";

import {
  assertThinkingOmitted,
  CHAT_ERROR_MAX_CHARS,
} from "../../src/run/agent-contract";
import { chatRunKey } from "../../src/run/keys";
import {
  createOrGetRun,
  getRunById,
  readRunUsage,
} from "../../src/run/repository";

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

/** A step as `onStepEnd` receives it, with only the fields the hook reads. */
function step(over: Record<string, unknown> = {}) {
  return {
    callId: `gen-${crypto.randomUUID()}`,
    stepNumber: 0,
    model: { provider: "anthropic", modelId: "claude-fable-5" },
    finishReason: "stop",
    rawFinishReason: "end_turn",
    reasoning: [],
    usage: {
      inputTokens: 100,
      inputTokenDetails: {
        noCacheTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      outputTokens: 10,
      outputTokenDetails: { textTokens: 10, reasoningTokens: 0 },
      totalTokens: 110,
    },
    performance: { stepTimeMs: 900 },
    response: { id: "req_1", headers: {} },
    ...over,
  };
}

function chatResult(status: "completed" | "error" | "aborted") {
  return {
    message: { id: "m1", role: "assistant", parts: [] },
    requestId: "r1",
    continuation: false,
    status,
  };
}

describe("terminal status", () => {
  it("goes idle when a turn completes with nothing pending", async () => {
    const { run, stub } = await boundRun();
    await stub.onStepEnd(step() as never);
    expect((await stub.runStateForTest()).status).toBe("live");

    await stub.onChatResponse(chatResult("completed") as never);
    expect((await stub.runStateForTest()).status).toBe("idle");
    expect((await getRunById(env.DB, run.id))?.status).toBe("idle");
  });

  it("parks on awaiting_approval when a decision is outstanding", async () => {
    // Defect 3: reporting a run idle while a human still has its card open is
    // what made a waiting approval look finished.
    const { run, stub } = await boundRun();
    await stub.onStepEnd(step() as never);
    await stub.setOpenApproval("apr:9");

    await stub.onChatResponse(chatResult("completed") as never);
    expect((await stub.runStateForTest()).status).toBe("awaiting_approval");
    expect((await getRunById(env.DB, run.id))?.status).toBe(
      "awaiting_approval"
    );
  });

  it("fails on an errored or aborted turn", async () => {
    for (const status of ["error", "aborted"] as const) {
      const { stub } = await boundRun();
      await stub.onStepEnd(step() as never);
      await stub.onChatResponse(chatResult(status) as never);
      expect((await stub.runStateForTest()).status).toBe("failed");
    }
  });

  it("never sets done on its own", async () => {
    // `done` releases the Slack thread back to triage. A turn ending is not a
    // conversation ending, so only an explicit close may set it.
    const { stub } = await boundRun();
    await stub.onStepEnd(step() as never);
    await stub.onChatResponse(chatResult("completed") as never);
    expect((await stub.runStateForTest()).status).not.toBe("done");
  });
});

describe("refusals", () => {
  it("treats a content-filter finish as a failed outcome, not a clean stop", async () => {
    // @ai-sdk/anthropic maps Anthropic's `stop_reason: refusal` to
    // finishReason "content-filter": HTTP 200, a normal finish, and no answer.
    const { stub } = await boundRun();
    await stub.onStepEnd(
      step({
        finishReason: "content-filter",
        rawFinishReason: "refusal",
      }) as never
    );
    await stub.onChatResponse(chatResult("completed") as never);
    expect((await stub.runStateForTest()).status).toBe("failed");
  });

  it("records the refused step's tokens but charges nothing for it", async () => {
    const { run, stub } = await boundRun();
    await stub.onStepEnd(
      step({
        finishReason: "content-filter",
        rawFinishReason: "refusal",
      }) as never
    );
    const [aggregate] = await readRunUsage(env.DB, run.id);
    expect(aggregate.inputTokens).toBe(100);
    expect(aggregate.costNanoUsd).toBe(0);
  });

  it("does not carry a refusal into the next turn", async () => {
    const { stub } = await boundRun();
    await stub.onStepEnd(step({ finishReason: "content-filter" }) as never);
    await stub.onChatResponse(chatResult("completed") as never);

    await stub.onStepEnd(step() as never);
    await stub.onChatResponse(chatResult("completed") as never);
    expect((await stub.runStateForTest()).status).toBe("idle");
  });
});

describe("thinking blocks", () => {
  it("passes omitted thinking through unchanged", () => {
    // What the provider returns under `display: "omitted"`: a signed block with
    // an empty text field, replayable and unreadable.
    expect(() =>
      assertThinkingOmitted([
        {
          type: "reasoning",
          text: "",
          providerMetadata: { anthropic: { signature: "sig" } },
        },
        {
          type: "reasoning",
          text: "",
          providerMetadata: { anthropic: { redactedData: "…" } },
        },
      ])
    ).not.toThrow();
    expect(() => assertThinkingOmitted(undefined)).not.toThrow();
    expect(() =>
      assertThinkingOmitted([
        { type: "reasoning-file", mediaType: "text/plain" },
      ])
    ).not.toThrow();
  });

  it("fails the step when readable reasoning reaches the transcript", () => {
    // Invariant 17. If this ever fires, the provider option was dropped and
    // every downstream sink would be storing customer-derived reasoning.
    expect(() =>
      assertThinkingOmitted([
        { type: "reasoning", text: "the customer's card ends 4242" },
      ])
    ).toThrow(/invariant 17/);
  });

  it("ends the turn rather than logging and continuing", async () => {
    const { stub } = await boundRun();
    const outcome = await stub.stepEndOutcomeForTest(
      step({ reasoning: [{ type: "reasoning", text: "readable" }] })
    );
    expect(outcome).toMatch(/invariant 17/);
  });
});

describe("the client-visible error", () => {
  it("scrubs credential shapes out of what every tab sees", async () => {
    const { stub } = await boundRun();
    const text = String(
      await stub.onChatError(
        "upstream said xoxb-1234567890-abcdefghijklmnop rejected the call"
      )
    );
    expect(text).not.toContain("xoxb-1234567890-abcdefghijklmnop");
    expect(text).toContain("The turn failed");
  });

  it("bounds it, because redact removes shapes and not volume", async () => {
    const { stub } = await boundRun();
    const text = String(await stub.onChatError("x".repeat(10_000)));
    expect(text.length).toBeLessThanOrEqual(
      "The turn failed: ".length + CHAT_ERROR_MAX_CHARS
    );
  });
});

describe("operator stop", () => {
  it("cancels without marking the run failed", async () => {
    // A human stopping a run is not the run failing.
    const { stub } = await boundRun();
    await stub.onStepEnd(step() as never);
    await stub.cancel();
    expect((await stub.runStateForTest()).status).toBe("live");
  });
});
