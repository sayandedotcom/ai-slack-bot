import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { resetRunPorts } from "../src/agent/driver";
import { abortForNewerInput } from "../src/agent/steering";
import {
  appendTurn,
  listEvents,
  listToolCalls,
  listTurns,
  readDriver,
  readGeneration,
  readModelTranscript,
} from "../src/run/session";
import type { RunEvent } from "../src/run/protocol";
import {
  customerTurn,
  freshLoopRun,
  interleavedToolStep,
  latch,
  mockModel,
  steerTurn,
  textStep,
  toolStep,
  type LoopHarness,
} from "./helpers/agent-loop";

/**
 * MID-FLIGHT STEERING: lossless, ordered, and race-safe.
 *
 * The one-sentence promise this file exists to prove, quoted from the plan:
 *
 *   > Steering is saved immediately. The agent reads it before its next model
 *   > step; if the current response is already finishing, that response is
 *   > superseded and the run continues with your steering.
 *
 * The plan's seven-row steering table is the specification, and every row has a
 * case below:
 *
 *   1. run is idle                     -> "an idle run wakes once"
 *   2. provider streaming before tool  -> "the two-steer barrier"
 *   3. run_code has not started        -> "the outer call is refused"
 *   4. capability between calls        -> "the next capability is refused"
 *   5. upstream write already started  -> "an already-sent write is not undone"
 *   6. final text already streaming    -> "the late final is superseded" + abort
 *   7. generation has settled          -> "a settled run starts a new generation"
 *
 * LOCAL AND AUTOMATED, with no exceptions: a `MockLanguageModelV4`, this pool's
 * own Durable Object, the REAL production continuation factory, and the REAL
 * Phase 09 isolate against fake vendor ports. Nothing here reaches a network.
 *
 * Two mechanics are used throughout and are worth reading once:
 *
 *  - `script.hold` / `script.holdAfterDelta` pause the PROVIDER while a claimed
 *    attempt is genuinely mid-flight, so steering arrives through the real
 *    `RunDO.appendTurn` RPC — the same entry point the dashboard socket uses —
 *    rather than being faked into storage;
 *  - `midStream` and `wrapDeps` commit input from INSIDE the object's execution
 *    context, through the synchronous session functions. That is not a
 *    shortcut: it is the only way to hit the two windows an external RPC cannot
 *    be timed into (between the last `prepareStep` and the finalization, and
 *    between two capability calls of one `run_code` execution).
 */

/** Programs the REAL isolate runs. */
const TRIVIAL = "async () => ({ ok: true })";
const ASSESSMENT =
  '{ platformValue: "low", blocking: "low", customerWeight: "low", evidence: "e" }';
/** A real `external_write` that goes through the effect ledger. */
const FILE_ISSUE = `linear.createIssue({ title: "t", description: "d", assessment: ${ASSESSMENT} })`;
const READ_THEN_WRITE = `async () => {
  const thread = await slack.thread({ limit: 5 });
  const issue = await ${FILE_ISSUE};
  return { thread: thread.length, issue };
}`;
const WRITE_ONLY = `async () => ${FILE_ISSUE}`;

afterEach(() => {
  resetRunPorts();
});

/* ------------------------------------------------------------- helpers -- */

type TranscriptInput = { sourceEventSeq: number | null; globalStep: number };

async function inputRows(harness: LoopHarness): Promise<TranscriptInput[]> {
  const transcript = await harness.storage((storage) => readModelTranscript(storage));
  return transcript
    .filter((row) => row.kind === "input")
    .map((row) => ({ sourceEventSeq: row.sourceEventSeq, globalStep: row.globalStep }));
}

async function assistantStates(harness: LoopHarness): Promise<string[]> {
  const events = await harness.storage((storage) => listEvents(storage, 0, 500));
  return events
    .filter((event) => event.type === "assistant_update")
    .map((event) => (event as { update: { state: string } }).update.state);
}

async function agentTurns(harness: LoopHarness) {
  const turns = await harness.storage((storage) => listTurns(storage, 200));
  return turns.filter((turn) => turn.source === "agent");
}

/**
 * The safety property that must hold after EVERY case in this file, whatever
 * order the race resolved in.
 *
 * Stated once, asserted everywhere: no trusted input is ever dropped, no input
 * is ever applied twice, and a run that still owes somebody an answer always has
 * an alarm armed to give it. A pending cursor with no alarm is a customer whose
 * message nothing will ever read.
 */
async function assertNothingLost(harness: LoopHarness, expectedInputSeqs: number[]): Promise<void> {
  const seqs = (await inputRows(harness)).map((row) => row.sourceEventSeq);
  expect(seqs).toEqual([...expectedInputSeqs].sort((a, b) => a - b));
  expect(new Set(seqs).size).toBe(seqs.length);

  const driver = await harness.storage((storage) => readDriver(storage));
  if (driver.pendingThroughSeq > driver.settledThroughSeq) {
    const alarm = await harness.storage((storage) => storage.getAlarm());
    expect(alarm).not.toBeNull();
  }
}

/* --------------------------------------------------- row 1: an idle run -- */

describe("row 1 — input on an idle run", () => {
  it("allocates exactly one generation, goes live, and arms one alarm", async () => {
    const harness = await freshLoopRun({ model: mockModel([textStep({ chunks: ["answered"] })]) });

    const before = await harness.storage((storage) => readDriver(storage));
    expect(before.phase).toBe("idle");

    const appended = await harness.stub.appendTurn(customerTurn("t1"));
    expect(appended.scheduling.outcome).toBe("allocated");
    expect(appended.statusEvent?.type).toBe("status");

    const driver = await harness.storage((storage) => readDriver(storage));
    expect(driver.phase).toBe("scheduled");
    expect(driver.pendingThroughSeq).toBe(appended.event.seq);
    expect(await harness.storage((storage) => storage.getAlarm())).not.toBeNull();

    const generations = await harness.storage((storage) =>
      storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM agent_generations").one().n,
    );
    expect(generations).toBe(1);
  });
});

/* ------------------------------- row 2 / step 1: the two-steer barrier -- */

describe("row 2 — the provider is streaming before a tool", () => {
  it("takes both steers exactly once, in RunEvent order, at the next prepareStep", async () => {
    const started = latch();
    const release = latch();
    const model = mockModel(
      [
        toolStep({ toolCallId: "call_1", code: TRIVIAL }),
        textStep({ chunks: ["both questions answered"] }),
      ],
      {
        hold: async (call) => {
          if (call !== 1) return;
          started.open();
          await release.wait();
        },
      },
    );
    const harness = await freshLoopRun({ model });

    // A socket, so the "steering appears immediately" half of the row is
    // asserted against what a browser actually receives, not against storage.
    const socket = await harness.stub.fetch("https://run/ws", {
      headers: { Upgrade: "websocket" },
    });
    const ws = socket.webSocket!;
    const inbox: unknown[] = [];
    ws.addEventListener("message", (event) => {
      inbox.push(JSON.parse(event.data as string));
    });
    ws.accept();

    const opening = await harness.stub.appendTurn(customerTurn("t1"));
    const running = harness.alarm();
    await started.wait();

    // THE BARRIER. The attempt is claimed, the provider call is in flight, and
    // these two commit through the same RPC the dashboard uses.
    const first = await harness.stub.appendTurn(steerTurn("s1", "actually, check billing"));
    const second = await harness.stub.appendTurn(steerTurn("s2", "and the webhook queue"));
    expect(first.appended).toBe(true);
    expect(second.appended).toBe(true);
    // Ordered by RunEvent sequence — allocated inside the input transaction —
    // not by arrival in any in-memory array (invariant 12).
    expect(first.event.seq).toBeLessThan(second.event.seq);
    // The same generation absorbs them; a second one would fork the transcript
    // and the Code Mode effect scope.
    expect(first.scheduling.outcome).toBe("joined");
    expect(second.scheduling.outcome).toBe("joined");

    // Saved IMMEDIATELY, and on the wire before the provider call has returned.
    const delivered = inbox
      .map((message) => message as { type: string; event?: RunEvent })
      .filter((message) => message.type === "event" && message.event?.type === "turn")
      .map((message) => (message.event as { turn: { id: string } }).turn.id);
    expect(delivered).toContain("s1");
    expect(delivered).toContain("s2");

    release.open();
    await running;
    ws.close();

    expect(harness.results.map((result) => result.path)).toEqual(["completed"]);

    // Exactly once each, in RunEvent order, and at the SECOND provider step —
    // this attempt re-queried durable input rather than holding an array from
    // step 0 (invariants 12, 13).
    const inputs = await inputRows(harness);
    expect(inputs).toEqual([
      { sourceEventSeq: opening.event.seq, globalStep: 0 },
      { sourceEventSeq: first.event.seq, globalStep: 1 },
      { sourceEventSeq: second.event.seq, globalStep: 1 },
    ]);
    await assertNothingLost(harness, [opening.event.seq, first.event.seq, second.event.seq]);
  });

  it("a steer during pre-tool narration cuts the step short, losing nothing", async () => {
    /**
     * THE COST OF THE ONE WINDOW THE STREAM CANNOT DISAMBIGUATE.
     *
     * While the first narration deltas of a step arrive, nothing distinguishes
     * "this step is the answer" from "this step is about to call a tool", so
     * the abort is armed and an RPC steer landing there cuts the invocation.
     * The narration tokens are paid for and discarded and the prompt is
     * re-sent — but the steer is not lost, the generation is the same one, and
     * the tool call simply happens on the continuation with the steer already
     * in front of the model.
     *
     * Asserted rather than left to be discovered, because it is the honest
     * cost of the policy and the ONE case where aborting is not free. From
     * `tool-input-start` onwards — the long stretch in which the model's whole
     * program streams as tool input, and then executes — nothing is armed.
     */
    const streaming = latch();
    const release = latch();
    const model = mockModel(
      [
        toolStep({
          toolCallId: "call_1",
          code: TRIVIAL,
          narration: ["let me ", "post an update"],
        }),
        textStep({ chunks: ["done, with your correction applied"] }),
      ],
      {
        holdAfterDelta: async (call) => {
          if (call !== 1) return;
          streaming.open();
          await release.wait();
        },
      },
    );
    const harness = await freshLoopRun({ model });

    const opening = await harness.stub.appendTurn(customerTurn("t1"));
    const running = harness.alarm();
    await streaming.wait();

    const steer = await harness.stub.appendTurn(steerTurn("s1", "don't post anything"));
    release.open();
    await running;

    // Cut short by the abort, not by the finalization compare.
    expect(harness.results[0].path).toBe("continuation_requested");
    expect(harness.results[0].detail).toContain("newer input arrived");
    // The step never got to call its tool, so nothing ran and nothing was sent.
    const midCalls = await harness.storage((storage) => listToolCalls(storage));
    expect(midCalls).toHaveLength(0);
    expect((await assistantStates(harness)).at(-1)).toBe("superseded");

    await harness.alarm();

    // Nothing lost: the same generation continued and answered once, with the
    // steer in front of the model before the next provider call.
    const finals = await agentTurns(harness);
    expect(finals).toHaveLength(1);
    expect(finals[0].content).toBe("done, with your correction applied");
    await assertNothingLost(harness, [opening.event.seq, steer.event.seq]);
  });

  it("does NOT cut short a step whose program is already streaming as tool input", async () => {
    /**
     * The other side of the same policy, and what `tool-input-start` buys.
     *
     * The stream here interleaves: text is still open when the tool declares
     * itself and its argument — the model's whole program — begins streaming.
     * That argument is the longest stretch of a tool step and the last place an
     * abort should be on offer, so the arm is withdrawn at `tool-input-start`
     * rather than waiting for `text-end`.
     *
     * What the step then does is row 3's behaviour, reached through the real
     * RPC rather than a session-level append: the step is NOT cut short, it
     * runs to its tool call, and the freshness guard — not the abort — turns
     * that call into a safe `stale_generation` result the next step reads.
     * Both halves matter. The abort must not fire here, and the guard must.
     */
    const streamingInput = latch();
    const release = latch();
    const model = mockModel(
      [
        interleavedToolStep({
          toolCallId: "call_1",
          code: TRIVIAL,
          narration: ["checking that now"],
        }),
        textStep({ chunks: ["checked, and your correction is applied"] }),
      ],
      {
        holdAfterToolInput: async (call) => {
          if (call !== 1) return;
          streamingInput.open();
          await release.wait();
        },
      },
    );
    const harness = await freshLoopRun({ model });

    const opening = await harness.stub.appendTurn(customerTurn("t1"));
    const running = harness.alarm();
    await streamingInput.wait();

    const steer = await harness.stub.appendTurn(steerTurn("s1", "also check billing"));
    release.open();
    await running;

    // NOT aborted: the step ran to its tool call in ONE provider invocation.
    // A `continuation_requested` here would mean the abort had fired.
    expect(harness.results.map((result) => result.path)).toEqual(["completed"]);
    const calls = await harness.storage((storage) => listToolCalls(storage));
    const outer = calls.find((call) => call.name === "run_code");
    // And the guard did its half: a safe refusal, before the isolate loaded.
    expect(outer?.state).toBe("failed");
    expect(outer?.error).toContain("stale_generation");
    expect(calls.filter((call) => call.callId.startsWith("cap:"))).toHaveLength(0);

    // And the steer was absorbed by the NEXT step, not paid for with a
    // discarded one.
    expect(await inputRows(harness)).toEqual([
      { sourceEventSeq: opening.event.seq, globalStep: 0 },
      { sourceEventSeq: steer.event.seq, globalStep: 1 },
    ]);
    expect(await agentTurns(harness)).toHaveLength(1);
    await assertNothingLost(harness, [opening.event.seq, steer.event.seq]);
  });

  it("advances no cursor and appends no phantom message when nothing new arrived", async () => {
    // Step 2's other half. A `prepareStep` with no pending input must be a
    // read: no cursor movement, no empty input row, nothing for the model to
    // read as a turn that never happened.
    const model = mockModel([
      toolStep({ toolCallId: "call_1", code: TRIVIAL }),
      textStep({ chunks: ["answered"] }),
    ]);
    const harness = await freshLoopRun({ model });
    const opening = await harness.stub.appendTurn(customerTurn("t1"));
    await harness.alarm();

    const inputs = await inputRows(harness);
    expect(inputs).toEqual([{ sourceEventSeq: opening.event.seq, globalStep: 0 }]);

    const driver = await harness.storage((storage) => readDriver(storage));
    const generation = await harness.storage((storage) =>
      storage.sql
        .exec<{ included_through_seq: number }>(
          "SELECT included_through_seq FROM agent_generations LIMIT 1",
        )
        .one(),
    );
    expect(generation.included_through_seq).toBe(opening.event.seq);
    expect(driver.settledThroughSeq).toBe(opening.event.seq);
  });
});

/* ------------------------------------ rows 3 and 4: the freshness guard -- */

describe("row 3 — run_code has not started yet", () => {
  it("refuses the outer call with stale_generation before the isolate loads", async () => {
    const model = mockModel([
      toolStep({
        toolCallId: "call_1",
        code: WRITE_ONLY,
        narration: ["let me post an update"],
      }),
      textStep({ chunks: ["I stopped and read the new instruction instead"] }),
    ]);

    let steerSeq = 0;
    const harness = await freshLoopRun({
      model,
      origin: "slack",
      // Committed from inside the object, on the first narration delta: after
      // `prepareStep` has already built the step, and before `run_code` runs.
      //
      // A session-level append is what reaches THIS window without touching
      // the abort registry, and it is the window that matters: from `text-end`
      // or `tool-input-start` onwards — the whole stretch in which the model's
      // program is streamed and then executed — nothing is armed, so a steer
      // arriving through the RPC there leaves durable state identical to this
      // and the refusal below is driven purely by the cursors.
      //
      // An RPC steer landing EARLIER, during the narration deltas themselves,
      // does not reach this case: the abort is still armed there and cuts the
      // step short instead. That path is pinned down by "a steer during
      // pre-tool narration cuts the step short" below.
      midStream: (storage) => {
        steerSeq = appendTurn(storage, steerTurn("s1", "don't post anything yet")).event.seq;
      },
    });

    const opening = await harness.stub.appendTurn(customerTurn("t1"));
    await harness.alarm();

    // A refusal is a RESULT the next step reads, not a crash.
    expect(harness.results.map((result) => result.path)).toEqual(["completed"]);
    const calls = await harness.storage((storage) => listToolCalls(storage));
    const outer = calls.find((call) => call.name === "run_code");
    expect(outer?.state).toBe("failed");
    expect(outer?.error).toContain("stale_generation");

    // Refused BEFORE the isolate loaded: not one capability ran.
    expect(calls.filter((call) => call.callId.startsWith("cap:"))).toHaveLength(0);
    // And nothing was ever reserved in the effect ledger, which is the
    // strongest form of "proven not sent" there is.
    const effects = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM codemode_effects WHERE run_id = ?",
    )
      .bind(harness.runId)
      .first<{ n: number }>();
    expect(effects?.n).toBe(0);

    // The steer reached the next step, exactly once.
    expect(await inputRows(harness)).toEqual([
      { sourceEventSeq: opening.event.seq, globalStep: 0 },
      { sourceEventSeq: steerSeq, globalStep: 1 },
    ]);
    await assertNothingLost(harness, [opening.event.seq, steerSeq]);
  });
});

describe("row 4 — a capability is between calls", () => {
  it("refuses the NEXT capability, after the first one already returned", async () => {
    const model = mockModel([
      toolStep({ toolCallId: "call_1", code: READ_THEN_WRITE }),
      textStep({ chunks: ["I stopped before posting"] }),
    ]);

    let steerSeq = 0;
    let filed = 0;
    const harness = await freshLoopRun({
      model,
      origin: "slack",
      fixtures: { slackThread: [{ ts: "1.0", userId: "U1", text: "hi", permalink: null }] },
      wrapDeps: (base) => ({
        ...base,
        slack: {
          ...base.slack,
          // The steer lands while the isolate is between two capability calls:
          // `slack.thread` has returned and `slack.reply` has not been reached.
          async thread(...args: Parameters<typeof base.slack.thread>) {
            const result = await base.slack.thread(...args);
            const storage = harnessStorage();
            steerSeq = appendTurn(storage, steerTurn("s1", "do NOT post yet")).event.seq;
            return result;
          },
        },
        linear: {
          ...base.linear,
          async createIssue(...args: Parameters<typeof base.linear.createIssue>) {
            filed += 1;
            return base.linear.createIssue(...args);
          },
        },
      }),
    });
    const harnessStorage = (): DurableObjectStorage => {
      const storage = harness.claimed();
      if (!storage) throw new Error("no claimed attempt");
      return storage;
    };

    const opening = await harness.stub.appendTurn(customerTurn("t1"));
    await harness.alarm();

    const calls = await harness.storage((storage) => listToolCalls(storage));
    const caps = calls.filter((call) => call.callId.startsWith("cap:"));
    // The read completed; the write never reached its provider.
    expect(caps.map((call) => `${call.name}:${call.state}`)).toEqual([
      "slack.thread:completed",
      "linear.createIssue:failed",
    ]);
    expect(caps[1].error).toContain("stale_generation");
    expect(filed).toBe(0);
    // Nothing reserved, so no `in_doubt` for a human to clear later.
    const effects = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM codemode_effects WHERE run_id = ?",
    )
      .bind(harness.runId)
      .first<{ n: number }>();
    expect(effects?.n).toBe(0);

    expect(await inputRows(harness)).toEqual([
      { sourceEventSeq: opening.event.seq, globalStep: 0 },
      { sourceEventSeq: steerSeq, globalStep: 1 },
    ]);
    await assertNothingLost(harness, [opening.event.seq, steerSeq]);
  });
});

/* ----------------------------- row 5: an already-started upstream write -- */

describe("row 5 — an upstream write has already started", () => {
  /**
   * THE HONEST LIMIT, tested rather than claimed.
   *
   * The freshness check happens immediately before the capability body, and the
   * body then makes a network call. A steer that commits after that check
   * cannot recall the request — it is already gone. What the run must do is
   * keep the effect visible and hand the NEXT model step both facts: the action
   * that happened, and the instruction that arrived too late to stop it.
   */
  it("keeps the effect in the audit record and gives the next step both facts", async () => {
    const model = mockModel([
      toolStep({ toolCallId: "call_1", code: WRITE_ONLY }),
      textStep({ chunks: ["I already posted; here is what I will do about it"] }),
    ]);

    let steerSeq = 0;
    let sent = 0;
    const harness = await freshLoopRun({
      model,
      origin: "slack",
      wrapDeps: (base) => ({
        ...base,
        linear: {
          ...base.linear,
          async createIssue(...args: Parameters<typeof base.linear.createIssue>) {
            // Past the freshness check, inside the write. The steer commits
            // here; the write completes anyway, because it already left.
            steerSeq = appendTurn(
              harness.claimed() as DurableObjectStorage,
              steerTurn("s1", "wait — don't tell them that"),
            ).event.seq;
            sent += 1;
            return base.linear.createIssue(...args);
          },
        },
      }),
    });

    const opening = await harness.stub.appendTurn(customerTurn("t1"));
    await harness.alarm();

    // It was sent, and it is recorded as sent. The steer did NOT undo it.
    expect(sent).toBe(1);
    const calls = await harness.storage((storage) => listToolCalls(storage));
    const write = calls.find((call) => call.name === "linear.createIssue");
    expect(write?.state).toBe("completed");
    const effect = await env.DB.prepare(
      "SELECT state, method FROM codemode_effects WHERE run_id = ? AND method = 'createIssue'",
    )
      .bind(harness.runId)
      .first<{ state: string; method: string }>();
    expect(effect?.state).toBe("completed");

    // The next step sees BOTH: the tool result for the send, and the steering.
    const transcript = await harness.storage((storage) => readModelTranscript(storage));
    const step1 = transcript.filter((row) => row.globalStep <= 1);
    expect(JSON.stringify(step1)).toContain("run_code");
    expect(await inputRows(harness)).toEqual([
      { sourceEventSeq: opening.event.seq, globalStep: 0 },
      { sourceEventSeq: steerSeq, globalStep: 1 },
    ]);
    await assertNothingLost(harness, [opening.event.seq, steerSeq]);
  });
});

/* ------------------------------------- row 6 / step 5: the late final -- */

describe("row 6 — the final text is already streaming", () => {
  it("supersedes the draft, keeps the generation, and answers once after the steer", async () => {
    const model = mockModel([
      textStep({ chunks: ["the answer to the OLD ", "question"] }),
      textStep({ chunks: ["the corrected answer"] }),
    ]);

    let steerSeq = 0;
    const harness = await freshLoopRun({
      model,
      // The window `finalizeAnswer`'s cursor compare exists for: after the last
      // `prepareStep`, before the finalization transaction. Nothing in memory is
      // consulted here — this is the eviction-proof half of the property.
      midStream: (storage) => {
        steerSeq = appendTurn(
          storage,
          steerTurn("s1", "actually, ignore that — what about billing?"),
        ).event.seq;
      },
    });

    const opening = await harness.stub.appendTurn(customerTurn("t1"));
    const generationBefore = (await harness.storage((storage) => readDriver(storage))).generationId;
    const agentTurnBefore = (await harness.storage((storage) => readDriver(storage))).agentTurnId;

    await harness.alarm();

    // No stale final turn, and the same generation is still open.
    expect(harness.results[0].path).toBe("continuation_requested");
    expect(await agentTurns(harness)).toHaveLength(0);
    const mid = await harness.storage((storage) => readDriver(storage));
    expect(mid.phase).toBe("scheduled");
    expect(mid.generationId).toBe(generationBefore);
    expect(mid.agentTurnId).toBe(agentTurnBefore);
    expect(
      (await harness.storage((storage) => readGeneration(storage, generationBefore as string)))
        ?.settledThroughSeq,
    ).toBeNull();

    // The draft is terminally `superseded`, exactly once, and never `completed`.
    const midStates = await assistantStates(harness);
    expect(midStates.filter((state) => state === "superseded")).toHaveLength(1);
    expect(midStates).not.toContain("completed");

    // ONE scheduled continuation: one generation, one armed alarm, one claim.
    expect(
      await harness.storage((storage) =>
        storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM agent_generations").one().n,
      ),
    ).toBe(1);
    expect(await harness.storage((storage) => storage.getAlarm())).not.toBeNull();

    await harness.alarm();

    // The steer was inserted exactly once, before the next provider call.
    expect(await inputRows(harness)).toEqual([
      { sourceEventSeq: opening.event.seq, globalStep: 0 },
      { sourceEventSeq: steerSeq, globalStep: 1 },
    ]);
    // And the corrected answer is the ONLY final assistant turn.
    const finals = await agentTurns(harness);
    expect(finals).toHaveLength(1);
    expect(finals[0].content).toBe("the corrected answer");
    expect(finals[0].id).toBe(`agent:${generationBefore}:final`);
    expect(harness.results.map((result) => result.path)).toEqual([
      "continuation_requested",
      "completed",
    ]);
    await assertNothingLost(harness, [opening.event.seq, steerSeq]);
  });

  it("cuts the provider call short when a steer arrives mid-text", async () => {
    // The optimization, and the ONLY thing it changes: latency. The durable
    // outcome is the same one the case above reaches with nothing armed.
    const streaming = latch();
    const release = latch();
    const model = mockModel(
      [
        textStep({ chunks: ["I am still explaining ", "the old answer ", "at length"] }),
        textStep({ chunks: ["the corrected answer"] }),
      ],
      {
        holdAfterDelta: async (call) => {
          if (call !== 1) return;
          streaming.open();
          await release.wait();
        },
      },
    );
    const harness = await freshLoopRun({ model });

    const opening = await harness.stub.appendTurn(customerTurn("t1"));
    const running = harness.alarm();
    await streaming.wait();

    const steer = await harness.stub.appendTurn(steerTurn("s1", "stop — check billing instead"));
    release.open();
    await running;

    // The abort path, not the finalization path: the detail says so.
    expect(harness.results[0].path).toBe("continuation_requested");
    expect(harness.results[0].detail).toContain("newer input arrived");
    expect(await agentTurns(harness)).toHaveLength(0);
    expect((await assistantStates(harness)).at(-1)).toBe("superseded");

    await harness.alarm();
    const finals = await agentTurns(harness);
    expect(finals).toHaveLength(1);
    expect(finals[0].content).toBe("the corrected answer");
    await assertNothingLost(harness, [opening.event.seq, steer.event.seq]);
  });

  it("treats an abort with no pending input as a visible cancellation", async () => {
    // The other half of step 4: an operator or user cancelling a run that has
    // nothing new to say is NOT a continuation and must not be retried into
    // another billed provider call.
    const streaming = latch();
    const release = latch();
    const model = mockModel([textStep({ chunks: ["I am still ", "explaining"] })], {
      holdAfterDelta: async () => {
        streaming.open();
        await release.wait();
      },
    });
    const harness = await freshLoopRun({ model });

    await harness.stub.appendTurn(customerTurn("t1"));
    const running = harness.alarm();
    await streaming.wait();

    // Issued from INSIDE the object's own I/O context, exactly as
    // `RunDO.appendTurn` does: an `AbortController` created in one context
    // cannot be touched from another in this runtime.
    const aborted = await harness.storage((storage) => abortForNewerInput(storage));
    expect(aborted).toBe(true);
    release.open();
    await running;

    expect(harness.results[0].path).toBe("run_cancelled");
    expect(await agentTurns(harness)).toHaveLength(0);
    const driver = await harness.storage((storage) => readDriver(storage));
    expect(driver.phase).toBe("failed");
    // A new trusted turn may resume it; no operator config change is required.
    expect(driver.resumePolicy).toBe("requires_input");
  });
});

/* --------------------------------------- row 7 / step 6: the boundary -- */

describe("rows 6 and 7 — the settle/new-input race has exactly two outcomes", () => {
  /**
   * Both legal resolutions of the same race, forced deterministically rather
   * than hoped for: `midStream` commits INSIDE the finalization window, and an
   * ordinary RPC after the alarm commits outside it. The illegal third results
   * — a lost input, two generations for one input, a pending cursor with no
   * alarm — are ruled out by `assertNothingLost` in both.
   */
  it("input wins: the same generation continues", async () => {
    const model = mockModel([
      textStep({ chunks: ["the old answer"] }),
      textStep({ chunks: ["the new answer"] }),
    ]);
    let steerSeq = 0;
    const harness = await freshLoopRun({
      model,
      midStream: (storage) => {
        steerSeq = appendTurn(storage, steerTurn("s1", "one more thing")).event.seq;
      },
    });
    const opening = await harness.stub.appendTurn(customerTurn("t1"));
    const generationId = (await harness.storage((storage) => readDriver(storage))).generationId;

    await harness.alarm();
    await harness.alarm();

    expect(
      await harness.storage((storage) =>
        storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM agent_generations").one().n,
      ),
    ).toBe(1);
    const finals = await agentTurns(harness);
    expect(finals).toHaveLength(1);
    expect(finals[0].id).toBe(`agent:${generationId}:final`);
    await assertNothingLost(harness, [opening.event.seq, steerSeq]);
  });

  it("finalization wins: the final settles and the input allocates ONE new generation", async () => {
    const model = mockModel([
      textStep({ chunks: ["the first answer"] }),
      textStep({ chunks: ["the second answer"] }),
    ]);
    const harness = await freshLoopRun({ model });
    const opening = await harness.stub.appendTurn(customerTurn("t1"));
    await harness.alarm();

    const settled = await harness.storage((storage) => readDriver(storage));
    expect(settled.phase).toBe("idle");
    const firstGeneration = (await agentTurns(harness))[0].id;

    // Row 7: the generation has settled, so this is an ordinary new turn.
    const steer = await harness.stub.appendTurn(steerTurn("s1", "follow-up question"));
    expect(steer.scheduling.outcome).toBe("allocated");
    // Exactly one new generation for exactly one input — never two.
    expect(
      await harness.storage((storage) =>
        storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM agent_generations").one().n,
      ),
    ).toBe(2);
    expect(await harness.storage((storage) => storage.getAlarm())).not.toBeNull();

    await harness.alarm();
    const finals = await agentTurns(harness);
    expect(finals).toHaveLength(2);
    // A later settled input gets its OWN turn id (invariant 8).
    expect(finals[0].id).not.toBe(finals[1].id);
    expect(finals.map((turn) => turn.id)).toContain(firstGeneration);
    await assertNothingLost(harness, [opening.event.seq, steer.event.seq]);
  });
});

/* ---------------------------------------------- step 8: the coalescing -- */

describe("step 8 — ten steers during one answer cost one continuation", () => {
  it("schedules one continuation and delivers all ten in RunEvent order", async () => {
    const streaming = latch();
    const release = latch();
    let providerCalls = 0;
    const model = mockModel(
      [
        textStep({ chunks: ["the answer to the ", "original question"] }),
        textStep({ chunks: ["everything answered"] }),
      ],
      {
        onCall: () => {
          providerCalls += 1;
        },
        holdAfterDelta: async (call) => {
          if (call !== 1) return;
          streaming.open();
          await release.wait();
        },
      },
    );
    const harness = await freshLoopRun({ model });

    const opening = await harness.stub.appendTurn(customerTurn("t1"));
    const running = harness.alarm();
    await streaming.wait();

    const seqs: number[] = [];
    for (let index = 0; index < 10; index += 1) {
      const appended = await harness.stub.appendTurn(steerTurn(`s${index}`, `steer ${index}`));
      // Every one of them joins the SAME generation. Ten generations would be
      // ten answers to one conversation.
      expect(appended.scheduling.outcome).toBe("joined");
      seqs.push(appended.event.seq);
    }
    release.open();
    await running;

    // ONE scheduled continuation, not ten.
    const driver = await harness.storage((storage) => readDriver(storage));
    expect(driver.phase).toBe("scheduled");
    expect(
      await harness.storage((storage) =>
        storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM agent_generations").one().n,
      ),
    ).toBe(1);

    await harness.alarm();

    // THE COST PROPERTY: one interrupted call plus one continuation. Ten
    // provider invocations for ten steers is what this file exists to prevent.
    expect(providerCalls).toBe(2);

    // All ten reached that single continuation, each exactly once, ordered by
    // RunEvent sequence rather than by arrival (invariant 12).
    const inputs = await inputRows(harness);
    expect(inputs.map((row) => row.sourceEventSeq)).toEqual([opening.event.seq, ...seqs]);
    // ONE checkpoint, not ten: all ten were inserted by a single `prepareStep`
    // of the single continuation.
    expect(new Set(inputs.slice(1).map((row) => row.globalStep)).size).toBe(1);
    expect(await agentTurns(harness)).toHaveLength(1);
    await assertNothingLost(harness, [opening.event.seq, ...seqs]);
  });
});
