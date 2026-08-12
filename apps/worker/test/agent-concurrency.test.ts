import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { resetRunPorts } from "../src/agent/driver";
import { RunDO } from "../src/run/do";
import {
  listPendingInputTurns,
  readDriver,
  recordStepUsage,
  turnEventSeq,
} from "../src/run/session";
import { ZERO_USAGE } from "../src/agent/usage";
import {
  FakeContinuation,
  FakeProjectionRunner,
  freshDriverRun,
  turn,
  waitFor,
} from "./helpers/agent-driver";

/**
 * Single flight, under every kick that can arrive at once.
 *
 * The barrier is what makes this a real test. With a continuation that returns
 * immediately, "two concurrent kicks" are never concurrent at all — the first
 * has settled before the second is delivered, and a driver with no mutual
 * exclusion whatsoever would pass.
 */

afterEach(() => {
  resetRunPorts();
});

describe("duplicate kicks are single-flight", () => {
  it("starts exactly one continuation and keeps every input pending, in order", async () => {
    const held = new FakeContinuation({ hold: true });
    const h = await freshDriverRun({ continuation: held });

    // Kick 1 and 2: two concurrent first-turn appends. Kick 3: a duplicate
    // delivery of the first. All three race into one input transaction.
    const [first, second, duplicate] = await Promise.all([
      h.stub.appendTurn(turn("k-1")),
      h.stub.appendTurn(turn("k-2", { source: "human_steer", content: "check billing too" })),
      h.stub.appendTurn(turn("k-1")),
    ]);

    // Exactly one of the two new turns allocated the generation; the other
    // joined it. The redelivery appended nothing.
    const outcomes = [first.scheduling.outcome, second.scheduling.outcome].sort();
    expect(outcomes).toEqual(["allocated", "joined"]);
    expect(duplicate.appended).toBe(false);

    const generations = await h.storage(
      (s) => s.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM agent_generations").one().n,
    );
    expect(generations).toBe(1);

    // Kick 4 and 5: two alarm deliveries. The first claims and parks on the
    // barrier; the second must find a live lease, not a second provider stream.
    const running = h.dispatch();
    await waitFor(() => held.runs === 1, "the first attempt to start");
    const redelivered = await h.dispatch();

    expect(redelivered.model).toBe("lease_held");
    expect(held.runs).toBe(1);

    // Kick 6: a constructor recovery attempt, while the attempt is still in
    // flight. Recovery reads local state and re-arms an alarm; it must not
    // start anything.
    await runInDurableObject(h.stub, (instance, state) => {
      const recovered = new RunDO(state, (instance as unknown as { env: never }).env);
      expect(recovered).toBeInstanceOf(RunDO);
    });
    expect(held.runs).toBe(1);

    // And a third input arriving mid-flight is still only ever one attempt.
    await h.stub.appendTurn(turn("k-3", { content: "one more thing" }));
    expect(held.runs).toBe(1);

    const driver = await h.storage((s) => readDriver(s));
    expect(driver.phase).toBe("running");
    expect(driver.attempt).toBe(1);
    expect(driver.claimEpoch).toBe(1);

    // Nothing was dropped, and the order is RunEvent sequence order — never
    // arrival order in some in-memory array (invariants 12 and 13).
    const pending = await h.storage((s) => listPendingInputTurns(s, driver.settledThroughSeq));
    expect(pending.map((t) => t.id)).toEqual(["k-1", "k-2", "k-3"]);

    const lastSeq = await h.storage((s) => turnEventSeq(s, "k-3"));
    expect(driver.pendingThroughSeq).toBe(lastSeq);

    held.release();
    await running;
  });

  it("lets exactly one of two concurrent alarms reclaim an expired lease", async () => {
    const held = new FakeContinuation({ hold: true });
    const h = await freshDriverRun({ continuation: held });
    await h.stub.appendTurn(turn("x-1"));

    const abandoned = h.dispatch();
    await waitFor(() => held.runs === 1, "the first attempt to start");

    // The attempt is still holding, but its lease has run out — the state a
    // crashed claimant leaves behind, seen from a healthy object.
    h.clock.advance(150_001);

    const a = h.dispatch();
    const b = h.dispatch();
    await waitFor(() => held.runs === 2, "the reclaim to start");

    const driver = await h.storage((s) => readDriver(s));
    expect(driver.attempt).toBe(2);
    expect(driver.claimEpoch).toBe(2);
    // Same generation, same effect scope: a reclaim continues the work, it does
    // not fork a second conversation.
    expect(held.claims[1].generationId).toBe(held.claims[0].generationId);

    held.release();
    const [ra, rb] = await Promise.all([a, b]);
    expect([ra.model, rb.model].sort()).toEqual(["claimed", "lease_held"]);
    await abandoned;

    // The abandoned attempt also finished, and reported success — but the fence
    // refused it, so it did not settle a generation it no longer owns.
    const after = await h.storage((s) => readDriver(s));
    expect(after.claimEpoch).toBe(2);
  });
});

describe("a live model lease does not erase projection work", () => {
  it("delivers a due usage projection while the model attempt is in flight", async () => {
    const held = new FakeContinuation({ hold: true });
    const usageRunner = new FakeProjectionRunner();
    const h = await freshDriverRun({
      continuation: held,
      projections: { d1_usage: usageRunner },
    });

    await h.stub.appendTurn(turn("j-1"));
    const running = h.dispatch();
    await waitFor(() => held.runs === 1, "the attempt to start");

    // A billed step lands, which enqueues its own durable projection job.
    const claim = held.claims[0];
    await h.storage((s) =>
      recordStepUsage(s, {
        generationId: claim.generationId,
        agentTurnId: claim.agentTurnId,
        attempt: claim.attempt,
        globalStep: 0,
        provider: "anthropic",
        model: "fable",
        usage: ZERO_USAGE,
        costNanoUsd: 1_500,
        latencyMs: 10,
      }),
    );

    // The model lease is live, so this delivery cannot claim model work — and
    // it must not therefore do nothing. A vendor outage on one side must not
    // stop the other.
    let delivered = await h.dispatch();
    while (delivered.detail.includes("run_index")) delivered = await h.dispatch();

    expect(delivered.model).toBe("lease_held");
    expect(delivered.dispatched).toBe("projection");
    expect(usageRunner.jobs).toHaveLength(1);
    expect(usageRunner.jobs[0].job.kind).toBe("d1_usage");
    expect(usageRunner.jobs[0].runId).toBe(h.runId);

    held.release();
    await running;
  });

  it("re-arms for a failed projection's backoff instead of losing it", async () => {
    const usageRunner = new FakeProjectionRunner();
    usageRunner.fails = new Error("d1 is unreachable");
    const h = await freshDriverRun({ projections: { d1_usage: usageRunner } });

    await h.stub.appendTurn(turn("b-1"));
    await h.alarm();

    await h.storage((s) =>
      recordStepUsage(s, {
        generationId: "gen:orphan",
        agentTurnId: "agent:gen:orphan",
        attempt: 1,
        globalStep: 0,
        provider: "anthropic",
        model: "fable",
        usage: ZERO_USAGE,
        costNanoUsd: 10,
        latencyMs: 1,
      }),
    );

    let outcome = await h.alarm();
    while (outcome.detail.includes("run_index")) outcome = await h.alarm();

    expect(usageRunner.jobs).toHaveLength(1);
    expect(outcome.dispatched).toBe("projection");
    // The job is not lost and not retried instantly: the alarm is armed for its
    // backoff, which is what makes an outage cheap instead of a hot loop.
    expect(outcome.nextAlarmAt).toBeGreaterThan(h.clock.value);

    const job = await h.storage(
      (s) =>
        s.sql
          .exec<{ state: string; attempts: number; last_error: string | null }>(
            "SELECT state, attempts, last_error FROM agent_projection_jobs WHERE kind = 'd1_usage'",
          )
          .toArray()[0],
    );
    expect(job.state).toBe("pending");
    expect(job.attempts).toBe(1);
    expect(job.last_error).toBe("d1 is unreachable");
  });
});
