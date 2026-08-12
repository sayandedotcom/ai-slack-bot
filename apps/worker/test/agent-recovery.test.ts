import { env, evictDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { resetRunPorts } from "../src/agent/driver";
import { runEffect } from "../src/codemode/effects";
import type { CodeModeScope } from "../src/codemode/contracts";
import { ZERO_USAGE } from "../src/agent/usage";
import {
  appendAgentToolCallUpdate,
  appendAssistantUpdate,
  appendInputMessages,
  checkpointStepMessages,
  claimGeneration,
  finalizeGeneration,
  heartbeat,
  readDriver,
  readGeneration,
  readModelTranscript,
  readStepUsage,
  recordStepUsage,
  turnEventSeq,
} from "../src/run/session";
import type { ClaimFence, ClaimSnapshot } from "../src/agent/contracts";
import {
  FakeContinuation,
  FakeProjectionRunner,
  freshDriverRun,
  turn,
} from "./helpers/agent-driver";

/**
 * Crash recovery and the claim fence.
 *
 * The scenario throughout is the one that actually happens in production and
 * cannot be reproduced by a happy-path test: an attempt takes ownership, starts
 * doing external work, and then its object dies — or merely stalls past its
 * lease — while a successor takes over.
 */

afterEach(() => {
  resetRunPorts();
});

describe("constructor recovery", () => {
  it("re-arms scheduled model work without calling the model or a projector", async () => {
    const continuation = new FakeContinuation();
    const projector = new FakeProjectionRunner();
    const h = await freshDriverRun({
      continuation,
      projections: { d1_usage: projector },
    });

    await h.stub.appendTurn(turn("cr-1"));
    // Simulate the object dying after the input committed but before anything
    // ran: drop the alarm, then evict.
    await h.storage((s) => s.deleteAlarm());
    await evictDurableObject(h.stub);

    // Re-entering constructs the object, which runs recovery. The ports are
    // installed in the module registry under this run's key, so they ARE
    // present during construction — the zero call counts below are a real
    // assertion, not an artifact of nothing being wired yet.
    const armed = await h.storage((s) => s.getAlarm());

    expect(armed).not.toBeNull();
    expect(continuation.runs).toBe(0);
    expect(projector.jobs).toHaveLength(0);

    // The re-armed alarm is what actually starts the work.
    await h.reattach();
    const outcome = await h.alarm();
    expect(outcome.model).toBe("claimed");
  });

  it("re-arms an expired running lease so a crashed attempt is reclaimed", async () => {
    const held = new FakeContinuation({ hold: true });
    const h = await freshDriverRun({ continuation: held });
    await h.stub.appendTurn(turn("cr-2"));

    // Claim without ever finalizing: the durable trace a crashed attempt leaves.
    const claim = await h.storage((s) => claimGeneration(s, { now: h.clock.value }));
    expect(claim.outcome).toBe("claimed");
    await h.storage((s) => s.deleteAlarm());
    await evictDurableObject(h.stub);

    const armed = await h.storage((s) => s.getAlarm());
    const driver = await h.storage((s) => readDriver(s));
    expect(driver.phase).toBe("running");
    // Armed for the lease expiry, not for now: the lease is what says when this
    // attempt may be declared dead.
    expect(armed).toBe(driver.leaseExpiresAt);
    expect(held.runs).toBe(0);
  });

  it("leaves an idle object with nothing armed, so it can hibernate", async () => {
    const h = await freshDriverRun();
    await h.stub.appendTurn(turn("cr-3"));
    await h.alarm();
    await h.stub.flushProjections();

    await evictDurableObject(h.stub);
    expect(await h.storage((s) => s.getAlarm())).toBeNull();
  });
});

describe("crash recovery keeps identity", () => {
  it("reclaims the same generation and turn id with an incremented attempt", async () => {
    const held = new FakeContinuation();
    const h = await freshDriverRun({ continuation: held });
    await h.stub.appendTurn(turn("id-1"));

    const first = await h.storage((s) => claimGeneration(s, { now: h.clock.value }));
    if (first.outcome !== "claimed") throw new Error("expected a claim");

    // The attempt dies here: no finalize, no heartbeat, nothing.
    await evictDurableObject(h.stub);
    h.clock.advance(150_001);
    await h.reattach();

    const outcome = await h.alarm();
    expect(outcome.model).toBe("claimed");

    const reclaimed = held.claims[0];
    expect(reclaimed.generationId).toBe(first.claim.generationId);
    expect(reclaimed.agentTurnId).toBe(first.claim.agentTurnId);
    expect(reclaimed.attempt).toBe(first.claim.attempt + 1);
    expect(reclaimed.fence.claimEpoch).toBeGreaterThan(first.claim.fence.claimEpoch);

    const generations = await h.storage(
      (s) => s.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM agent_generations").one().n,
    );
    expect(generations).toBe(1);
  });

  it("replays a Phase 09 effect once across both attempts", async () => {
    const held = new FakeContinuation({ hold: true });
    const h = await freshDriverRun({ continuation: held });
    await h.stub.appendTurn(turn("id-2"));

    const first = await h.storage((s) => claimGeneration(s, { now: h.clock.value }));
    if (first.outcome !== "claimed") throw new Error("expected a claim");

    // The effect scope is the AGENT TURN ID, which is derived from the
    // generation — so a crash retry of the same generation replays into the
    // same ledger row rather than sending a second customer message.
    const scope = (agentTurnId: string): CodeModeScope => ({
      runId: h.runId,
      turnId: agentTurnId,
      origin: "chat",
      shadow: false,
      customerSlug: "acme",
      slackThread: null,
      actor: null,
    });

    let sends = 0;
    const send = (agentTurnId: string) =>
      runEffect(
        { db: env.DB, clock: () => h.clock.value },
        scope(agentTurnId),
        "slack",
        "reply",
        { text: "looking into it" },
        {
          execute: async () => {
            sends += 1;
            return { ts: "1.0", permalink: null };
          },
        },
      );

    const before = await send(first.claim.agentTurnId);
    expect(sends).toBe(1);

    h.clock.advance(150_001);
    const second = await h.storage((s) => claimGeneration(s, { now: h.clock.value }));
    if (second.outcome !== "claimed") throw new Error("expected a reclaim");
    expect(second.claim.agentTurnId).toBe(first.claim.agentTurnId);

    // Same generation, same args, second attempt: the ledger replays the
    // recorded result and upstream is not called again.
    const after = await send(second.claim.agentTurnId);
    expect(after).toEqual(before);
    expect(sends).toBe(1);
  });
});

describe("the epoch fence", () => {
  /**
   * A holds a claim whose lease expires; B takes over; A comes back.
   *
   * Every assertion below is a thing A must NOT be able to do while B owns the
   * run — plus the single deliberate exception, which is money.
   */
  async function barrier() {
    const usageRunner = new FakeProjectionRunner();
    const h = await freshDriverRun({
      continuation: null,
      projections: { d1_usage: usageRunner },
    });
    await h.stub.appendTurn(turn("f-1"));

    const a = await h.storage((s) => claimGeneration(s, { now: h.clock.value }));
    if (a.outcome !== "claimed") throw new Error("expected a claim");

    h.clock.advance(150_001);
    const b = await h.storage((s) => claimGeneration(s, { now: h.clock.value }));
    if (b.outcome !== "claimed") throw new Error("expected a reclaim");

    return { h, usageRunner, a: a.claim, b: b.claim };
  }

  it("refuses every conversational write from the superseded claimant", async () => {
    const { h, a, b } = await barrier();
    const now = h.clock.value;
    const stale: ClaimFence = a.fence;

    const inputSeq = (await h.storage((s) => turnEventSeq(s, "f-1"))) as number;

    const outcomes = await h.storage((s) => ({
      heartbeat: heartbeat(s, stale, { now }).outcome,
      input: appendInputMessages(s, stale, {
        globalStep: 0,
        messages: [{ sourceEventSeq: inputSeq, message: { role: "user", content: "hi" } }],
        now,
      }).outcome,
      checkpoint: checkpointStepMessages(s, stale, {
        globalStep: 0,
        messages: [{ role: "assistant", content: "stale" }],
        now,
      }).outcome,
      assistant: appendAssistantUpdate(
        s,
        stale,
        { generationId: stale.generationId, attempt: a.attempt, batchSeq: 0, state: "streaming", delta: "stale" },
        now,
      ).outcome,
      capability: appendAgentToolCallUpdate(
        s,
        stale,
        { id: `cap:${stale.generationId}:0`, callId: "c-stale", name: "run_code", state: "running" },
        now,
      ).outcome,
      finalize: finalizeGeneration(s, stale, { kind: "completed" }, now).outcome,
    }));

    expect(outcomes).toEqual({
      heartbeat: "stale_claim",
      input: "stale_claim",
      checkpoint: "stale_claim",
      assistant: "stale_claim",
      capability: "stale_claim",
      finalize: "stale_claim",
    });

    // Nothing of A's reached the durable record, and B is still the owner.
    const driver = await h.storage((s) => readDriver(s));
    expect(driver.phase).toBe("running");
    expect(driver.claimEpoch).toBe(b.fence.claimEpoch);
    expect(driver.attempt).toBe(b.attempt);
    expect(await h.storage((s) => readModelTranscript(s))).toHaveLength(0);
    expect((await h.storage((s) => readGeneration(s, b.generationId)))?.state).toBe("running");
  });

  it("does not let a refused finalize disturb the successor's schedule", async () => {
    const { h, a, b } = await barrier();
    const armedBefore = await h.storage((s) => s.getAlarm());

    const refused = await h.storage((s) =>
      finalizeGeneration(
        s,
        a.fence,
        { kind: "retry", errorCode: "stale_boom", retryAfterMs: 60_000 },
        h.clock.value,
      ),
    );
    expect(refused.outcome).toBe("stale_claim");

    const driver = await h.storage((s) => readDriver(s));
    expect(driver.phase).toBe("running");
    expect(driver.nextAttemptAt).toBe(0);
    expect(driver.lastErrorCode).toBeNull();
    expect(driver.leaseExpiresAt).toBe(b.leaseExpiresAt);
    expect(await h.storage((s) => s.getAlarm())).toBe(armedBefore);
  });

  it("still records billed usage from the superseded attempt, exactly once", async () => {
    const { h, usageRunner, a, b } = await barrier();

    const bill = (claim: ClaimSnapshot) =>
      h.storage((s) =>
        recordStepUsage(
          s,
          {
            generationId: claim.generationId,
            agentTurnId: claim.agentTurnId,
            attempt: claim.attempt,
            globalStep: 0,
            provider: "anthropic",
            model: "fable",
            usage: { ...ZERO_USAGE, inputTokens: 100, outputTokens: 20, totalTokens: 120 },
            costNanoUsd: 2_400,
            latencyMs: 900,
          },
          h.clock.value,
        ),
      );

    // A's provider call had already been billed when its lease ran out. The
    // money is spent whether or not the answer was used, and the run spend
    // ceiling is enforced from this ledger.
    const first = await bill(a);
    const replay = await bill(a);
    expect(first.outcome).toBe("recorded");
    expect(replay.outcome).toBe("duplicate");
    expect(replay.id).toBe(first.id);

    const row = await h.storage((s) => readStepUsage(s, first.id));
    expect(row?.attempt).toBe(a.attempt);
    expect(row?.costNanoUsd).toBe(2_400);

    // It is projected like any other billed step...
    let outcome = await h.alarm();
    while (outcome.detail.includes("run_index")) outcome = await h.alarm();
    expect(usageRunner.jobs.map((claimed) => claimed.job.sourceId)).toEqual([first.id]);

    // ...and none of that granted A conversational ownership back.
    const driver = await h.storage((s) => readDriver(s));
    expect(driver.claimEpoch).toBe(b.fence.claimEpoch);
    expect(driver.attempt).toBe(b.attempt);
    expect(await h.storage((s) => readModelTranscript(s))).toHaveLength(0);

    // B's own attempt bills separately, because it was a separate provider call.
    const second = await bill(b);
    expect(second.outcome).toBe("recorded");
    expect(second.id).not.toBe(first.id);
  });
});

describe("the alarm heals a lost projection wakeup", () => {
  it("re-arms for a job the best-effort kick left behind", async () => {
    const h = await freshDriverRun({ continuation: null });
    await h.stub.appendTurn(turn("h-1"));

    // The kick's drain is best effort. Simulate the microtask-ordering lost
    // wakeup directly: a durable pending job with no alarm to deliver it.
    await h.storage((s) => {
      s.sql.exec(
        "UPDATE agent_projection_jobs SET state = 'pending', next_attempt_at = ? WHERE kind = 'run_index'",
        h.clock.value,
      );
      return s.deleteAlarm();
    });

    await evictDurableObject(h.stub);

    // Constructor recovery alone re-arms it: the durable job is the guarantee,
    // never the in-memory drain promise.
    const armed = await h.storage((s) => s.getAlarm());
    expect(armed).not.toBeNull();

    const outcome = await h.alarm();
    expect(outcome.dispatched).toBe("projection");
    expect(outcome.detail).toContain("run_index");
  });
});
