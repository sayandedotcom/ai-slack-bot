import { afterEach, describe, expect, it } from "vitest";
import { resetRunPorts } from "../src/agent/driver";
import type { CodeModeScope } from "../src/codemode/contracts";
import { agentGraphIdFor } from "../src/memory/graphs";
import {
  listEvents,
  listPendingUsageProjections,
  listToolCalls,
  listTurns,
  readDriver,
  readGeneration,
  readGenerationMemory,
  readModelTranscript,
} from "../src/run/session";
import {
  customerTurn,
  freshLoopRun,
  latch,
  mockModel,
  textStep,
  toolStep,
} from "./helpers/agent-loop";

/**
 * Two properties that are only ever violated at a boundary:
 *
 *  - **Step 4 — two runs answering at once share nothing.** Module-scope state
 *    is the classic way a Durable Object loop leaks one customer's evidence into
 *    another's answer, and it cannot be caught by a suite that only ever runs
 *    one generation at a time. Both provider calls are held open here and
 *    released together, so every callback of one run interleaves with the
 *    other's.
 *  - **Step 5 — replay changes nothing.** Alarms are at-least-once, sockets
 *    reconnect from arbitrary cursors, and a redelivered finalization must not
 *    produce a second answer, a second usage row or a second outbox row.
 *
 * As everywhere else in these suites, the provider is a `MockLanguageModelV4`
 * driving the real `streamText()` loop through `makeAgentContinuation`, and the
 * capability layer runs the real isolate against fake vendor ports.
 */

afterEach(() => {
  resetRunPorts();
});

/**
 * A search: a Slack-scoped read, and the capability whose returned message ids
 * become provenance. Only a run with a resolved customer may run it.
 */
const SEARCH = 'async () => slack.searchMessages({ query: "exports" })';
/** A log read: available on either surface, and it registers no provenance. */
const READ_LOGS =
  'async () => betterstack.logs({ query: "checkout", since: "2026-08-13T00:00:00Z", limit: 5 })';

/* ------------------------------------------------- two independent runs -- */

describe("two runs answering at the same time share nothing", () => {
  it("interleaves every callback and keeps transcript, scope, ids and money apart", async () => {
    const aStarted = latch();
    const bStarted = latch();
    const aGate = latch();
    const bGate = latch();

    // Recorded from inside each run's own capability composition, so the scope
    // asserted below is the one the isolate actually received.
    const scopes = new Map<string, CodeModeScope[]>();
    const record = (label: string) => (base: never, scope: CodeModeScope) => {
      scopes.set(label, [...(scopes.get(label) ?? []), scope]);
      return base;
    };

    const slackRun = await freshLoopRun({
      origin: "slack",
      fixtures: {
        slackSearch: [
          { ts: "1.0", userId: "U1", text: "exports are empty", permalink: null, eventId: "ev_1" },
        ],
      },
      wrapDeps: record("slack") as never,
      model: mockModel(
        [
          toolStep({ toolCallId: "call_slack", code: SEARCH }),
          textStep({ chunks: ["SLACK: the export worker was dropped at 04:12."] }),
        ],
        {
          hold: async (call) => {
            if (call !== 1) return;
            aStarted.open();
            await aGate.wait();
          },
        },
      ),
    });

    const chatRun = await freshLoopRun({
      origin: "chat",
      fixtures: {
        logLines: [{ at: "2026-08-13T04:12:00Z", level: "error", message: "checkout timeouts" }],
      },
      wrapDeps: record("chat") as never,
      model: mockModel(
        [
          toolStep({ toolCallId: "call_chat", code: READ_LOGS }),
          textStep({ chunks: ["CHAT: checkout timed out for three minutes."] }),
        ],
        {
          hold: async (call) => {
            if (call !== 1) return;
            bStarted.open();
            await bGate.wait();
          },
        },
      ),
    });

    await slackRun.stub.appendTurn(customerTurn("s1", "why are the exports empty"));
    await chatRun.stub.appendTurn(customerTurn("c1", "why did checkout time out"));

    // Both provider calls are in flight before either is allowed to produce a
    // part. From here on the two loops' callbacks interleave for real.
    const slackDone = slackRun.alarm();
    await aStarted.wait();
    const chatDone = chatRun.alarm();
    await bStarted.wait();
    aGate.open();
    bGate.open();
    await Promise.all([slackDone, chatDone]);

    expect(slackRun.results.at(-1)?.path).toBe("completed");
    expect(chatRun.results.at(-1)?.path).toBe("completed");

    /* --- transcript and assistant buffer ---------------------------------- */

    const slackTranscript = JSON.stringify(
      await slackRun.storage((storage) => readModelTranscript(storage)),
    );
    const chatTranscript = JSON.stringify(
      await chatRun.storage((storage) => readModelTranscript(storage)),
    );
    expect(slackTranscript).toContain("SLACK:");
    expect(slackTranscript).not.toContain("CHAT:");
    expect(chatTranscript).toContain("CHAT:");
    expect(chatTranscript).not.toContain("SLACK:");
    // Neither run's evidence reached the other's model history.
    expect(slackTranscript).not.toContain("checkout timeouts");
    expect(chatTranscript).not.toContain("exports are empty");
    // The message ids provenance is built from never reach the model either.
    expect(slackTranscript).not.toContain("ev_1");

    const slackAnswer = (await slackRun.storage((storage) => listTurns(storage))).filter(
      (turn) => turn.source === "agent",
    );
    const chatAnswer = (await chatRun.storage((storage) => listTurns(storage))).filter(
      (turn) => turn.source === "agent",
    );
    expect(slackAnswer).toHaveLength(1);
    expect(chatAnswer).toHaveLength(1);
    expect(slackAnswer[0]!.content).toContain("SLACK:");
    expect(chatAnswer[0]!.content).toContain("CHAT:");
    // Origin still decides presentation, under interleaving as much as alone.
    expect(slackAnswer[0]!.metadata?.delivery).toBe("internal_narration");
    expect(chatAnswer[0]!.metadata?.delivery).toBe("visible");

    /* --- customer, scope, actor -------------------------------------------- */

    const slackScopes = scopes.get("slack") ?? [];
    const chatScopes = scopes.get("chat") ?? [];
    expect(slackScopes.length).toBeGreaterThan(0);
    expect(chatScopes.length).toBeGreaterThan(0);
    for (const scope of slackScopes) {
      expect(scope.origin).toBe("slack");
      expect(scope.customerSlug).toBe("acme");
      expect(scope.runId).toBe(slackRun.runId);
      // Phase 10 resolves no actor on either surface.
      expect(scope.actor).toBeNull();
    }
    for (const scope of chatScopes) {
      expect(scope.origin).toBe("chat");
      // A Chat run has no ambient customer and no Slack thread to reply into.
      expect(scope.customerSlug).toBeNull();
      expect(scope.slackThread).toBeNull();
      expect(scope.runId).toBe(chatRun.runId);
    }

    /* --- pending cursor and generation identity ---------------------------- */

    const slackDriver = await slackRun.storage((storage) => readDriver(storage));
    const chatDriver = await chatRun.storage((storage) => readDriver(storage));
    expect(slackDriver.phase).toBe("idle");
    expect(chatDriver.phase).toBe("idle");
    // Each object settled its OWN cursor. A shared cursor would have let one
    // run's settle mark the other's input consumed.
    expect(slackDriver.settledThroughSeq).toBe(slackDriver.pendingThroughSeq);
    expect(chatDriver.settledThroughSeq).toBe(chatDriver.pendingThroughSeq);

    const slackGenerationId = generationOf(slackRun.results.at(-1)?.finalTurnId);
    const chatGenerationId = generationOf(chatRun.results.at(-1)?.finalTurnId);
    expect(slackGenerationId).not.toBe(chatGenerationId);

    /* --- tool event ids and the Code Mode call counter --------------------- */

    const slackIds = await toolUpdateIds(slackRun);
    const chatIds = await toolUpdateIds(chatRun);
    expect(slackIds.length).toBeGreaterThan(0);
    expect(chatIds.length).toBeGreaterThan(0);
    expect(slackIds.filter((id) => chatIds.includes(id))).toHaveLength(0);
    // Every id is namespaced by its own generation, which is what makes the
    // disjointness above a property rather than a coincidence of ordering.
    expect(slackIds.every((id) => id.includes(slackGenerationId!))).toBe(true);
    expect(chatIds.every((id) => id.includes(chatGenerationId!))).toBe(true);

    // Each execution counted only its own capability calls: one apiece, from a
    // counter that is per-execution and not a module singleton.
    expect(await outerCallMetrics(slackRun)).toEqual([1]);
    expect(await outerCallMetrics(chatRun)).toEqual([1]);

    /* --- usage and cost rows ----------------------------------------------- */

    const slackUsage = await slackRun.storage((storage) =>
      listPendingUsageProjections(storage, 50),
    );
    const chatUsage = await chatRun.storage((storage) => listPendingUsageProjections(storage, 50));
    expect(slackUsage).toHaveLength(2);
    expect(chatUsage).toHaveLength(2);
    expect(slackUsage.every((row) => row.generationId === slackGenerationId)).toBe(true);
    expect(chatUsage.every((row) => row.generationId === chatGenerationId)).toBe(true);
    // Neither generation was charged for the other's steps.
    const slackGeneration = await slackRun.storage((storage) =>
      readGeneration(storage, slackGenerationId!),
    );
    const chatGeneration = await chatRun.storage((storage) =>
      readGeneration(storage, chatGenerationId!),
    );
    expect(slackGeneration?.costNanoUsd).toBe(
      slackUsage.reduce((total, row) => total + row.costNanoUsd, 0),
    );
    expect(chatGeneration?.costNanoUsd).toBe(
      chatUsage.reduce((total, row) => total + row.costNanoUsd, 0),
    );

    /* --- memory graph and source mapping ------------------------------------ */

    const slackMemory = await slackRun.storage((storage) =>
      readGenerationMemory(storage, slackGenerationId!),
    );
    const chatMemory = await chatRun.storage((storage) =>
      readGenerationMemory(storage, chatGenerationId!),
    );
    const slackEpisode = JSON.parse(slackMemory!.episodeJson) as {
      run_id: string;
      asked: string;
      actions: string[];
    };
    const chatEpisode = JSON.parse(chatMemory!.episodeJson) as {
      run_id: string;
      asked: string;
      actions: string[];
    };

    // Each frozen episode belongs to its own run and remembers only its own
    // question and its own actions.
    expect(slackEpisode.run_id).toBe(slackRun.runId);
    expect(chatEpisode.run_id).toBe(chatRun.runId);
    expect(slackEpisode.asked).toContain("exports");
    expect(chatEpisode.asked).toContain("checkout");
    expect(slackEpisode.actions).toContain("slack.searchMessages");
    expect(slackEpisode.actions).not.toContain("betterstack.logs");
    expect(chatEpisode.actions).toContain("betterstack.logs");
    expect(chatEpisode.actions).not.toContain("slack.searchMessages");

    // And the two graphs they will be projected into are different: a customer
    // Slack run goes to its customer graph, Chat to org.
    expect(
      agentGraphIdFor({
        origin: "slack",
        policy: {
          channel_id: "C1",
          name: "chan",
          customer_slug: "acme",
          mode: "live",
          known: true,
        },
      }),
    ).not.toBe(agentGraphIdFor({ origin: "chat", policy: null }));

    // Provenance: the Slack run is the only one that searched, so it is the only
    // one whose source mapping may name the returned message event.
    expect(slackMemory!.sourceJson).toContain("ev_1");
    expect(chatMemory!.sourceJson).not.toContain("ev_1");
  });

  it("does not let a steer aimed at one run cut the other's stream short", async () => {
    const aStreaming = latch();
    const bStreaming = latch();
    const aGate = latch();
    const bGate = latch();

    // Two runs, both streaming visible text, so BOTH have an abort controller
    // armed at the same moment. A shared registry entry would mean the steer
    // below aborts whichever call is currently registered rather than its own.
    const steered = await freshLoopRun({
      model: mockModel([textStep({ chunks: ["A: first", " second", " third"] })], {
        holdAfterDelta: async () => {
          aStreaming.open();
          await aGate.wait();
        },
      }),
    });
    const untouched = await freshLoopRun({
      model: mockModel([textStep({ chunks: ["B: an answer that must survive."] })], {
        holdAfterDelta: async () => {
          bStreaming.open();
          await bGate.wait();
        },
      }),
    });

    await steered.stub.appendTurn(customerTurn("a1"));
    await untouched.stub.appendTurn(customerTurn("b1"));
    const steeredDone = steered.alarm();
    await aStreaming.wait();
    const untouchedDone = untouched.alarm();
    await bStreaming.wait();

    // The steer lands on run A only, while both are armed.
    await steered.stub.appendTurn({
      id: "a2",
      role: "user",
      source: "human_steer",
      content: "actually check the queue instead",
    });
    aGate.open();
    bGate.open();
    await Promise.all([steeredDone, untouchedDone]);

    // A was superseded and continues; B answered, untouched.
    expect(steered.results.at(-1)?.path).toBe("continuation_requested");
    expect(untouched.results.at(-1)?.path).toBe("completed");
    const answer = (await untouched.storage((storage) => listTurns(storage))).find(
      (turn) => turn.source === "agent",
    );
    expect(answer?.content).toBe("B: an answer that must survive.");
  });
});

function generationOf(finalTurnId: string | undefined): string | null {
  if (finalTurnId === undefined) return null;
  return finalTurnId.replace(/^agent:/, "").replace(/:final$/, "");
}

/** Every replayable tool-update id this run wrote, in stream order. */
async function toolUpdateIds(
  harness: Awaited<ReturnType<typeof freshLoopRun>>,
): Promise<string[]> {
  const events = await harness.storage((storage) => listEvents(storage, 0, 500));
  return events.flatMap((event) => (event.type === "tool_call" ? [event.update.id] : []));
}

/** The capability-call count each outer `run_code` execution reported. */
async function outerCallMetrics(
  harness: Awaited<ReturnType<typeof freshLoopRun>>,
): Promise<number[]> {
  const calls = await harness.storage((storage) => listToolCalls(storage));
  return calls.flatMap((call) => {
    const output = call.output as { capabilityCalls?: number } | null | undefined;
    return typeof output?.capabilityCalls === "number" ? [output.capabilityCalls] : [];
  });
}

/* --------------------------------------------------- replay idempotency -- */

describe("replay changes nothing", () => {
  it("survives a duplicated alarm before, during and after the answer", async () => {
    const model = mockModel([
      toolStep({ toolCallId: "call_1", code: SEARCH }),
      textStep({ chunks: ["the checkout worker restarted at 04:20."] }),
    ]);
    const harness = await freshLoopRun({
      model,
      fixtures: { slackSearch: [] },
    });
    await harness.stub.appendTurn(customerTurn("t1"));

    // Three deliveries of the same alarm. Only the first can claim; the rest
    // find a settled generation or a live lease and dispatch projections.
    await harness.alarm();
    await harness.alarm();
    await harness.alarm();

    const turns = await harness.storage((storage) => listTurns(storage));
    expect(turns.filter((turn) => turn.source === "agent")).toHaveLength(1);

    const usage = await harness.storage((storage) => listPendingUsageProjections(storage, 50));
    // One row per logical step, not per delivery.
    expect(new Set(usage.map((row) => row.globalStep)).size).toBe(usage.length);

    const outbox = await harness.storage((storage) =>
      storage.sql
        .exec<{ n: number }>(
          "SELECT COUNT(*) AS n FROM agent_projection_jobs WHERE kind = 'memory_outbox'",
        )
        .one().n,
    );
    expect(outbox).toBe(1);

    // Replaying the input itself is equally inert.
    const replayed = await harness.stub.appendTurn(customerTurn("t1"));
    expect(replayed.appended).toBe(false);
  });

  it("reconnects from every cursor with no gap and no duplicate", async () => {
    const model = mockModel([textStep({ chunks: Array.from({ length: 40 }, () => "x".repeat(64)) })]);
    const harness = await freshLoopRun({ model, flush: { chars: 128 } });
    await harness.stub.appendTurn(customerTurn("t1"));
    await harness.alarm();

    const all = await harness.storage((storage) => listEvents(storage, 0, 500));
    expect(all.length).toBeGreaterThan(4);
    const sequence = all.map((event) => event.seq);
    // Strictly increasing, with nothing repeated: the ordering a client resumes
    // against.
    expect(sequence).toEqual([...sequence].sort((left, right) => left - right));
    expect(new Set(sequence).size).toBe(sequence.length);

    // Resume from EVERY cursor, not one. Each resume must return exactly the
    // suffix after it — no gap, no repeat, no reordering.
    for (const cursor of [0, ...sequence]) {
      const resumed = await harness.storage((storage) => listEvents(storage, cursor, 500));
      expect(resumed.map((event) => event.seq)).toEqual(sequence.filter((seq) => seq > cursor));
    }

    // And the batch stream itself is complete: concatenating the streaming
    // deltas plus the final turn's own text loses nothing.
    const streamed = all
      .flatMap((event) =>
        event.type === "assistant_update" && event.update.state === "streaming"
          ? [event.update.delta ?? ""]
          : [],
      )
      .join("");
    const answer = (await harness.storage((storage) => listTurns(storage))).find(
      (turn) => turn.source === "agent",
    );
    expect(answer?.content).toBe(streamed);
  });

  it("is idempotent when the same input is appended from both surfaces", async () => {
    const model = mockModel([textStep({ chunks: ["one answer only."] })]);
    const harness = await freshLoopRun({ model });

    const first = await harness.stub.appendTurn(customerTurn("dupe"));
    const second = await harness.stub.appendTurn(customerTurn("dupe"));
    expect(first.appended).toBe(true);
    expect(second.appended).toBe(false);

    await harness.alarm();

    const generations = await harness.storage(
      (storage) =>
        storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM agent_generations").one().n,
    );
    expect(generations).toBe(1);
    const turns = await harness.storage((storage) => listTurns(storage));
    expect(turns.filter((turn) => turn.source === "agent")).toHaveLength(1);
    expect(turns.filter((turn) => turn.id === "dupe")).toHaveLength(1);
  });
});
