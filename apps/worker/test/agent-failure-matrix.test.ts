import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { resetRunPorts } from "../src/agent/driver";
import { PRODUCTION_LIMITS } from "../src/codemode/contracts";
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
  latch,
  mockModel,
  textStep,
  toolStep,
  unknownToolStep,
  usageVariantStep,
} from "./helpers/agent-loop";
import { FakeClock } from "./helpers/agent-driver";

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
const ASSESSMENT =
  '{ platformValue: "low", blocking: "low", customerWeight: "low", evidence: "e" }';
/** A real `external_write` that goes through Phase 09's effect ledger. */
const WRITE_ONLY =
  `async () => linear.createIssue({ title: "t", description: "d", assessment: ${ASSESSMENT} })`;

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

    // The terminal path IS pinned now, and only because it stopped being purely
    // SDK-internal: an unregistered tool name also reaches `onStepEnd` as a
    // `tool-error`, which the loop refuses generically. The allowlist's precise
    // diagnosis must keep precedence, because the two settle differently — this
    // one `requires_input`, the generic one spends two more provider calls on a
    // bounded retry of a history that will produce the same bad call again.
    expect(harness.results[0]).toMatchObject({
      path: "malformed_history",
      errorCode: "malformed_response:unsupported_tool",
    });

    const turns = await harness.storage((storage) => listTurns(storage));
    expect(turns.filter((turn) => turn.source === "agent")).toHaveLength(0);

    const transcript = await harness.storage((storage) => readModelTranscript(storage));
    const serialized = JSON.stringify(transcript);
    expect(serialized).not.toContain("escalate");
    expect(transcript.every((row) => (row.message as ModelMessage).role !== "tool")).toBe(true);
  });
});

/* ------------------------------------- thrown tool infrastructure (row 5) -- */

describe("tool infrastructure that throws instead of returning a failure", () => {
  /**
   * The OTHER half of row 5, and the half that is actually about a THROW.
   *
   * `unknownToolStep` above is the model naming a tool that was never
   * registered. This one is the registered tool's own host prologue dying:
   * `codemode/tool.ts` reads the clock, builds the outer call id, constructs the
   * audit sink and allocates the execution record BEFORE either of its `try`
   * blocks, so a failure there escapes `execute` entirely instead of becoming
   * the `CodeModeOutput.error` value the model is told to read.
   *
   * `deps.clock` is the seam this test throws from, because it is the first
   * thing that prologue touches and the `dependencies` factory is the one
   * production-typed way to reach it. What is being simulated is not a broken
   * clock — it is any unknown host failure in that unguarded window, an audit
   * write or a scope construction included.
   *
   * The requirement is the row's, not the implementation's: the generation
   * retries or fails, and nothing the model would read as a tool answer is
   * checkpointed. Before the `onStepEnd` tool-error refusal in `agent/loop.ts`
   * this run COMPLETED — the SDK's synthetic `{ type: "error-text", value: <raw
   * host message> }` result was stored and the model answered on top of it.
   */
  it("retries the generation rather than letting the model answer over the failure", async () => {
    const model = mockModel([
      toolStep({ toolCallId: "call_1", code: TRIVIAL }),
      // Scripted so that a loop which swallowed the failure would visibly reach
      // an answer, which is exactly the outcome this row forbids.
      textStep({ chunks: ["the export worker is fine."] }),
    ]);
    const harness = await freshLoopRun({
      model,
      wrapDeps: (base) => ({
        ...base,
        clock: () => {
          throw new Error("the audit sink could not be constructed");
        },
      }),
    });
    await harness.stub.appendTurn(customerTurn("t1"));
    await harness.alarm();

    // Retry or failure — never an answer.
    expect(harness.results).toHaveLength(1);
    expect(harness.results[0]).toMatchObject({
      path: "infrastructure_retry",
      errorCode: "tool_execution_failed",
    });
    const driver = await harness.storage((storage) => readDriver(storage));
    expect(driver.phase).toBe("scheduled");
    expect(driver.retryCount).toBe(1);

    // The model was never given a second step to answer from: one provider call.
    const turns = await harness.storage((storage) => listTurns(storage));
    expect(turns.filter((turn) => turn.source === "agent")).toHaveLength(0);
    const updates = await assistantUpdates(harness);
    expect(updates.at(-1)).toMatchObject({ state: "failed" });

    // NO FABRICATED RESULT. The durable transcript carries the input and
    // nothing else: no tool message, and no trace of the host error string the
    // SDK offered in place of a result.
    const transcript = await harness.storage((storage) => readModelTranscript(storage));
    expect(transcript.every((row) => (row.message as ModelMessage).role !== "tool")).toBe(true);
    expect(JSON.stringify(transcript)).not.toContain("audit sink");
    expect(transcript.every((row) => row.kind === "input")).toBe(true);

    // The provider call the step DID make is still billed. Refusing the result
    // must not also lose the money that was already spent on it.
    const billed = await harness.storage((storage) => listPendingUsageProjections(storage, 50));
    expect(billed).toHaveLength(1);
    expect(billed[0]!.globalStep).toBe(0);
  });
});

/* ------------------------------ tool arguments the SDK refuses (row 4) -- */

describe("tool arguments the SDK refuses against the schema", () => {
  /**
   * The THIRD producer of `tool-error`, and the one that is not a failure of
   * ours at all.
   *
   * `run_code`'s input schema caps `code` at `PRODUCTION_LIMITS.maxCodeChars`
   * (`codemode/tool.ts:168`). A longer program is rejected by the SDK's own
   * validation BEFORE `execute` is called: nothing threw, no host call was
   * made, the isolate was never loaded. `ai@7.0.59` marks the call
   * `invalid: true` with an `InvalidToolInputError` on the `tool-call` part and
   * synthesizes a `tool-error` beside it.
   *
   * That is a model-authored malformation, and the failure matrix's row for it
   * is "failed tool event, model may continue" — the error-as-value contract,
   * not the thrown-infrastructure row above. The loop therefore hands the model
   * a HOST-AUTHORED refusal in `run_code`'s own `CodeModeOutput` shape and lets
   * it fix its own call. `codemode/executor.ts:200-205` says the same thing one
   * layer down for the same condition; the two are now consistent.
   *
   * Classifying this `infrastructure_retry` instead — measured — settles
   * `{ path: "infrastructure_retry", errorCode: "tool_execution_failed" }` with
   * `retryCount: 1`, and the retry re-runs the IDENTICAL history, so the model
   * re-emits the same over-long program until all three paid driver attempts
   * are gone.
   */
  const OVERLONG = `async () => { /* ${"x".repeat(PRODUCTION_LIMITS.maxCodeChars)} */ }`;

  it("lets the model correct its own call instead of retrying the generation", async () => {
    const model = mockModel([
      toolStep({ toolCallId: "call_long", code: OVERLONG }),
      // The corrected call. It really runs: `TRIVIAL` goes through the same
      // production composer and the same isolate every other tool step here
      // uses, so this asserts recovery, not merely "the loop kept going".
      toolStep({ toolCallId: "call_short", code: TRIVIAL }),
      textStep({ chunks: ["the export worker is fine."] }),
    ]);
    const harness = await freshLoopRun({ model });
    await harness.stub.appendTurn(customerTurn("t1"));
    await harness.alarm();

    // Self-correction, in one extra step. No retry, no attempt spent.
    expect(harness.results).toHaveLength(1);
    expect(harness.results[0]).toMatchObject({ path: "completed", errorCode: null });
    const driver = await harness.storage((storage) => readDriver(storage));
    expect(driver.phase).toBe("idle");
    expect(driver.retryCount).toBe(0);

    const turns = await harness.storage((storage) => listTurns(storage));
    expect(turns.filter((turn) => turn.source === "agent")).toHaveLength(1);

    // The refused call IS paired in durable history — an assistant tool-call
    // with a tool result — because the next request would be malformed without
    // it. What that result carries is the whole point.
    const transcript = await harness.storage((storage) => readModelTranscript(storage));
    const refused = transcript
      .flatMap((row) => {
        const message = row.message as ModelMessage;
        return message.role === "tool" && Array.isArray(message.content) ? message.content : [];
      })
      .filter((part) => part.type === "tool-result" && part.toolCallId === "call_long");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      type: "tool-result",
      toolName: "run_code",
      output: {
        // `error-json`, so `@ai-sdk/anthropic` sends it with `is_error: true`
        // and nothing can read it as a successful run.
        type: "error-json",
        value: {
          result: null,
          logs: [],
          error: expect.stringMatching(/^invalid_input: /) as unknown as string,
          metrics: { durationMs: 0, capabilityCalls: 0 },
        },
      },
    });

    // HOST-AUTHORED, and nothing else. The SDK's synthetic result for this case
    // is `"AI_InvalidToolInputError: Invalid input for tool run_code:
    // AI_TypeValidationError: Type validation failed: Value: <the entire
    // submitted program>. Error message: <zod issues>"`. None of it — not the
    // class name, not the zod issue codes, not the second copy of the program —
    // may reach a durable row.
    const serialized = JSON.stringify(transcript);
    expect(serialized).not.toContain("InvalidToolInputError");
    expect(serialized).not.toContain("TypeValidationError");
    expect(serialized).not.toContain("too_big");
    expect(serialized.split(OVERLONG.slice(0, 200)).length - 1).toBe(1);

    // The corrected call reached the real tool and produced a real result.
    const events = await harness.storage((storage) => listEvents(storage, 0, 500));
    const outer = events.flatMap((event) =>
      event.type === "tool_call" && event.update.name === "run_code" ? [event.update] : [],
    );
    expect(outer.map((update) => update.callId)).toEqual(["call_short", "call_short"]);
    expect(outer.at(-1)).toMatchObject({ state: "completed" });

    // Three steps, three billed provider calls, one per logical step. The
    // refused step is still a step and is still charged for.
    const billed = await harness.storage((storage) => listPendingUsageProjections(storage, 50));
    expect(billed.map((row) => row.globalStep)).toEqual([0, 1, 2]);
  });

  it("is still bounded: a model that never corrects itself hits the step ceiling", async () => {
    // The bound on self-correction is the one that bounds every other tool
    // loop, and it is not new: `stopWhen: stepCountIs(remainingSteps)` plus
    // `loop.ts`'s `remainingSteps` preflight, and the pre-step spend guard
    // beneath it. A model that re-emits the rejected program forever settles a
    // visible `step_limit`, it does not spin.
    const model = mockModel([toolStep({ toolCallId: "call_long", code: OVERLONG })]);
    const harness = await freshLoopRun({ model, limits: { maxStepsPerGeneration: 3 } });
    await harness.stub.appendTurn(customerTurn("t1"));
    await harness.alarm();

    expect(harness.results[0]).toMatchObject({ path: "step_limit", errorCode: "step_limit" });
    const billed = await harness.storage((storage) => listPendingUsageProjections(storage, 50));
    expect(billed).toHaveLength(3);
    const turns = await harness.storage((storage) => listTurns(storage));
    expect(turns.filter((turn) => turn.source === "agent")).toHaveLength(0);
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
  it("writes the step's tool message only at onStepEnd, after the result exists", async () => {
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

  /**
   * The window itself, simulated the way windows 1, 2 and 4 are simulated in
   * `agent-recovery.test.ts`: not by killing anything, but by letting a claimed
   * attempt's lease run out where the crash would have happened and letting a
   * successor reclaim it.
   *
   * `holdAfterToolInput` parks the FIRST attempt's provider stream inside the
   * `run_code` argument — the model's program is on the wire, the tool has not
   * been called, and nothing about this step exists durably. That is the window.
   * The clock then jumps past the 150-second lease and a second alarm delivery
   * reclaims, exactly as `agent-concurrency.test.ts:96` does with a fake
   * continuation; here both attempts are the REAL loop against the REAL isolate.
   *
   * The provider script re-issues the tool call on the reclaim because that is
   * what a model re-sent the identical history does: nothing was checkpointed,
   * so the second attempt sees the same conversation the first one did.
   */
  it("reclaims the parked step, re-runs it whole, and files the issue exactly once", async () => {
    const clock = new FakeClock();
    const parked = latch();
    const release = latch();
    const reclaimed = latch();
    let filed = 0;

    const model = mockModel(
      [
        // Attempt 1's step, parked mid-argument and then superseded.
        toolStep({ toolCallId: "call_lost", code: WRITE_ONLY }),
        // Attempt 2 re-sends the same history and asks for the same work.
        toolStep({ toolCallId: "call_kept", code: WRITE_ONLY }),
        textStep({ chunks: ["filed FF-1 for the stuck deploy."] }),
      ],
      {
        onCall: (call) => {
          if (call === 2) reclaimed.open();
        },
        holdAfterToolInput: async (call) => {
          if (call !== 1) return;
          parked.open();
          await release.wait();
        },
      },
    );

    const harness = await freshLoopRun({
      model,
      clock,
      // Slack, because `linear.createIssue` is a real `external_write` and the
      // write guard re-reads a live channel policy before it acts.
      origin: "slack",
      wrapDeps: (base) => ({
        ...base,
        linear: {
          ...base.linear,
          async createIssue(...args: Parameters<typeof base.linear.createIssue>) {
            filed += 1;
            return base.linear.createIssue(...args);
          },
        },
      }),
    });
    await harness.stub.appendTurn(customerTurn("t1"));

    // Attempt 1 claims and parks in the window.
    const lost = harness.alarm();
    await parked.wait();
    expect(await harness.storage((storage) => readDriver(storage))).toMatchObject({
      phase: "running",
      attempt: 1,
    });

    // Its lease runs out where a crashed attempt's would have, and a plain
    // alarm delivery — no `deleteAlarm`, the platform's own re-delivery — takes
    // the run over.
    clock.advance(150_001);
    const successor = harness.stub.dispatchAlarm();
    await reclaimed.wait();

    // The successor is attempt 2 of the SAME generation — a reclaim continues
    // the work rather than forking a second conversation. Read while it is in
    // flight, because the driver clears `attempt` once the run settles.
    expect(await harness.storage((storage) => readDriver(storage))).toMatchObject({
      phase: "running",
      attempt: 2,
    });

    // Only now is the lost attempt allowed to finish its stream.
    release.open();
    const [lostOutcome] = await Promise.all([lost, successor]);
    expect(lostOutcome.model).toBe("claimed");

    // THE DOCUMENTED RECOVERY RESULT. The lost attempt settles nothing: the
    // fence refuses its checkpoint, so it reports `aborted_stale_claim` and the
    // successor owns the answer.
    expect(harness.results.map((result) => result.path).sort()).toEqual([
      "aborted_stale_claim",
      "completed",
    ]);

    // ONE generation throughout, so the effect scope — the stable agent turn id
    // derived from it — never moved. That is what makes re-issuing the tool call
    // safe rather than merely lucky (agent-recovery.test.ts:134).
    const generations = await harness.storage((storage) =>
      storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM agent_generations").one().n,
    );
    expect(generations).toBe(1);

    // NO SIDE EFFECT RAN TWICE. The lost attempt's `run_code` never reached the
    // isolate: the durable freshness guard re-read the claim epoch, found the
    // successor's, and refused before a capability existed.
    expect(filed).toBe(1);
    const effects = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM codemode_effects WHERE run_id = ? AND method = 'createIssue'",
    )
      .bind(harness.runId)
      .first<{ n: number }>();
    expect(effects?.n).toBe(1);

    // NO FABRICATED TOOL RESULT. The transcript holds the successor's step and
    // nothing of the lost one — no second tool message, and no trace of the
    // refusal the lost attempt's own tool call returned to it.
    const transcript = await harness.storage((storage) => readModelTranscript(storage));
    const toolMessages = transcript.filter(
      (row) => (row.message as ModelMessage).role === "tool",
    );
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]!.globalStep).toBe(0);
    const serialized = JSON.stringify(transcript);
    expect(serialized).not.toContain("stale_generation");
    expect(serialized).not.toContain("call_lost");

    // One answer, from the successor.
    const turns = await harness.storage((storage) => listTurns(storage));
    const answers = turns.filter((turn) => turn.source === "agent");
    expect(answers).toHaveLength(1);
    expect(answers[0]!.content).toBe("filed FF-1 for the stuck deploy.");

    // The cost of the window, stated rather than hidden: the lost attempt's
    // provider call was made and is billed, unfenced, alongside the two the
    // successor made. Re-running the step is not free.
    const billed = await harness.storage((storage) =>
      listPendingUsageProjections(storage, 50),
    );
    expect(billed.map((row) => row.globalStep).sort()).toEqual([0, 0, 1]);
  });
});
