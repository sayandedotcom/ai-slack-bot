import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  appendInputMessages,
  appliedSchemaVersions,
  claimGeneration,
  enqueueProjectionJob,
  ensureSchema,
  finalizeAnswer,
  finalizeGeneration,
  listTurns,
  openApproval,
  putApprovalState,
  readApprovalState,
  readDriver,
  readGeneration,
  readModelTranscript,
  readState,
  resolveApprovalState,
  turnEventSeq,
  RUN_SCHEMA_VERSION,
} from "../src/run/session";
import { installRunPorts, nextAlarmAt, toFinalizeRequest } from "../src/agent/driver";
import { makeApprovalCardRunner } from "../src/approval/projection";
import type { Env } from "../src/index";
import { makeApprovalPort } from "../src/approval/port";
import { getApproval } from "../src/approval/repository";
import {
  FakeContinuation,
  freshDriverRun,
  turn,
  waitFor,
  type DriverHarness,
} from "./helpers/agent-driver";

/**
 * The card runner nudges the on-duty engineer (Phase 13). These suites are
 * about the CARD, not the DM, so they hand it an env with no nudge
 * destination: `sendNudge` refuses before it claims anything and before it
 * touches the network, which keeps this file free of live Slack calls no
 * matter what `identities` rows another suite in the shared D1 left behind.
 */
function nudgeless(workerEnv: Env): Env {
  return { ...workerEnv, NUDGE_MODE: "channel", NUDGE_FALLBACK_CHANNEL_ID: "" };
}

/**
 * THE PAUSE LATCH.
 *
 * Phase 11's scheduling claim in one file: `approval.escalate` records and
 * returns — the isolate cannot park a run — and the park happens exactly once,
 * at generation finalize, inside the same epoch-fenced transaction that
 * settles everything else. Every case below is driven through the real driver
 * harness, the real session transactions and the real migration ledger;
 * nothing here mocks a fence, a schema upgrade or a projection.
 */

const APPROVAL_ID = "apr:11111111-1111-4111-8111-111111111111";

/**
 * Exactly what the `escalate` capability's port writes, synchronously, from
 * inside the running continuation.
 */
function escalate(
  storage: DurableObjectStorage,
  generationId: string,
  now: number,
  approvalId = APPROVAL_ID,
): void {
  putApprovalState(storage, {
    approvalId,
    generationId,
    draft: "we can have that fixed by Friday",
    why: "it commits us to a date",
    now,
  });
}

/** The same write, from a test that is not inside a continuation. */
async function escalateLocally(
  h: DriverHarness,
  generationId: string,
  approvalId = APPROVAL_ID,
): Promise<void> {
  await h.storage((s) => escalate(s, generationId, h.clock.value, approvalId));
}

/* ------------------------------------------------------------- the latch -- */

describe("a generation whose execution opened an approval parks the run", () => {
  it("settles paused: awaiting_approval, driver idle, nothing armed for model work", async () => {
    const continuation = new FakeContinuation();
    const h = await freshDriverRun({ continuation });
    continuation
      .onRun((claim, s) => {
        escalate(s, claim.generationId, h.clock.value);
      })
      .returns({ outcome: "paused", approvalId: APPROVAL_ID });

    await h.stub.appendTurn(turn("p-1"));
    await h.alarm();

    expect((await h.stub.state())?.status).toBe("awaiting_approval");

    const driver = await h.storage((s) => readDriver(s));
    expect(driver.phase).toBe("idle");
    expect(driver.generationId).toBeNull();
    expect(driver.lastErrorCode).toBeNull();

    // The generation is terminal and carries WHY it stopped, on error-free
    // terminal fields — a pause is not a failure.
    const generationId = continuation.claims[0].generationId;
    const generation = await h.storage((s) => readGeneration(s, generationId));
    expect(generation?.state).toBe("completed");
    expect(generation?.pausedApprovalId).toBe(APPROVAL_ID);
    expect(generation?.lastErrorCode).toBeNull();

    // Nothing to reclaim: the run wakes only through `appendTurn`. Once the
    // status projection has drained, the next delivery finds nothing due at
    // all and clears the slot — a parked run hibernates rather than waking to
    // discover it has no work.
    await h.stub.flushProjections();
    const parked = await h.alarm();
    expect(parked.model).toBe("not_scheduled");
    expect(await h.alarmAt()).toBeNull();
    expect(
      nextAlarmAt({
        driver,
        projectionDueAt: null,
        continuationInstalled: true,
        now: h.clock.value,
      }),
    ).toBeNull();
  });

  it("still settles completed and idle when no approval is open (regression)", async () => {
    const h = await freshDriverRun();
    await h.stub.appendTurn(turn("p-2"));
    await h.alarm();

    expect((await h.stub.state())?.status).toBe("idle");
    expect((await h.storage((s) => readDriver(s))).phase).toBe("idle");
    const generation = await h.storage((s) =>
      readGeneration(s, h.continuation!.claims[0].generationId),
    );
    expect(generation?.state).toBe("completed");
    expect(generation?.pausedApprovalId).toBeNull();
  });

  it("refuses to park a run whose approval was withdrawn before the finalize committed", async () => {
    const continuation = new FakeContinuation();
    const h = await freshDriverRun({ continuation });
    continuation
      .onRun((claim, s) => {
        escalate(s, claim.generationId, h.clock.value);
        // Withdrawn after escalating. The latch consults the LOCAL record at
        // commit time, never what the continuation reported on its way out.
        resolveApprovalState(s, APPROVAL_ID, "resolved", h.clock.value);
      })
      .returns({ outcome: "paused", approvalId: APPROVAL_ID });

    await h.stub.appendTurn(turn("p-3"));
    await h.alarm();

    expect((await h.stub.state())?.status).toBe("idle");
    expect((await h.storage((s) => readDriver(s))).phase).toBe("idle");
  });

  it("continues the generation rather than parking when fresher input arrived", async () => {
    const continuation = new FakeContinuation({ hold: true, consumesInput: false });
    const h = await freshDriverRun({ continuation });
    continuation
      .onRun((claim, s) => {
        escalate(s, claim.generationId, h.clock.value);
      })
      .returns({ outcome: "paused", approvalId: APPROVAL_ID });

    await h.stub.appendTurn(turn("p-4"));
    const running = h.alarm();
    await waitFor(() => continuation.runs === 1, "the attempt to start");

    // The customer said something new. The cursor comparison wins over the
    // pause: the same generation continues, and the approval stays open.
    await h.stub.appendTurn(turn("p-5"));
    continuation.release();
    await running;

    expect((await h.storage((s) => readDriver(s))).phase).toBe("scheduled");
    expect((await h.stub.state())?.status).toBe("live");
    expect((await h.storage((s) => openApproval(s)))?.approvalId).toBe(APPROVAL_ID);
  });
});

describe("one unsettled approval per run, as a constraint", () => {
  it("refuses a second open approval, including beside one that is resolving", async () => {
    const h = await freshDriverRun({ continuation: null });
    await escalateLocally(h, "gen:one");

    await expect(escalateLocally(h, "gen:one", "apr:second")).rejects.toThrow();

    // And `resolving` is still unsettled: a decision on its way in does not
    // free the slot, or a run could end up parked on two approvals at once.
    await h.storage((s) => resolveApprovalState(s, APPROVAL_ID, "resolving", h.clock.value));
    await expect(escalateLocally(h, "gen:one", "apr:third")).rejects.toThrow();

    // Once it is genuinely settled, the next escalation is allowed.
    await h.storage((s) => resolveApprovalState(s, APPROVAL_ID, "resolved", h.clock.value));
    await escalateLocally(h, "gen:one", "apr:fourth");
    expect((await h.storage((s) => openApproval(s)))?.approvalId).toBe("apr:fourth");
  });
});

describe("the answer-settling transaction latches the pause too", () => {
  /**
   * `finalizeAnswer` — not `finalizeGeneration` — is what ends a real
   * generation that produced an answer: it sets the generation terminal, the
   * driver idle and the public status, all itself, and the driver's finalize
   * then reads `already_settled` and can change nothing. Every case above
   * drives the fake continuation, which never reaches this transaction, so
   * without this case the production path could be latch-free and the suite
   * would still be green.
   */
  async function claimedRun() {
    const h = await freshDriverRun({ continuation: null });
    await h.stub.appendTurn(turn("fa-1"));
    const claim = await h.storage((s) => claimGeneration(s, { now: h.clock.value }));
    if (claim.outcome !== "claimed") throw new Error("expected a claim");

    // Consume the input, exactly as a real attempt's first `prepareStep` does.
    // Without it the cursor compare supersedes every finalize below, which is
    // correct behaviour and would hide the thing under test.
    await h.storage((s) => {
      const seq = turnEventSeq(s, "fa-1");
      if (seq === null) throw new Error("no input turn");
      return appendInputMessages(s, claim.claim.fence, {
        globalStep: 0,
        messages: [{ sourceEventSeq: seq, message: { role: "user", content: "the deploy is stuck" } }],
        now: h.clock.value,
      });
    });
    return { h, claim: claim.claim };
  }

  const answer = (attempt: number, text: string) => ({
    attempt,
    finalText: text,
    summary: text,
    internalNarration: false,
    deltaBatchSeq: 0,
    terminalBatchSeq: 1,
    globalStep: 0,
  });

  it("parks the run in the same transaction as the final turn", async () => {
    const { h, claim } = await claimedRun();
    await escalateLocally(h, claim.generationId);

    const outcome = await h.storage((s) =>
      finalizeAnswer(s, claim.fence, { ...answer(claim.attempt, "drafted, and asking"), now: h.clock.value }),
    );
    expect(outcome.outcome).toBe("finalized");
    if (outcome.outcome !== "finalized") throw new Error("unreachable");
    expect(outcome.pausedApprovalId).toBe(APPROVAL_ID);

    // The public status moved inside that transaction — a dashboard can never
    // see a settled generation whose run still claims to be working.
    expect((await h.storage((s) => readState(s)))?.status).toBe("awaiting_approval");
    expect((await h.storage((s) => readDriver(s))).phase).toBe("idle");
    expect(
      (await h.storage((s) => readGeneration(s, claim.generationId)))?.pausedApprovalId,
    ).toBe(APPROVAL_ID);
  });

  it("reports the same pause on a redelivered finalization", async () => {
    const { h, claim } = await claimedRun();
    await escalateLocally(h, claim.generationId);
    await h.storage((s) =>
      finalizeAnswer(s, claim.fence, { ...answer(claim.attempt, "drafted, and asking"), now: h.clock.value }),
    );

    // An at-least-once redelivery. It must not report a completed run to the
    // driver, or the run would be un-parked on the dashboard while the
    // approval is still open.
    const replay = await h.storage((s) =>
      finalizeAnswer(s, claim.fence, {
        ...answer(claim.attempt, "a DIFFERENT answer that must never be written"),
        now: h.clock.value + 1,
      }),
    );
    expect(replay.outcome).toBe("already_final");
    if (replay.outcome !== "already_final") throw new Error("unreachable");
    expect(replay.pausedApprovalId).toBe(APPROVAL_ID);
    expect((await h.storage((s) => readState(s)))?.status).toBe("awaiting_approval");
  });

  it("settles idle, as before, when nothing is open", async () => {
    const { h, claim } = await claimedRun();
    const outcome = await h.storage((s) =>
      finalizeAnswer(s, claim.fence, { ...answer(claim.attempt, "answered"), now: h.clock.value }),
    );
    expect(outcome.outcome).toBe("finalized");
    if (outcome.outcome !== "finalized") throw new Error("unreachable");
    expect(outcome.pausedApprovalId).toBeNull();
    expect((await h.storage((s) => readState(s)))?.status).toBe("idle");
  });
});

describe("resolveApprovalState reports whether IT moved the row", () => {
  it("is false for a transition that matched nothing", async () => {
    const h = await freshDriverRun({ continuation: null });
    await escalateLocally(h, "gen:resolve");

    const moves = await h.storage((s) => ({
      first: resolveApprovalState(s, APPROVAL_ID, "resolved", h.clock.value),
      // Already there. Task 5's sweeper re-drives undelivered resolutions and
      // needs "somebody already had" to read as false, not as a fresh move.
      again: resolveApprovalState(s, APPROVAL_ID, "resolved", h.clock.value),
      // Backwards is refused outright.
      backwards: resolveApprovalState(s, APPROVAL_ID, "resolving", h.clock.value),
      unknown: resolveApprovalState(s, "apr:never-existed", "resolved", h.clock.value),
    }));

    expect(moves).toEqual({ first: true, again: false, backwards: false, unknown: false });
    expect((await h.storage((s) => readApprovalState(s, APPROVAL_ID)))?.state).toBe("resolved");
  });
});

/* -------------------------------------------------------- crash recovery -- */

describe("a crash between escalate and finalize still parks", () => {
  it("re-runs on the recovery claim, finds the open approval, and parks", async () => {
    const continuation = new FakeContinuation();
    const h = await freshDriverRun({ continuation });

    // Attempt 1: the escalate lands durably, then the continuation dies.
    continuation
      .onRun((claim, s) => {
        escalate(s, claim.generationId, h.clock.value);
      })
      .throws(new Error("the isolate died holding the draft"));

    await h.stub.appendTurn(turn("c-1"));
    await h.alarm();
    expect((await h.storage((s) => readDriver(s))).phase).toBe("scheduled");

    // Attempt 2: the SAME generation, whose finalize consults a local record
    // this attempt never wrote itself.
    const generationId = continuation.claims[0].generationId;
    continuation
      .onRun(async () => {})
      .returns({ outcome: "paused", approvalId: APPROVAL_ID });
    h.clock.advance(60_000);
    await h.alarm();

    expect(continuation.claims[1].generationId).toBe(generationId);
    expect((await h.stub.state())?.status).toBe("awaiting_approval");
    expect((await h.storage((s) => readGeneration(s, generationId)))?.pausedApprovalId).toBe(
      APPROVAL_ID,
    );

    // One approval, one local row, however many attempts it took.
    expect(await h.storage((s) => readApprovalState(s, APPROVAL_ID))).toMatchObject({
      state: "open",
      generationId,
    });
  });
});

/* ----------------------------------------------------------- the fencing -- */

describe("a stale-epoch claimant can neither park nor unpark", () => {
  it("refuses a paused finalize from a superseded claimant", async () => {
    const h = await freshDriverRun({ continuation: null });
    await h.stub.appendTurn(turn("f-1"));

    const a = await h.storage((s) => claimGeneration(s, { now: h.clock.value }));
    if (a.outcome !== "claimed") throw new Error("expected a claim");
    h.clock.advance(150_001);
    const b = await h.storage((s) => claimGeneration(s, { now: h.clock.value }));
    if (b.outcome !== "claimed") throw new Error("expected a reclaim");

    await escalateLocally(h, a.claim.generationId);

    const outcome = await h.storage((s) =>
      finalizeGeneration(
        s,
        a.claim.fence,
        { kind: "paused", approvalId: APPROVAL_ID },
        h.clock.value,
      ),
    );
    expect(outcome.outcome).toBe("stale_claim");

    // Nothing of the loser's reached the durable record: the successor still
    // owns the generation, and no run was parked.
    const driver = await h.storage((s) => readDriver(s));
    expect(driver.phase).toBe("running");
    expect(driver.claimEpoch).toBe(b.claim.fence.claimEpoch);
    expect((await h.stub.state())?.status).not.toBe("awaiting_approval");
    expect(
      (await h.storage((s) => readGeneration(s, a.claim.generationId)))?.pausedApprovalId,
    ).toBeNull();
    expect(await h.storage((s) => readModelTranscript(s))).toHaveLength(0);
  });

  it("refuses a superseded claimant's attempt to settle a parked run back to idle", async () => {
    const continuation = new FakeContinuation();
    const h = await freshDriverRun({ continuation });
    continuation
      .onRun((claim, s) => {
        escalate(s, claim.generationId, h.clock.value);
      })
      .returns({ outcome: "paused", approvalId: APPROVAL_ID });
    await h.stub.appendTurn(turn("f-2"));
    await h.alarm();
    expect((await h.stub.state())?.status).toBe("awaiting_approval");

    const parked = continuation.claims[0].fence;
    const unpark = await h.storage((s) =>
      finalizeGeneration(s, parked, { kind: "completed" }, h.clock.value),
    );
    // The generation is terminal, so a redelivery reads as settled — and
    // whatever it reads, it must not move the parked run.
    expect(unpark.outcome).toBe("already_settled");
    expect((await h.stub.state())?.status).toBe("awaiting_approval");
    expect((await h.storage((s) => readGeneration(s, parked.generationId)))?.pausedApprovalId).toBe(
      APPROVAL_ID,
    );
  });

  it("maps the paused outcome onto a paused finalize request", () => {
    expect(
      toFinalizeRequest(
        { outcome: "paused", approvalId: APPROVAL_ID },
        { retryCount: 2 },
        { claimLeaseMs: 1, maxAttempts: 3, continuationTotalMs: 1 },
      ),
    ).toEqual({ kind: "paused", approvalId: APPROVAL_ID });
  });
});

/* ------------------------------------------------------------- migration -- */

describe("the local schema upgrade", () => {
  it("preserves Phase 10 state and is idempotent", async () => {
    const h = await freshDriverRun();
    await h.stub.appendTurn(turn("m-1"));
    await h.alarm();

    const before = {
      turns: await h.storage((s) => listTurns(s)),
      driver: await h.storage((s) => readDriver(s)),
      versions: await h.storage((s) => appliedSchemaVersions(s)),
    };
    expect(before.versions).toEqual(
      Array.from({ length: RUN_SCHEMA_VERSION }, (_, index) => index + 1),
    );

    // Re-run the newest migration on an object that already carries a full
    // Phase 10 record — the real upgrade path, not a fresh database — and then
    // run the whole ledger again, which must be a no-op.
    await h.storage((s) => {
      s.sql.exec("DELETE FROM _run_schema_migrations WHERE version = ?", RUN_SCHEMA_VERSION);
      return ensureSchema(s, 1_000);
    });
    await h.storage((s) => ensureSchema(s, 1_001));

    expect(await h.storage((s) => appliedSchemaVersions(s))).toEqual(before.versions);
    expect(await h.storage((s) => listTurns(s))).toEqual(before.turns);
    expect(await h.storage((s) => readDriver(s))).toEqual(before.driver);

    // And the new table still works after the repeat.
    await escalateLocally(h, "gen:migration", "apr:migration");
    expect((await h.storage((s) => openApproval(s)))?.approvalId).toBe("apr:migration");
  });

  it("carries queued projection jobs through the agent_projection_jobs rebuild", async () => {
    const h = await freshDriverRun({ continuation: null });

    // Put this object back to its PRE-v6 shape, queued work and all: the
    // three-kind CHECK is exactly why the table has to be rebuilt, and on a
    // fresh object the rebuild only ever copies an empty table. Production is
    // otherwise the first place this copies a live row.
    const rows = [
      {
        id: "run_index:rev-1",
        kind: "run_index",
        source_id: "rev-1",
        state: "pending",
        claim_token: null,
        lease_expires_at: null,
        attempts: 2,
        next_attempt_at: 4_000,
        last_error: "d1 was down",
        created_at: 1_000,
        updated_at: 2_000,
      },
      {
        id: "memory_outbox:memory:r:g",
        kind: "memory_outbox",
        source_id: "memory:r:g",
        state: "claimed",
        claim_token: "token-abc",
        lease_expires_at: 9_999,
        attempts: 1,
        next_attempt_at: 0,
        last_error: null,
        created_at: 1_500,
        updated_at: 1_800,
      },
    ];

    await h.storage((s) => {
      s.sql.exec("DROP TABLE agent_projection_jobs");
      s.sql.exec(`
        CREATE TABLE agent_projection_jobs (
          id               TEXT PRIMARY KEY,
          kind             TEXT NOT NULL CHECK (kind IN ('run_index', 'd1_usage', 'memory_outbox')),
          source_id        TEXT NOT NULL,
          state            TEXT NOT NULL CHECK (
            state IN ('pending', 'claimed', 'completed', 'failed')
          ),
          claim_token      TEXT,
          lease_expires_at INTEGER,
          attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          next_attempt_at  INTEGER NOT NULL,
          last_error       TEXT,
          created_at       INTEGER NOT NULL,
          updated_at       INTEGER NOT NULL,
          UNIQUE (kind, source_id)
        );
      `);
      for (const row of rows) {
        s.sql.exec(
          `INSERT INTO agent_projection_jobs
             (id, kind, source_id, state, claim_token, lease_expires_at, attempts,
              next_attempt_at, last_error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          row.id,
          row.kind,
          row.source_id,
          row.state,
          row.claim_token,
          row.lease_expires_at,
          row.attempts,
          row.next_attempt_at,
          row.last_error,
          row.created_at,
          row.updated_at,
        );
      }
      s.sql.exec("DELETE FROM _run_schema_migrations WHERE version = ?", RUN_SCHEMA_VERSION);
      return ensureSchema(s, 2_000);
    });

    // Every column of every queued job survives. A rebuild that dropped these
    // would silently lose work the system believes is scheduled — an undelivered
    // memory episode, a dashboard row that never updates — with nothing left to
    // report it.
    const after = await h.storage((s) =>
      s.sql
        .exec("SELECT * FROM agent_projection_jobs ORDER BY id ASC")
        .toArray(),
    );
    expect(after).toEqual([...rows].sort((a, b) => a.id.localeCompare(b.id)));

    // And the whole point of the rebuild: the new kind is now insertable.
    await h.storage((s) => enqueueProjectionJob(s, "approval_card", "apr:after-rebuild", 3_000));
    expect(
      await h.storage((s) =>
        s.sql
          .exec<{ n: number }>(
            "SELECT COUNT(*) AS n FROM agent_projection_jobs WHERE kind = 'approval_card'",
          )
          .one().n,
      ),
    ).toBe(1);
  });
});

/* ------------------------------------------------------------ projection -- */

describe("the approval_card projection", () => {
  const CHANNEL = "C0APPROVALCARD";
  const THREAD = "1712345678.000200";

  /**
   * A Slack-origin run with the real `approval_card` runner installed under
   * its own key, exactly as `productionRunPorts` installs it.
   */
  async function projectingRun(db: D1Database | null = null): Promise<DriverHarness> {
    const h = await freshDriverRun({
      continuation: null,
      slack: { channelId: `${CHANNEL}${Math.floor(Math.random() * 1e6)}`, threadTs: THREAD },
    });
    installRunPorts(
      {
        projections: {
          approval_card: (ctx, workerEnv) =>
            makeApprovalCardRunner({ storage: ctx.storage, db: db ?? workerEnv.DB, env: nudgeless(workerEnv) }),
        },
      },
      { runKey: h.key },
    );
    // Clear the run-index work first, so the next alarm dispatches the card.
    await h.stub.flushProjections();
    return h;
  }

  const jobRow = (h: DriverHarness, id: string) =>
    h.storage((s) =>
      s.sql
        .exec<{ state: string; attempts: number; last_error: string | null }>(
          "SELECT state, attempts, last_error FROM agent_projection_jobs WHERE id = ?",
          id,
        )
        .toArray(),
    );

  it("delivers the D1 card through the alarm dispatcher", async () => {
    const h = await projectingRun();
    const approvalId = await h.storage(async (s) => {
      const port = makeApprovalPort({
        storage: s,
        db: env.DB,
        env: nudgeless(env as unknown as Env),
        runId: h.runId,
        generationId: "gen:card",
        slackThread: { channelId: h.descriptor.channelId!, threadTs: THREAD },
        now: () => h.clock.value,
      });
      return (await port.open({ draft: "the fix ships Friday", why: "it is committal" }))
        .approvalId;
    });
    expect(approvalId).toMatch(/^apr:/);

    await h.alarm();

    expect(await getApproval(env.DB, approvalId)).toMatchObject({
      runId: h.runId,
      generationId: "gen:card",
      draft: "the fix ships Friday",
      why: "it is committal",
      channelId: h.descriptor.channelId,
      threadTs: THREAD,
      shadow: false,
      decision: "pending",
      delivery: "none",
    });
    expect(await jobRow(h, `approval_card:${approvalId}`)).toMatchObject([{ state: "completed" }]);
  });

  it("treats duplicate_open as success rather than retrying forever", async () => {
    const h = await projectingRun();
    const approvalId = await h.storage(async (s) => {
      const port = makeApprovalPort({
        storage: s,
        db: env.DB,
        env: nudgeless(env as unknown as Env),
        runId: h.runId,
        generationId: "gen:dup",
        slackThread: { channelId: h.descriptor.channelId!, threadTs: THREAD },
        now: () => h.clock.value,
      });
      return (await port.open({ draft: "d", why: "w" })).approvalId;
    });
    await h.alarm();
    expect(await getApproval(env.DB, approvalId)).not.toBeNull();

    // A redelivery of the same job: the row is already there, the partial
    // unique index refuses the insert, and that is SUCCESS — not an error to
    // retry until the job's budget is gone.
    await h.storage((s) =>
      s.sql.exec(
        "UPDATE agent_projection_jobs SET state = 'pending', next_attempt_at = 0 WHERE id = ?",
        `approval_card:${approvalId}`,
      ),
    );
    await h.alarm();

    expect(await jobRow(h, `approval_card:${approvalId}`)).toMatchObject([
      { state: "completed", attempts: 2 },
    ]);
  });

  it("retries rather than retiring a job whose collision is a DIFFERENT approval", async () => {
    const h = await projectingRun();
    const port = (generationId: string) => (s: DurableObjectStorage) =>
      makeApprovalPort({
        storage: s,
        db: env.DB,
        env: nudgeless(env as unknown as Env),
        runId: h.runId,
        generationId,
        slackThread: { channelId: h.descriptor.channelId!, threadTs: THREAD },
        now: () => h.clock.value,
      });

    const first = await h.storage(async (s) => (await port("gen:a")(s).open({ draft: "a", why: "a" })).approvalId);
    await h.alarm();
    expect(await getApproval(env.DB, first)).not.toBeNull();

    // THE REACHABLE HOLE. `withdraw` writes the local row `resolved` first and
    // then CASes D1; under a D1 outage the CAS fails, so the card stays
    // `pending` while the local slot is free. The model escalates again.
    await h.storage((s) => resolveApprovalState(s, first, "resolved", h.clock.value));
    const second = await h.storage(async (s) => (await port("gen:b")(s).open({ draft: "b", why: "b" })).approvalId);

    await h.alarm();

    // `idx_approvals_one_open` is on `run_id`, not `id`, so the insert collided
    // with the OLD card. Retiring the job here would park the run on an
    // approval the dashboard has no card for.
    expect(await getApproval(env.DB, second)).toBeNull();
    const [job] = await jobRow(h, `approval_card:${second}`);
    expect(job.state).toBe("pending");
    expect(job.last_error).toContain("already holds run");
    // And the human's card was not disturbed.
    expect(await getApproval(env.DB, first)).toMatchObject({ decision: "pending" });
  });

  it("retries on an injected D1 failure", async () => {
    const broken = {
      prepare() {
        throw new Error("D1_ERROR: the database is unreachable");
      },
    } as unknown as D1Database;
    const h = await projectingRun(broken);
    const approvalId = await h.storage(async (s) => {
      const port = makeApprovalPort({
        storage: s,
        db: broken,
        env: nudgeless(env as unknown as Env),
        runId: h.runId,
        generationId: "gen:down",
        slackThread: { channelId: h.descriptor.channelId!, threadTs: THREAD },
        now: () => h.clock.value,
      });
      return (await port.open({ draft: "d", why: "w" })).approvalId;
    });

    await h.alarm();

    const [job] = await jobRow(h, `approval_card:${approvalId}`);
    expect(job.state).toBe("pending");
    expect(job.attempts).toBe(1);
    expect(job.last_error).toContain("D1_ERROR");
    expect(await getApproval(env.DB, approvalId)).toBeNull();
  });

  it("drops the job when the approval was resolved before it was ever projected", async () => {
    const h = await projectingRun();
    const approvalId = await h.storage(async (s) => {
      const port = makeApprovalPort({
        storage: s,
        db: env.DB,
        env: nudgeless(env as unknown as Env),
        runId: h.runId,
        generationId: "gen:gone",
        slackThread: { channelId: h.descriptor.channelId!, threadTs: THREAD },
        now: () => h.clock.value,
      });
      const opened = await port.open({ draft: "d", why: "w" });
      resolveApprovalState(s, opened.approvalId, "resolved", h.clock.value);
      return opened.approvalId;
    });

    await h.alarm();

    expect(await getApproval(env.DB, approvalId)).toBeNull();
    expect(await jobRow(h, `approval_card:${approvalId}`)).toMatchObject([{ state: "completed" }]);
  });
});
