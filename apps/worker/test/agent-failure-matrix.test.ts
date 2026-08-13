import { afterEach, describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { resetRunPorts } from "../src/agent/driver";
import {
  listEvents,
  listTurns,
  listPendingUsageProjections,
  readDriver,
  readModelTranscript,
} from "../src/run/session";
import {
  customerTurn,
  errorAfterTextStep,
  errorAfterToolInputStep,
  freshLoopRun,
  mockModel,
  textStep,
  toolStep,
  unknownToolStep,
  usageVariantStep,
} from "./helpers/agent-loop";

/**
 * The rows of the failure matrix that the happy-path suites cannot reach.
 *
 * Every case drives the REAL `streamText()` loop through `makeAgentContinuation`
 * against a `MockLanguageModelV4` — never a fake that returns the finished state
 * directly — so what is asserted is what the shipping composition does. Nothing
 * here can reach a network: the provider is a scripted mock and the capability
 * layer runs against fake vendor ports.
 *
 * Rows already proven elsewhere are NOT duplicated here. `agent-loop.test.ts`
 * owns the pre-first-chunk provider error, the Code Mode error-as-value, the
 * refusal, the step ceiling and the generation spend cap; `agent-steering.test.ts`
 * owns both abort rows; `agent-cost.test.ts` and `agent-memory.test.ts` own the
 * two projection-failure rows. This file covers what was left.
 */

afterEach(() => {
  resetRunPorts();
});

/** Programs the REAL isolate runs. No capability needed, no vendor reached. */
const TRIVIAL = "async () => ({ ok: true })";

async function assistantUpdates(
  harness: Awaited<ReturnType<typeof freshLoopRun>>,
): Promise<{ state: string; delta?: string; error?: string }[]> {
  const events = await harness.storage((storage) => listEvents(storage, 0, 500));
  return events.flatMap((event) => (event.type === "assistant_update" ? [event.update] : []));
}

/* ------------------------------------------- a provider error mid-stream -- */

describe("a provider error after visible text terminates the draft", () => {
  it("never promotes the buffered draft to a final turn", async () => {
    const model = mockModel([
      errorAfterTextStep({
        chunks: ["the export worker looks hea", "lthy, so the next thing to check"],
        message: "upstream connection reset mid-stream",
      }),
    ]);
    const harness = await freshLoopRun({ model, flush: { chars: 1 } });
    await harness.stub.appendTurn(customerTurn("t1"));
    await harness.alarm();

    // A bounded retry, not a failure and not an answer.
    expect(harness.results[0]).toMatchObject({
      path: "infrastructure_retry",
      errorCode: "provider_stream_failed",
    });

    // The draft text really was on the wire...
    const updates = await assistantUpdates(harness);
    expect(updates.some((update) => update.state === "streaming")).toBe(true);

    // ...and it was terminated rather than left hanging, so no client is holding
    // a draft with nothing coming for it.
    expect(updates.at(-1)).toMatchObject({ state: "failed" });

    // Nothing became an answer, and nothing entered the model transcript: the
    // step never ended, so there is no checkpoint to continue from.
    const turns = await harness.storage((storage) => listTurns(storage));
    expect(turns.filter((turn) => turn.source === "agent")).toHaveLength(0);
    expect(await harness.storage((storage) => readModelTranscript(storage))).toHaveLength(1);

    const driver = await harness.storage((storage) => readDriver(storage));
    expect(driver.phase).toBe("scheduled");
    expect(driver.retryCount).toBe(1);
  });

  it("fails the same way when the error lands while the program is streaming", async () => {
    const model = mockModel([
      errorAfterToolInputStep({
        toolCallId: "call_dead",
        code: TRIVIAL,
        message: "upstream connection reset during tool input",
      }),
    ]);
    const harness = await freshLoopRun({ model });
    await harness.stub.appendTurn(customerTurn("t1"));
    await harness.alarm();

    expect(harness.results[0]).toMatchObject({
      path: "infrastructure_retry",
      errorCode: "provider_stream_failed",
    });
    // The tool never ran, so no outer lifecycle event was written and no effect
    // was attempted for a call the provider never issued.
    const events = await harness.storage((storage) => listEvents(storage, 0, 500));
    expect(events.filter((event) => event.type === "tool_call")).toHaveLength(0);
  });
});

/* ------------------------------------------------------- provider timeout -- */

describe("the provider's own timeouts, not a timeout-shaped message", () => {
  /**
   * These two drive the SDK's REAL `firstChunkMs`/`chunkMs` timers.
   *
   * They are the one place in these suites that must use wall-clock time: those
   * timers are `setTimeout` inside `ai@7.0.59`, so the injected `StreamClock`
   * cannot move them. The delays are set an order of magnitude above the
   * injected limit so the assertion is an ordering, not a race.
   */
  it("gives up on a provider that never sends a first chunk", async () => {
    const model = mockModel([textStep({ chunks: ["too late"] })], { initialDelayMs: 1_500 });
    const harness = await freshLoopRun({ model, limits: { firstChunkMs: 50 } });
    await harness.stub.appendTurn(customerTurn("t1"));
    await harness.alarm();

    expect(harness.results[0].path).toBe("provider_timeout");

    // Bounded: the driver schedules a retry rather than looping immediately or
    // failing the run outright.
    const driver = await harness.storage((storage) => readDriver(storage));
    expect(driver.phase).toBe("scheduled");
    expect(driver.retryCount).toBe(1);
    expect(driver.nextAttemptAt).toBeGreaterThan(0);

    // Nothing was billed: the step never ended, so no usage row exists.
    expect(
      await harness.storage((storage) => listPendingUsageProjections(storage, 50)),
    ).toHaveLength(0);
  });

  it("gives up on a stream that stalls after its first chunk", async () => {
    const model = mockModel([textStep({ chunks: ["starting", " to answer", " and then"] })], {
      holdAfterDelta: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      },
    });
    const harness = await freshLoopRun({
      model,
      limits: { firstChunkMs: 30_000, chunkMs: 50 },
    });
    await harness.stub.appendTurn(customerTurn("t1"));
    await harness.alarm();

    expect(harness.results[0].path).toBe("provider_timeout");
    const turns = await harness.storage((storage) => listTurns(storage));
    expect(turns.filter((turn) => turn.source === "agent")).toHaveLength(0);
    const updates = await assistantUpdates(harness);
    expect(updates.at(-1)).toMatchObject({ state: "failed" });
  });
});

/* ------------------------------------------------ an unanswerable tool call -- */

describe("a tool call the composition cannot answer", () => {
  it("fails the step rather than fabricating a result for an unknown tool", async () => {
    const model = mockModel([unknownToolStep("call_escalate")]);
    const harness = await freshLoopRun({ model });
    await harness.stub.appendTurn(customerTurn("t1"));
    await harness.alarm();

    // Whatever path this takes, two things must hold: no answer, and no invented
    // tool result in the durable transcript.
    expect(harness.results[0].path).not.toBe("completed");
    const turns = await harness.storage((storage) => listTurns(storage));
    expect(turns.filter((turn) => turn.source === "agent")).toHaveLength(0);

    const transcript = await harness.storage((storage) => readModelTranscript(storage));
    const serialized = JSON.stringify(transcript);
    expect(serialized).not.toContain("escalate");
    expect(transcript.every((row) => (row.message as ModelMessage).role !== "tool")).toBe(true);
  });
});

/* --------------------------------------------------------- context limit -- */

describe("a history that cannot be pruned safely", () => {
  it("reports context_limit instead of sending malformed history", async () => {
    // One byte of budget: the protected unsettled generation cannot fit, which
    // is precisely the case `selectModelHistory` refuses rather than truncates.
    const model = mockModel([textStep({ chunks: ["never reached"] })]);
    const harness = await freshLoopRun({
      model,
      historyBounds: { maxMessages: 50, maxBytes: 1 },
    });
    await harness.stub.appendTurn(customerTurn("t1"));
    await harness.alarm();

    expect(harness.results[0].path).toBe("malformed_history");
    expect(harness.results[0].errorCode).toContain("context_limit");

    const turns = await harness.storage((storage) => listTurns(storage));
    expect(turns.filter((turn) => turn.source === "agent")).toHaveLength(0);
    // The provider was never called, so nothing was billed for a request that
    // could not legally be built.
    expect(
      await harness.storage((storage) => listPendingUsageProjections(storage, 50)),
    ).toHaveLength(0);
  });
});

/* ------------------------------------------------------- usage variants -- */

describe("usage and cache detail variants survive the real adapter", () => {
  it("bills a fully classified step and a wholly unclassified one", async () => {
    const classified = mockModel([
      usageVariantStep({
        inputTokens: { total: 1_000, noCache: 400, cacheRead: 500, cacheWrite: 100 },
        outputTokens: { total: 50, text: 40, reasoning: 10 },
      }),
    ]);
    const withDetails = await freshLoopRun({ model: classified });
    await withDetails.stub.appendTurn(customerTurn("t1"));
    await withDetails.alarm();

    const billed = await withDetails.storage((storage) =>
      listPendingUsageProjections(storage, 50),
    );
    expect(billed).toHaveLength(1);
    // 400 x 10,000 + 500 x 1,000 + 100 x 12,500 + 50 x 50,000.
    expect(billed[0]!.costNanoUsd).toBe(400 * 10_000 + 500 * 1_000 + 100 * 12_500 + 50 * 50_000);
    // Reasoning tokens are recorded but not charged a second time.
    expect(billed[0]!.usage.reasoningTokens).toBe(10);

    const unclassified = mockModel([
      usageVariantStep({
        inputTokens: { total: 1_000, noCache: 0, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 50, text: 50, reasoning: 0 },
      }),
    ]);
    const withoutDetails = await freshLoopRun({ model: unclassified });
    await withoutDetails.stub.appendTurn(customerTurn("t2"));
    await withoutDetails.alarm();

    const plain = await withoutDetails.storage((storage) =>
      listPendingUsageProjections(storage, 50),
    );
    expect(plain).toHaveLength(1);
    // Every input token is charged as uncached input rather than as free.
    expect(plain[0]!.costNanoUsd).toBe(1_000 * 10_000 + 50 * 50_000);
  });
});

/* ------------------------------------- crash window 3: the tool never ran -- */

describe("crash window 3 — the provider asked for a tool that never started", () => {
  it("re-runs the whole step, because no step checkpoint exists to resume from", async () => {
    let calls = 0;
    const model = mockModel(
      [toolStep({ toolCallId: "call_1", code: TRIVIAL }), textStep({ chunks: ["done."] })],
      {
        onCall: (call) => {
          calls = call;
        },
      },
    );
    const harness = await freshLoopRun({ model });
    await harness.stub.appendTurn(customerTurn("t1"));
    await harness.alarm();

    // The whole generation ran to completion, which is the baseline the window
    // is measured against.
    expect(harness.results.at(-1)?.path).toBe("completed");
    expect(calls).toBe(2);

    // The durable trace of the tool-calling step is its checkpoint, written in
    // `onStepEnd` AFTER the tool result exists. A crash between `tool-call` and
    // the tool starting leaves no such row, so a reclaim re-sends the same
    // history and the model may call the tool again — under the SAME stable
    // agent turn id, which is what keeps Phase 09's ledger from performing the
    // effect twice (proven in agent-recovery.test.ts).
    const transcript = await harness.storage((storage) => readModelTranscript(storage));
    const toolMessages = transcript.filter(
      (row) => (row.message as ModelMessage).role === "tool",
    );
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]!.globalStep).toBe(0);
  });
});
