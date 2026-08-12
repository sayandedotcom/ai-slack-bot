import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { nextAlarmAt, resetRunPorts, toFinalizeRequest } from "../src/agent/driver";
import {
  CLAIM_LEASE_MS,
  CONTINUATION_TOTAL_MS,
  DRIVER_MAX_ATTEMPTS,
  driverRetryBackoffMs,
  ALARM_WALL_CEILING_MS,
} from "../src/agent/limits";
import { claimGeneration, listEvents, readDriver, readGeneration } from "../src/run/session";
import { freshDriverRun, FakeContinuation, turn, waitFor } from "./helpers/agent-driver";
import type { DriverState } from "../src/agent/contracts";

/**
 * The alarm-driven driver, proved against a fake continuation.
 *
 * Nothing here imports `ai`, touches Anthropic or knows what a token is. That
 * is the point of Task 3: if durable scheduling can only be tested through a
 * provider, then every scheduling bug arrives dressed as a model bug.
 *
 * Storage and module state are shared across cases AND files in this pool, so
 * every case mints its own run and installs its ports under that run's key.
 */

afterEach(() => {
  // Background alarms really do fire in this pool. Clearing the registry means
  // a late delivery for a finished case finds no continuation and parks,
  // instead of claiming a generation while another case is asserting on it.
  resetRunPorts();
});

const driverAt = (overrides: Partial<DriverState> = {}): DriverState => ({
  phase: "idle",
  pendingThroughSeq: 0,
  settledThroughSeq: 0,
  generationId: null,
  agentTurnId: null,
  attempt: 0,
  retryCount: 0,
  claimEpoch: 0,
  leaseExpiresAt: null,
  lastHeartbeatAt: null,
  nextAttemptAt: 0,
  resumePolicy: null,
  lastErrorCode: null,
  lastErrorMessage: null,
  updatedAt: 0,
  ...overrides,
});

describe("one alarm slot, four kinds of work", () => {
  const NOW = 1_000_000;

  it("arms for the earliest due item across model and projection work", () => {
    const at = nextAlarmAt({
      driver: driverAt({ phase: "running", leaseExpiresAt: NOW + 150_000 }),
      projectionDueAt: NOW + 15_000,
      modelEnabled: true,
      now: NOW,
    });
    // The projection is sooner, so it owns the slot. Priority between the two
    // is decided at dispatch, never by leaving one of them unscheduled.
    expect(at).toBe(NOW + 15_000);
  });

  it("does not let a backed-off projection delay fresh conversational input", () => {
    const at = nextAlarmAt({
      driver: driverAt({ phase: "scheduled", nextAttemptAt: 0 }),
      // A vendor outage has walked this out to five minutes.
      projectionDueAt: NOW + 300_000,
      modelEnabled: true,
      now: NOW,
    });
    expect(at).toBe(NOW);
  });

  it("respects a driver retry backoff without dropping the wake", () => {
    const at = nextAlarmAt({
      driver: driverAt({ phase: "scheduled", nextAttemptAt: NOW + 4_000 }),
      projectionDueAt: null,
      modelEnabled: true,
      now: NOW,
    });
    expect(at).toBe(NOW + 4_000);
  });

  it("arms a live lease for its expiry, so a crashed attempt is reclaimed", () => {
    const at = nextAlarmAt({
      driver: driverAt({ phase: "running", leaseExpiresAt: NOW + 150_000 }),
      projectionDueAt: null,
      modelEnabled: true,
      now: NOW,
    });
    expect(at).toBe(NOW + 150_000);
  });

  it("parks model work when no continuation is wired", () => {
    const at = nextAlarmAt({
      driver: driverAt({ phase: "scheduled" }),
      projectionDueAt: null,
      modelEnabled: false,
      now: NOW,
    });
    expect(at).toBeNull();
  });

  it("returns null when nothing is due, so an idle object can hibernate", () => {
    expect(
      nextAlarmAt({ driver: driverAt(), projectionDueAt: null, modelEnabled: true, now: NOW }),
    ).toBeNull();
  });

  it("never arms in the past", () => {
    expect(
      nextAlarmAt({
        driver: driverAt(),
        projectionDueAt: NOW - 60_000,
        modelEnabled: true,
        now: NOW,
      }),
    ).toBe(NOW);
  });
});

describe("appendTurn schedules the wake", () => {
  it("allocates a generation, goes live and arms the alarm immediately", async () => {
    const h = await freshDriverRun();
    const result = await h.stub.appendTurn(turn("d-1"));

    expect(result.scheduling.outcome).toBe("allocated");
    expect((await h.stub.state())?.status).toBe("live");
    expect(await h.alarmAt()).toBe(h.clock.value);
  });

  it("does not wake the loop for the agent's own output", async () => {
    const h = await freshDriverRun();
    const result = await h.stub.appendTurn(
      turn("d-agent", { role: "assistant", source: "agent", content: "on it" }),
    );

    expect(result.scheduling.outcome).toBe("not_input");
    expect((await h.storage((s) => readDriver(s))).phase).toBe("idle");
    expect((await h.stub.state())?.status).toBe("idle");
  });

  it("re-arms on an idempotent duplicate, healing a lost post-commit schedule", async () => {
    const h = await freshDriverRun();
    await h.stub.appendTurn(turn("d-2"));

    // Exactly the failure the plan's step 8 is written for: the first attempt
    // committed the turn and died before its alarm was durable.
    await h.storage((s) => s.deleteAlarm());
    expect(await h.alarmAt()).toBeNull();

    const replay = await h.stub.appendTurn(turn("d-2"));
    expect(replay.appended).toBe(false);
    expect(replay.scheduling.outcome).toBe("duplicate");
    expect(await h.alarmAt()).not.toBeNull();

    // And the healed alarm still starts the work.
    const outcome = await h.alarm();
    expect(outcome.dispatched).toBe("model");
    expect(h.continuation!.runs).toBe(1);
  });
});

describe("alarm dispatch", () => {
  it("claims, runs the continuation and settles the generation", async () => {
    const h = await freshDriverRun();
    await h.stub.appendTurn(turn("d-3"));

    const outcome = await h.alarm();
    expect(outcome.dispatched).toBe("model");
    expect(outcome.detail).toContain("completed -> settled");

    const driver = await h.storage((s) => readDriver(s));
    expect(driver.phase).toBe("idle");
    expect(driver.settledThroughSeq).toBe(driver.pendingThroughSeq);
    // Nothing left to do: the object may hibernate once the index is delivered.
    await h.stub.flushProjections();
    expect(await h.alarm()).toMatchObject({ dispatched: "none" });
  });

  it("hands the continuation a deadline below the platform ceiling", async () => {
    const h = await freshDriverRun();
    await h.stub.appendTurn(turn("d-4"));
    await h.alarm();

    const claim = h.continuation!.claims[0];
    expect(claim.deadlineAt - h.clock.value).toBe(CONTINUATION_TOTAL_MS);
    expect(CONTINUATION_TOTAL_MS).toBeLessThan(ALARM_WALL_CEILING_MS);
    // The claim is a complete immutable snapshot: everything the attempt needs,
    // captured before the first await.
    expect(claim).toMatchObject({
      runId: h.runId,
      attempt: 1,
      agentTurnId: `agent:${claim.generationId}`,
    });
    expect(claim.fence.claimEpoch).toBe(1);
  });

  it("parks model work when no continuation is wired, without losing the input", async () => {
    const h = await freshDriverRun({ continuation: null });
    await h.stub.appendTurn(turn("d-5"));

    const outcome = await h.alarm();
    expect(outcome.model).toBe("parked");
    expect(outcome.dispatched).not.toBe("model");

    const driver = await h.storage((s) => readDriver(s));
    expect(driver.phase).toBe("scheduled");
    expect(driver.pendingThroughSeq).toBeGreaterThan(driver.settledThroughSeq);
  });

  it("refuses a second stream under a live lease but still delivers projections", async () => {
    const held = new FakeContinuation({ hold: true });
    const h = await freshDriverRun({ continuation: held });
    await h.stub.appendTurn(turn("d-6"));

    const first = h.alarm();
    await waitFor(() => held.runs === 1, "the first attempt to start");

    // A duplicate delivery arrives while the first attempt holds the lease.
    const second = await h.dispatch();
    expect(second.model).toBe("lease_held");
    expect(second.dispatched).not.toBe("model");
    expect(held.runs).toBe(1);
    // The lease blocked a second provider stream; it did NOT erase the index
    // work, and the re-arm covers the lease expiry.
    expect(second.nextAlarmAt).not.toBeNull();

    held.release();
    await first;
  });
});

describe("public status semantics", () => {
  it("is live while scheduled or running, and idle once settled", async () => {
    const held = new FakeContinuation({ hold: true });
    const h = await freshDriverRun({ continuation: held });

    await h.stub.appendTurn(turn("s-1"));
    expect((await h.stub.state())?.status).toBe("live");

    const running = h.alarm();
    await waitFor(() => held.runs === 1, "the attempt to start");
    expect((await h.stub.state())?.status).toBe("live");

    held.release();
    await running;
    expect((await h.stub.state())?.status).toBe("idle");

    // The D1 projection follows the same value; the dashboard must not keep
    // showing a settled run as live.
    await h.stub.flushProjections();
    const row = await env.DB.prepare("SELECT status FROM runs WHERE id = ?")
      .bind(h.runId)
      .first<{ status: string }>();
    expect(row?.status).toBe("idle");
  });

  it("becomes failed on a terminal refusal, budget or infrastructure outcome", async () => {
    for (const state of ["failed", "refused", "budget_exhausted"] as const) {
      const continuation = new FakeContinuation().returns({
        outcome: "failed",
        state,
        resumePolicy: "requires_input",
        errorCode: `${state}_code`,
      });
      const h = await freshDriverRun({ continuation });
      await h.stub.appendTurn(turn(`s-${state}`));
      await h.alarm();

      expect((await h.stub.state())?.status).toBe("failed");
      const driver = await h.storage((s) => readDriver(s));
      expect(driver.phase).toBe("failed");
      expect(driver.lastErrorCode).toBe(`${state}_code`);
      expect((await h.storage((s) => readGeneration(s, driver.generationId!)))?.state).toBe(state);
    }
  });

  it("never sets done and never sets awaiting_approval by itself", async () => {
    const h = await freshDriverRun();
    await h.stub.appendTurn(turn("s-2"));
    await h.alarm();
    await h.stub.appendTurn(turn("s-3"));
    await h.alarm();

    const statuses = (await h.storage((s) => listEvents(s, 0, 500)))
      .filter((event) => event.type === "status")
      .map((event) => (event.type === "status" ? event.status : ""));

    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses).not.toContain("done");
    expect(statuses).not.toContain("awaiting_approval");
  });
});

describe("failure-resume policy is a safety gate", () => {
  async function failWith(policy: "requires_input" | "requires_operator_config" | "requires_reconciliation") {
    const continuation = new FakeContinuation().returns({
      outcome: "failed",
      state: policy === "requires_operator_config" ? "budget_exhausted" : "failed",
      resumePolicy: policy,
      errorCode: policy,
    });
    const h = await freshDriverRun({ continuation });
    await h.stub.appendTurn(turn(`p-${policy}-1`));
    await h.alarm();
    expect((await h.stub.state())?.status).toBe("failed");
    return h;
  }

  it("lets an ordinary message resume requires_input", async () => {
    const h = await failWith("requires_input");
    const resumed = await h.stub.appendTurn(turn("p-requires_input-2"));

    expect(resumed.scheduling.outcome).toBe("allocated");
    expect((await h.stub.state())?.status).toBe("live");
    expect((await h.storage((s) => readDriver(s))).phase).toBe("scheduled");
  });

  it("does not let an ordinary message bypass a run spend ceiling", async () => {
    const h = await failWith("requires_operator_config");
    const blocked = await h.stub.appendTurn(turn("p-requires_operator_config-2"));

    expect(blocked.scheduling).toMatchObject({
      outcome: "blocked",
      policy: "requires_operator_config",
    });
    // Public state stays failed until a legal resume action, and the input is
    // still recorded above the settled watermark rather than dropped.
    expect((await h.stub.state())?.status).toBe("failed");
    const driver = await h.storage((s) => readDriver(s));
    expect(driver.phase).toBe("failed");
    expect(driver.pendingThroughSeq).toBeGreaterThan(driver.settledThroughSeq);

    const outcome = await h.alarm();
    expect(outcome.model).toBe("not_scheduled");
    expect(h.continuation!.runs).toBe(1);
  });

  it("does not let an ordinary message resume an ambiguous mutation", async () => {
    const h = await failWith("requires_reconciliation");
    const blocked = await h.stub.appendTurn(turn("p-requires_reconciliation-2"));

    expect(blocked.scheduling).toMatchObject({
      outcome: "blocked",
      policy: "requires_reconciliation",
    });
    expect((await h.stub.state())?.status).toBe("failed");
    expect(h.continuation!.runs).toBe(1);
  });
});

describe("retry budget", () => {
  it("backs off, persists a safe error, re-arms, and fails visibly when exhausted", async () => {
    const continuation = new FakeContinuation().throws(new Error("gateway unreachable"));
    const h = await freshDriverRun({ continuation });
    await h.stub.appendTurn(turn("r-1"));

    // Attempt 1 crashes: rescheduled with a bounded backoff, error persisted,
    // and the run is still visibly working.
    await h.alarm();
    let driver = await h.storage((s) => readDriver(s));
    expect(driver.phase).toBe("scheduled");
    expect(driver.attempt).toBe(1);
    expect(driver.resumePolicy).toBe("retryable");
    expect(driver.lastErrorCode).toBe("continuation_crashed");
    expect(driver.lastErrorMessage).toBe("gateway unreachable");
    expect(driver.nextAttemptAt).toBe(h.clock.value + driverRetryBackoffMs(1));
    expect((await h.stub.state())?.status).toBe("live");

    // The alarm is armed no later than the retry, and once the index work this
    // attempt produced has drained, the retry is exactly what it is armed for.
    expect(await h.alarmAt()).toBeLessThanOrEqual(driver.nextAttemptAt);

    // A redelivered alarm inside the backoff must not spend an attempt.
    const early = await h.alarm();
    expect(early.model).toBe("backoff");
    expect(continuation.runs).toBe(1);
    await h.stub.flushProjections();
    expect((await h.alarm()).nextAlarmAt).toBe(driver.nextAttemptAt);

    // Attempt 2, after the backoff.
    h.clock.advance(driverRetryBackoffMs(1));
    await h.alarm();
    driver = await h.storage((s) => readDriver(s));
    expect(continuation.runs).toBe(2);
    expect(driver.attempt).toBe(2);
    expect(driver.nextAttemptAt).toBe(h.clock.value + driverRetryBackoffMs(2));
    expect(driverRetryBackoffMs(2)).toBeGreaterThan(driverRetryBackoffMs(1));

    // Attempt 3 is the last one the budget allows.
    h.clock.advance(driverRetryBackoffMs(2));
    await h.alarm();
    expect(continuation.runs).toBe(DRIVER_MAX_ATTEMPTS);

    driver = await h.storage((s) => readDriver(s));
    expect(driver.phase).toBe("failed");
    expect(driver.lastErrorCode).toBe("driver_attempts_exhausted");
    expect(driver.resumePolicy).toBe("requires_input");
    expect((await h.stub.state())?.status).toBe("failed");

    // Exhausted means exhausted: another delivery starts nothing.
    h.clock.advance(60_000);
    const after = await h.alarm();
    expect(after.model).toBe("not_scheduled");
    expect(continuation.runs).toBe(DRIVER_MAX_ATTEMPTS);
  });

  it("keeps the attempt ceiling out of the failing component's hands", () => {
    const retry = { outcome: "retry" as const, errorCode: "boom" };
    const limits = { claimLeaseMs: CLAIM_LEASE_MS, maxAttempts: 3, continuationTotalMs: 1 };

    // One original attempt plus two retries.
    expect(toFinalizeRequest(retry, { retryCount: 0 }, limits)).toMatchObject({ kind: "retry" });
    expect(toFinalizeRequest(retry, { retryCount: 1 }, limits)).toMatchObject({ kind: "retry" });
    expect(toFinalizeRequest(retry, { retryCount: 2 }, limits)).toMatchObject({
      kind: "failed",
      state: "failed",
      resumePolicy: "requires_input",
      errorCode: "driver_attempts_exhausted",
    });
  });

  it("bounds the budget by retries, never by how many times work was claimed", () => {
    const retry = { outcome: "retry" as const, errorCode: "boom" };
    const limits = { claimLeaseMs: CLAIM_LEASE_MS, maxAttempts: 3, continuationTotalMs: 1 };

    // The regression this guards: a generation steered several times has a high
    // claim count and an untouched crash budget. Bounding on claims would fail
    // it on the first blip, having retried nothing.
    expect(toFinalizeRequest(retry, { retryCount: 0 }, limits)).toMatchObject({ kind: "retry" });
  });

  it("continues the same generation when input arrived mid-answer", async () => {
    const held = new FakeContinuation({ hold: true });
    const h = await freshDriverRun({ continuation: held });
    await h.stub.appendTurn(turn("c-1"));

    const first = h.alarm();
    await waitFor(() => held.runs === 1, "the attempt to start");
    const claim = held.claims[0];

    // A steer lands while the answer is in flight. It is above the generation's
    // included cursor, so the settle must become a continuation.
    await h.stub.appendTurn(turn("c-2", { source: "human_steer", content: "also check billing" }));
    held.release();
    const outcome = await first;

    expect(outcome.detail).toContain("completed -> continued");
    const driver = await h.storage((s) => readDriver(s));
    expect(driver.phase).toBe("scheduled");
    expect(driver.generationId).toBe(claim.generationId);
    expect(driver.nextAttemptAt).toBe(0); // a continuation is not a retry
    expect((await h.stub.state())?.status).toBe("live");

    // And the same generation picks the steer up on the next delivery.
    await h.alarm();
    expect(held.claims).toHaveLength(2);
    expect(held.claims[1].generationId).toBe(claim.generationId);
    expect((await h.storage((s) => claimGeneration(s, { now: h.clock.value }))).outcome).toBe(
      "nothing_scheduled",
    );
    expect((await h.stub.state())?.status).toBe("idle");
  });
});

describe("continuations and retries do not share a counter", () => {
  /**
   * The regression: `attempt` counts CLAIMS, and a steer arriving mid-answer
   * continues the generation and costs one. When the ceiling read `attempt`, a
   * customer who steered twice had silently spent the whole crash budget, and
   * the next transient blip terminated their run as `driver_attempts_exhausted`
   * having retried nothing at all.
   */
  it("leaves the retry budget untouched after two mid-answer steers", async () => {
    const held = new FakeContinuation({ hold: true });
    const h = await freshDriverRun({ continuation: held });
    await h.stub.appendTurn(turn("cb-1"));

    // Steer one, landing while the first answer is in flight.
    const firstRun = h.alarm();
    await waitFor(() => held.runs === 1, "the first attempt to start");
    await h.stub.appendTurn(turn("cb-2", { source: "human_steer", content: "also billing" }));
    held.release();
    expect((await firstRun).detail).toContain("completed -> continued");

    // Steer two, same again.
    held.hold();
    const secondRun = h.alarm();
    await waitFor(() => held.runs === 2, "the second attempt to start");
    await h.stub.appendTurn(turn("cb-3", { source: "human_steer", content: "and the logs" }));
    held.release();
    expect((await secondRun).detail).toContain("completed -> continued");

    let driver = await h.storage((s) => readDriver(s));
    expect(driver.attempt).toBe(2);
    // Two legitimate claims, zero retries: nothing has failed yet.
    expect(driver.retryCount).toBe(0);

    // Now the first transient blip. It must be RETRIED, not terminal.
    held.throws(new Error("gateway blip"));
    const third = await h.alarm();

    expect(held.runs).toBe(3);
    expect(third.detail).toContain("retry -> rescheduled");
    driver = await h.storage((s) => readDriver(s));
    expect(driver.phase).toBe("scheduled");
    expect(driver.attempt).toBe(3);
    expect(driver.retryCount).toBe(1);
    expect(driver.lastErrorCode).toBe("continuation_crashed");
    // The run is still alive and still visibly working.
    expect((await h.stub.state())?.status).toBe("live");
  });

  it("bounds a continuation that settles without consuming its input", async () => {
    // The mirror image: nothing checks `attempt` on the completed path, so a
    // continuation that includes none of its pending input would be continued
    // by the session and re-armed at `now`, forever.
    const idle = new FakeContinuation({ consumesInput: false });
    const h = await freshDriverRun({ continuation: idle });
    await h.stub.appendTurn(turn("np-1"));

    const first = await h.alarm();
    expect(first.detail).toContain("retry -> rescheduled");

    let driver = await h.storage((s) => readDriver(s));
    expect(driver.lastErrorCode).toBe("continuation_made_no_progress");
    expect(driver.retryCount).toBe(1);
    // Spaced out, not re-armed at once. That is the difference between a
    // bounded failure and a hot loop that bills for every lap.
    expect(driver.nextAttemptAt).toBe(h.clock.value + driverRetryBackoffMs(1));

    h.clock.advance(driverRetryBackoffMs(1));
    await h.alarm();
    h.clock.advance(driverRetryBackoffMs(2));
    await h.alarm();

    expect(idle.runs).toBe(DRIVER_MAX_ATTEMPTS);
    driver = await h.storage((s) => readDriver(s));
    expect(driver.phase).toBe("failed");
    expect(driver.lastErrorCode).toBe("driver_attempts_exhausted");
    expect((await h.stub.state())?.status).toBe("failed");

    // And it stays stopped.
    h.clock.advance(60_000);
    expect((await h.alarm()).model).toBe("not_scheduled");
    expect(idle.runs).toBe(DRIVER_MAX_ATTEMPTS);
  });

  it("does not punish an attempt that had nothing left to include", async () => {
    // The legitimate no-movement case the guard must not catch: attempt 1
    // consumed the input and then crashed, so attempt 2 is claimed with its
    // cursor already current and quite properly includes nothing.
    let calls = 0;
    const continuation = new FakeContinuation().onRun(() => {
      calls += 1;
      if (calls === 1) throw new Error("crashed after reading its input");
    });
    const h = await freshDriverRun({ continuation });
    await h.stub.appendTurn(turn("nb-1"));

    expect((await h.alarm()).detail).toContain("retry -> rescheduled");
    expect((await h.storage((s) => readDriver(s))).retryCount).toBe(1);

    h.clock.advance(driverRetryBackoffMs(1));
    const second = await h.alarm();

    expect(second.detail).toContain("completed -> settled");
    const driver = await h.storage((s) => readDriver(s));
    expect(driver.phase).toBe("idle");
    expect(driver.retryCount).toBe(0);
    expect((await h.stub.state())?.status).toBe("idle");
  });
});

describe("session state after a settle", () => {
  it("leaves no generation owned by the driver", async () => {
    const h = await freshDriverRun();
    await h.stub.appendTurn(turn("z-1"));
    await h.alarm();

    const driver = await h.storage((s) => readDriver(s));
    expect(driver.generationId).toBeNull();
    expect(driver.agentTurnId).toBeNull();
    expect(driver.attempt).toBe(0);
    expect((await h.stub.state())?.status).toBe("idle");
  });
});
