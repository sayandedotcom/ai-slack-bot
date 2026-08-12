import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  appendAgentToolCallUpdate,
  appendAssistantUpdate,
  appendInputMessages,
  appendTurn,
  appliedSchemaVersions,
  checkClaim,
  checkpointStepMessages,
  claimGeneration,
  ensureSchema,
  finalizeGeneration,
  hasPendingInput,
  heartbeat,
  initializeSession,
  latestRunIndexRevision,
  latestSeq,
  listEvents,
  listPendingInputTurns,
  listRecentTurns,
  listToolCalls,
  listTurns,
  listTurnsAfter,
  readDriver,
  readGeneration,
  readModelTranscript,
  readState,
  recordStepUsage,
  RUN_SCHEMA_VERSION,
  setStatus,
  setSummary,
  totalCostNanoUsd,
  turnEventSeq,
  type RunDescriptor,
} from "../src/run/session";
import { chatRunKey } from "../src/run/keys";
import { ZERO_USAGE } from "../src/agent/usage";
import type { ClaimFence, StepUsageInput } from "../src/agent/contracts";
import type { RunTurnInput } from "../src/run/protocol";

/**
 * Storage carries across cases AND files in vitest-pool-workers 0.21 — there is
 * no isolatedStorage. Every case mints its own key and nothing asserts an
 * absolute seq. See phase-08-notes.md.
 */
function freshRun() {
  const runId = crypto.randomUUID();
  const key = chatRunKey(crypto.randomUUID());
  const stub = env.RUNS.get(env.RUNS.idFromName(key));
  const descriptor: RunDescriptor = {
    runId,
    key,
    origin: "chat",
    channelId: null,
    threadTs: null,
  };
  return { runId, key, stub, descriptor };
}

function inRun<T>(stub: DurableObjectStub, fn: (storage: DurableObjectStorage) => T): Promise<T> {
  return runInDurableObject(stub, (_instance, state) => fn(state.storage));
}

function turn(id: string, overrides: Partial<RunTurnInput> = {}): RunTurnInput {
  return {
    id,
    role: "user",
    source: "customer",
    content: "the deploy is stuck",
    ...overrides,
  };
}

function usage(fence: ClaimFence, overrides: Partial<StepUsageInput> = {}): StepUsageInput {
  return {
    generationId: fence.generationId,
    agentTurnId: `agent:${fence.generationId}`,
    attempt: 1,
    globalStep: 0,
    provider: "anthropic",
    model: "claude-fable",
    usage: { ...ZERO_USAGE, inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    costNanoUsd: 4_200,
    latencyMs: 900,
    finishReason: "stop",
    ...overrides,
  };
}

function schemaAppliedAt(s: DurableObjectStorage, version = 2): number {
  return s.sql
    .exec<{ applied_at: number }>(
      "SELECT applied_at FROM _run_schema_migrations WHERE version = ?",
      version,
    )
    .one().applied_at;
}

/**
 * Put the run's pending input into the transcript, which is what a real driver
 * does between claiming and finalizing. Without it a finalize correctly reports
 * `continued`: the input was never answered.
 */
function includePendingInput(
  s: DurableObjectStorage,
  fence: ClaimFence,
  turnId = "slack:E1",
  now = 2_500,
): void {
  const seq = turnEventSeq(s, turnId) as number;
  appendInputMessages(s, fence, {
    globalStep: 0,
    messages: [{ sourceEventSeq: seq, message: { role: "user", content: "the deploy is stuck" } }],
    now,
  });
}

/** A claimed generation, which is the precondition for almost everything below. */
async function claimedRun() {
  const run = freshRun();
  const claim = await inRun(run.stub, (s) => {
    initializeSession(s, run.descriptor, 1_000);
    appendTurn(s, turn("slack:E1"), 1_001);
    const outcome = claimGeneration(s, { now: 2_000, leaseMs: 60_000 });
    if (outcome.outcome !== "claimed") throw new Error(`expected a claim, got ${outcome.outcome}`);
    return outcome.claim;
  });
  return { ...run, claim, fence: claim.fence };
}

describe("local schema ledger", () => {
  it("records both versions once and re-entry is a no-op", async () => {
    const { stub, descriptor } = freshRun();
    const result = await inRun(stub, (s) => {
      initializeSession(s, descriptor, 1_000);
      const first = appliedSchemaVersions(s);
      const before = schemaAppliedAt(s);
      // The constructor already applied it; two more calls must change nothing.
      ensureSchema(s, 9_000);
      ensureSchema(s, 9_001);
      return {
        first,
        before,
        second: appliedSchemaVersions(s),
        after: schemaAppliedAt(s),
        drivers: s.sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM agent_driver")
          .one().n,
      };
    });

    expect(result.first).toEqual([1, 2, 3, 4]);
    expect(result.second).toEqual([1, 2, 3, 4]);
    expect(RUN_SCHEMA_VERSION).toBe(4);
    // Not re-applied: the ledger row still carries its original timestamp, and
    // the driver singleton was not re-seeded over live state.
    expect(result.after).toBe(result.before);
    expect(result.drivers).toBe(1);
  });

  it("upgrades a phase 08 object without losing state, events, turns or tool calls", async () => {
    const { stub, descriptor } = freshRun();

    const before = await inRun(stub, (s) => {
      // Rebuild the exact Phase 08 shape: v1 tables, real rows, no ledger and
      // no agent tables at all.
      for (const table of [
        "_run_schema_migrations",
        "agent_driver",
        "agent_generations",
        "model_messages",
        "model_step_usage",
        "agent_projection_jobs",
        "run_index_outbox",
        "assistant_batches",
      ]) {
        s.sql.exec(`DROP TABLE IF EXISTS ${table}`);
      }
      s.sql.exec(
        `INSERT INTO run_state
           (singleton, run_id, run_key, origin, channel_id, thread_ts, status, summary,
            created_at, updated_at)
         VALUES (1, ?, ?, 'chat', NULL, NULL, 'live', 'looking at the deploy', 500, 900)`,
        descriptor.runId,
        descriptor.key,
      );
      // A historical triage turn: exactly the row that must NOT schedule work.
      s.sql.exec(
        `INSERT INTO stream_events (seq, type, payload_json, created_at)
         VALUES (1, 'turn', '{"seq":1,"type":"turn"}', 600)`,
      );
      s.sql.exec(
        `INSERT INTO turns (id, role, source, content, metadata_json, created_at, event_seq)
         VALUES ('triage:Ev1', 'system', 'triage', 'observe channel opening', NULL, 600, 1)`,
      );
      s.sql.exec(
        `INSERT INTO stream_events (seq, type, payload_json, created_at)
         VALUES (2, 'tool_call', '{"seq":2,"type":"tool_call"}', 700)`,
      );
      s.sql.exec(
        `INSERT INTO tool_calls (call_id, name, state, input_json, output_json, error,
                                 started_at, updated_at)
         VALUES ('c1', 'code', 'completed', '{"source":"x"}', '{"ok":true}', NULL, 700, 700)`,
      );
      return {
        events: listEvents(s, 0, 100).length,
        turns: listTurns(s).length,
        cursor: latestSeq(s),
      };
    });

    // The upgrade, exactly as a wake would run it.
    const after = await inRun(stub, (s) => {
      ensureSchema(s, 10_000);
      return {
        versions: appliedSchemaVersions(s),
        events: listEvents(s, 0, 100).length,
        turns: listTurns(s).length,
        cursor: latestSeq(s),
        toolCalls: s.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM tool_calls").one().n,
        driver: readDriver(s),
        state: readState(s),
        pending: hasPendingInput(s),
      };
    });

    expect(after.versions).toEqual([1, 2, 3, 4]);
    expect(after.events).toBe(before.events);
    expect(after.turns).toBe(before.turns);
    expect(after.cursor).toBe(before.cursor);
    expect(after.toolCalls).toBe(1);

    // The whole point: the historical triage turn is the watermark, not work.
    expect(after.driver.phase).toBe("idle");
    expect(after.driver.generationId).toBeNull();
    expect(after.driver.pendingThroughSeq).toBe(1);
    expect(after.driver.settledThroughSeq).toBe(1);
    expect(after.pending).toBe(false);

    // Public state joins the driver at idle; the summary and timestamps survive.
    expect(after.state?.status).toBe("idle");
    expect(after.state?.summary).toBe("looking at the deploy");
    expect(after.state?.updatedAt).toBe(900);
  });

  it("evaluates the next new input under current policy after an upgrade", async () => {
    const { stub, descriptor } = freshRun();
    await inRun(stub, (s) => {
      for (const table of ["_run_schema_migrations", "agent_driver", "agent_generations"]) {
        s.sql.exec(`DROP TABLE IF EXISTS ${table}`);
      }
      s.sql.exec(
        `INSERT INTO run_state
           (singleton, run_id, run_key, origin, channel_id, thread_ts, status, summary,
            created_at, updated_at)
         VALUES (1, ?, ?, 'chat', NULL, NULL, 'live', NULL, 500, 900)`,
        descriptor.runId,
        descriptor.key,
      );
      s.sql.exec(
        `INSERT INTO stream_events (seq, type, payload_json, created_at)
         VALUES (1, 'turn', '{"seq":1,"type":"turn"}', 600)`,
      );
      s.sql.exec(
        `INSERT INTO turns (id, role, source, content, metadata_json, created_at, event_seq)
         VALUES ('triage:Ev1', 'system', 'triage', 'historical', NULL, 600, 1)`,
      );
      ensureSchema(s, 10_000);
    });

    const scheduled = await inRun(stub, (s) => {
      const result = appendTurn(s, turn("slack:E2"), 11_000);
      return { result, driver: readDriver(s), status: readState(s)?.status };
    });

    expect(scheduled.result.scheduling.outcome).toBe("allocated");
    expect(scheduled.driver.phase).toBe("scheduled");
    expect(scheduled.status).toBe("live");
  });
});

describe("stable allocation", () => {
  it("allocates one generation and agent turn id for the first wake-worthy input", async () => {
    const { stub, descriptor } = freshRun();
    const result = await inRun(stub, (s) => {
      initializeSession(s, descriptor, 1_000);
      const first = appendTurn(s, turn("slack:E1"), 1_001);
      const driver = readDriver(s);
      return { first, driver, generation: readGeneration(s, driver.generationId as string) };
    });

    expect(result.first.scheduling).toMatchObject({ outcome: "allocated" });
    if (result.first.scheduling.outcome !== "allocated") throw new Error("unreachable");
    const { generationId, agentTurnId } = result.first.scheduling;

    expect(generationId).toMatch(/^gen:[0-9a-f-]{36}$/);
    // The Code Mode effect scope is derived from the generation, so every
    // retry of this work replays into the same effect ledger rows.
    expect(agentTurnId).toBe(`agent:${generationId}`);
    expect(result.driver.phase).toBe("scheduled");
    expect(result.generation?.state).toBe("scheduled");
    expect(result.generation?.firstInputSeq).toBe(result.first.event.seq);
    // Nothing is in the transcript yet, so the whole input is still pending.
    expect(result.generation?.includedThroughSeq).toBe(0);
  });

  it("reuses the generation for a duplicate input and for a second pending turn", async () => {
    const { stub, descriptor } = freshRun();
    const result = await inRun(stub, (s) => {
      initializeSession(s, descriptor, 1_000);
      const first = appendTurn(s, turn("slack:E1"), 1_001);
      const duplicate = appendTurn(s, turn("slack:E1"), 1_002);
      const second = appendTurn(s, turn("slack:E2"), 1_003);
      return {
        first,
        duplicate,
        second,
        generations: s.sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM agent_generations")
          .one().n,
        driver: readDriver(s),
      };
    });

    if (result.first.scheduling.outcome !== "allocated") throw new Error("unreachable");
    const generationId = result.first.scheduling.generationId;

    expect(result.duplicate.scheduling).toEqual({ outcome: "duplicate", generationId });
    expect(result.second.scheduling).toMatchObject({ outcome: "joined", generationId });
    expect(result.generations).toBe(1);
    expect(result.driver.pendingThroughSeq).toBe(result.second.event.seq);
  });

  it("allocates a different pair for a new input after settlement", async () => {
    const { stub, descriptor } = freshRun();
    const result = await inRun(stub, (s) => {
      initializeSession(s, descriptor, 1_000);
      const first = appendTurn(s, turn("slack:E1"), 1_001);
      const claim = claimGeneration(s, { now: 2_000 });
      if (claim.outcome !== "claimed") throw new Error("expected a claim");
      includePendingInput(s, claim.claim.fence);
      finalizeGeneration(s, claim.claim.fence, { kind: "completed" }, 3_000);
      const second = appendTurn(s, turn("slack:E2"), 4_000);
      return { first, second, driver: readDriver(s) };
    });

    if (result.first.scheduling.outcome !== "allocated") throw new Error("unreachable");
    if (result.second.scheduling.outcome !== "allocated") throw new Error("unreachable");
    // Invariant 8: deliberately repeating an action in a later turn must not be
    // deduplicated into the earlier turn's effect scope.
    expect(result.second.scheduling.generationId).not.toBe(result.first.scheduling.generationId);
    expect(result.second.scheduling.agentTurnId).not.toBe(result.first.scheduling.agentTurnId);
  });

  it("does not wake on the agent's own output or on a system note", async () => {
    const { stub, descriptor } = freshRun();
    const result = await inRun(stub, (s) => {
      initializeSession(s, descriptor, 1_000);
      const agent = appendTurn(
        s,
        turn("agent:1", { role: "assistant", source: "agent", content: "here is what I found" }),
        1_001,
      );
      const system = appendTurn(
        s,
        turn("system:1", { role: "system", source: "system", content: "retry notice" }),
        1_002,
      );
      return { agent, system, driver: readDriver(s), status: readState(s)?.status };
    });

    expect(result.agent.scheduling).toEqual({ outcome: "not_input" });
    expect(result.system.scheduling).toEqual({ outcome: "not_input" });
    expect(result.driver.phase).toBe("idle");
    // Still idle: one answer must not become an infinite conversation with itself.
    expect(result.status).toBe("idle");
  });

  it("stores but refuses to schedule input against an operator-config failure", async () => {
    const { stub, descriptor } = freshRun();
    const result = await inRun(stub, (s) => {
      initializeSession(s, descriptor, 1_000);
      appendTurn(s, turn("slack:E1"), 1_001);
      const claim = claimGeneration(s, { now: 2_000 });
      if (claim.outcome !== "claimed") throw new Error("expected a claim");
      finalizeGeneration(
        s,
        claim.claim.fence,
        {
          kind: "failed",
          state: "budget_exhausted",
          resumePolicy: "requires_operator_config",
          errorCode: "run_spend_cap",
        },
        3_000,
      );
      const failedGenerationId = readDriver(s).generationId;
      const blocked = appendTurn(s, turn("slack:E2"), 4_000);
      return {
        blocked,
        failedGenerationId,
        driver: readDriver(s),
        turns: listTurns(s).length,
        generations: s.sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM agent_generations")
          .one().n,
      };
    });

    expect(result.blocked.scheduling).toMatchObject({
      outcome: "blocked",
      policy: "requires_operator_config",
    });
    // The message is NOT dropped — it is above the settled watermark and any
    // legal resume will include it. It just cannot restart spending by itself.
    expect(result.turns).toBe(2);
    expect(result.driver.phase).toBe("failed");
    expect(result.driver.pendingThroughSeq).toBeGreaterThan(result.driver.settledThroughSeq);
    // No NEW generation was allocated, so nothing will claim and nothing will
    // spend. (The public status stays where the driver left it: deciding what a
    // customer sees after a failure belongs to the driver, in Task 3.)
    expect(result.driver.generationId).toBe(result.failedGenerationId);
    expect(result.generations).toBe(1);
  });

  it("lets an ordinary input resume a requires_input failure with a new generation", async () => {
    const { stub, descriptor } = freshRun();
    const result = await inRun(stub, (s) => {
      initializeSession(s, descriptor, 1_000);
      appendTurn(s, turn("slack:E1"), 1_001);
      const claim = claimGeneration(s, { now: 2_000 });
      if (claim.outcome !== "claimed") throw new Error("expected a claim");
      finalizeGeneration(
        s,
        claim.claim.fence,
        {
          kind: "failed",
          state: "refused",
          resumePolicy: "requires_input",
          errorCode: "refusal",
        },
        3_000,
      );
      return appendTurn(s, turn("slack:E2"), 4_000);
    });

    expect(result.scheduling.outcome).toBe("allocated");
  });
});

describe("claim fence", () => {
  it("claims once and refuses a second claimant while the lease is live", async () => {
    const { stub, descriptor } = freshRun();
    const result = await inRun(stub, (s) => {
      initializeSession(s, descriptor, 1_000);
      appendTurn(s, turn("slack:E1"), 1_001);
      const first = claimGeneration(s, { now: 2_000, leaseMs: 60_000 });
      const second = claimGeneration(s, { now: 2_100, leaseMs: 60_000 });
      return { first, second, driver: readDriver(s) };
    });

    expect(result.first.outcome).toBe("claimed");
    // A duplicate alarm and a concurrent kick cannot start a second stream.
    expect(result.second).toMatchObject({ outcome: "already_running", leaseExpiresAt: 62_000 });
    expect(result.driver.phase).toBe("running");
    expect(result.driver.attempt).toBe(1);
    expect(result.driver.claimEpoch).toBe(1);
  });

  it("reports nothing_scheduled on an idle driver", async () => {
    const { stub, descriptor } = freshRun();
    const outcome = await inRun(stub, (s) => {
      initializeSession(s, descriptor, 1_000);
      return claimGeneration(s, { now: 2_000 });
    });
    expect(outcome).toEqual({ outcome: "nothing_scheduled", phase: "idle" });
  });

  it("reclaims an expired lease with a higher epoch", async () => {
    const { stub, descriptor } = freshRun();
    const result = await inRun(stub, (s) => {
      initializeSession(s, descriptor, 1_000);
      appendTurn(s, turn("slack:E1"), 1_001);
      const first = claimGeneration(s, { now: 2_000, leaseMs: 10_000 });
      const second = claimGeneration(s, { now: 20_000, leaseMs: 10_000 });
      return { first, second };
    });

    if (result.first.outcome !== "claimed" || result.second.outcome !== "claimed") {
      throw new Error("expected both claims");
    }
    expect(result.second.claim.fence.generationId).toBe(result.first.claim.fence.generationId);
    expect(result.second.claim.fence.claimEpoch).toBe(result.first.claim.fence.claimEpoch + 1);
    expect(result.second.claim.attempt).toBe(2);
  });

  it("refuses every history-mutating call from a superseded claimant", async () => {
    const { stub, claim } = await claimedRun();

    const result = await inRun(stub, (s) => {
      const stale = claim.fence;
      // The lease expires and a successor takes over.
      const reclaim = claimGeneration(s, { now: 200_000, leaseMs: 60_000 });
      if (reclaim.outcome !== "claimed") throw new Error("expected a reclaim");

      return {
        fresh: reclaim.claim.fence,
        check: checkClaim(s, stale),
        heartbeat: heartbeat(s, stale, { now: 201_000 }),
        input: appendInputMessages(s, stale, {
          globalStep: 0,
          messages: [{ sourceEventSeq: 1, message: { role: "user", content: "late" } }],
          now: 201_000,
        }),
        step: checkpointStepMessages(s, stale, {
          globalStep: 0,
          messages: [{ role: "assistant", content: "late" }],
          now: 201_000,
        }),
        assistant: appendAssistantUpdate(
          s,
          stale,
          { generationId: stale.generationId, attempt: 1, batchSeq: 0, state: "streaming", delta: "late" },
          201_000,
        ),
        tool: appendAgentToolCallUpdate(
          s,
          stale,
          { id: "tool:late:0", callId: "late", name: "run_code", state: "running" },
          201_000,
        ),
        finalize: finalizeGeneration(s, stale, { kind: "completed" }, 201_000),
        transcript: readModelTranscript(s).length,
        events: listEvents(s, 0, 1_000).filter((e) => e.type === "assistant_update").length,
        toolCalls: listToolCalls(s).length,
        generation: readGeneration(s, stale.generationId),
      };
    });

    expect(result.fresh.claimEpoch).toBeGreaterThan(claim.fence.claimEpoch);
    expect(result.check).toEqual({ outcome: "stale_claim" });
    expect(result.heartbeat).toEqual({ outcome: "stale_claim" });
    expect(result.input).toEqual({ outcome: "stale_claim" });
    expect(result.step).toEqual({ outcome: "stale_claim" });
    expect(result.assistant).toEqual({ outcome: "stale_claim" });
    // Tool narration is conversational output too: an expired claimant must not
    // be able to report a capability into a run a successor now owns.
    expect(result.tool).toEqual({ outcome: "stale_claim" });
    expect(result.finalize).toEqual({ outcome: "stale_claim" });
    // Nothing it tried reached the durable record.
    expect(result.transcript).toBe(0);
    expect(result.events).toBe(0);
    expect(result.toolCalls).toBe(0);
    expect(result.generation?.state).toBe("running");
  });

  it("still records a superseded claimant's billed usage, exactly once", async () => {
    const { stub, claim } = await claimedRun();

    const result = await inRun(stub, (s) => {
      const stale = claim.fence;
      const reclaim = claimGeneration(s, { now: 200_000, leaseMs: 60_000 });
      if (reclaim.outcome !== "claimed") throw new Error("expected a reclaim");

      // The stale claimant's provider request had already been billed when its
      // lease ran out. The money is spent whether or not the answer was used.
      const first = recordStepUsage(s, usage(stale, { attempt: 1, globalStep: 0 }), 201_000);
      const replay = recordStepUsage(s, usage(stale, { attempt: 1, globalStep: 0 }), 201_500);
      // The successor's own step is a genuinely different billed call.
      const successor = recordStepUsage(
        s,
        usage(reclaim.claim.fence, { attempt: 2, globalStep: 0 }),
        202_000,
      );

      return {
        first,
        replay,
        successor,
        total: totalCostNanoUsd(s),
        generation: readGeneration(s, stale.generationId),
        transcript: readModelTranscript(s).length,
      };
    });

    expect(result.first.outcome).toBe("recorded");
    // Replaying the same step cannot double its cost.
    expect(result.replay).toEqual({ outcome: "duplicate", id: result.first.id });
    expect(result.successor.outcome).toBe("recorded");
    expect(result.successor.id).not.toBe(result.first.id);
    expect(result.total).toBe(8_400);
    expect(result.generation?.costNanoUsd).toBe(8_400);
    // And it still bought no influence over the conversation.
    expect(result.transcript).toBe(0);
  });

  it("refuses a claimant whose generation already settled, at the same epoch", async () => {
    const { stub, fence } = await claimedRun();

    const result = await inRun(stub, (s) => {
      includePendingInput(s, fence);
      const settle = finalizeGeneration(s, fence, { kind: "completed" }, 5_000);
      return {
        settle,
        check: checkClaim(s, fence),
        heartbeat: heartbeat(s, fence, { now: 5_100 }),
        assistant: appendAssistantUpdate(
          s,
          fence,
          { generationId: fence.generationId, attempt: 1, batchSeq: 9, state: "streaming", delta: "after" },
          5_100,
        ),
        finalizeAgain: finalizeGeneration(s, fence, { kind: "completed" }, 5_200),
      };
    });

    expect(result.settle.outcome).toBe("settled");
    // Same epoch, but the driver is idle: a late callback from the attempt that
    // just finished cannot append to a conversation that has ended.
    expect(result.check).toEqual({ outcome: "stale_claim" });
    expect(result.heartbeat).toEqual({ outcome: "stale_claim" });
    expect(result.assistant).toEqual({ outcome: "stale_claim" });
    expect(result.finalizeAgain).toMatchObject({ outcome: "already_settled" });
  });

  it("renews the lease for the current claimant", async () => {
    const { stub, fence } = await claimedRun();
    const result = await inRun(stub, (s) => ({
      beat: heartbeat(s, fence, { now: 30_000, leaseMs: 60_000 }),
      driver: readDriver(s),
    }));

    expect(result.beat).toEqual({ outcome: "renewed", leaseExpiresAt: 90_000 });
    expect(result.driver.lastHeartbeatAt).toBe(30_000);
  });
});

describe("model transcript", () => {
  it("inserts each input event exactly once, across replays", async () => {
    const { stub, fence } = await claimedRun();
    const result = await inRun(stub, (s) => {
      const seq = turnEventSeq(s, "slack:E1") as number;
      const first = appendInputMessages(s, fence, {
        globalStep: 0,
        messages: [{ sourceEventSeq: seq, message: { role: "user", content: "the deploy is stuck" } }],
        now: 3_000,
      });
      const replay = appendInputMessages(s, fence, {
        globalStep: 0,
        messages: [{ sourceEventSeq: seq, message: { role: "user", content: "the deploy is stuck" } }],
        now: 3_100,
      });
      return {
        first,
        replay,
        rows: s.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM model_messages").one().n,
        generation: readGeneration(s, fence.generationId),
      };
    });

    expect(result.first).toMatchObject({ outcome: "inserted", inserted: 1, skipped: 0 });
    expect(result.replay).toMatchObject({ outcome: "inserted", inserted: 0, skipped: 1 });
    expect(result.rows).toBe(1);
    expect(result.generation?.includedThroughSeq).toBe(result.first.outcome === "inserted"
      ? result.first.includedThroughSeq
      : -1);
  });

  it("allows many response rows even though inputs are unique by source seq", async () => {
    const { stub, fence } = await claimedRun();
    const result = await inRun(stub, (s) => {
      // SQLite treats NULLs as distinct in a unique index, so the once-only
      // rule binds inputs without constraining responses. Asserted, not assumed.
      const one = checkpointStepMessages(s, fence, {
        globalStep: 0,
        messages: [{ role: "assistant", content: "step one" }, { role: "tool", content: "result" }],
        now: 3_000,
      });
      const two = checkpointStepMessages(s, fence, {
        globalStep: 1,
        messages: [{ role: "assistant", content: "step two" }],
        now: 3_100,
      });
      return {
        one,
        two,
        nulls: s.sql
          .exec<{ n: number }>(
            "SELECT COUNT(*) AS n FROM model_messages WHERE source_event_seq IS NULL",
          )
          .one().n,
        generation: readGeneration(s, fence.generationId),
      };
    });

    expect(result.one).toEqual({ outcome: "checkpointed", inserted: 2 });
    expect(result.two).toEqual({ outcome: "checkpointed", inserted: 1 });
    expect(result.nulls).toBe(3);
    expect(result.generation?.stepCount).toBe(2);
  });

  it("checkpoints one step exactly once", async () => {
    const { stub, fence } = await claimedRun();
    const result = await inRun(stub, (s) => {
      checkpointStepMessages(s, fence, {
        globalStep: 0,
        messages: [{ role: "assistant", content: "tool call" }],
        now: 3_000,
      });
      // A crash between the provider response and this write replays the step.
      const replay = checkpointStepMessages(s, fence, {
        globalStep: 0,
        messages: [{ role: "assistant", content: "tool call" }],
        now: 3_100,
      });
      return { replay, rows: readModelTranscript(s).length };
    });

    expect(result.replay).toEqual({ outcome: "already_checkpointed" });
    expect(result.rows).toBe(1);
  });

  it("reads a bounded chronological transcript ending at the newest message", async () => {
    const { stub, fence } = await claimedRun();
    const result = await inRun(stub, (s) => {
      for (let step = 0; step < 12; step += 1) {
        checkpointStepMessages(s, fence, {
          globalStep: step,
          messages: [{ role: "assistant", content: `step ${step}` }],
          now: 3_000 + step,
        });
      }
      return { all: readModelTranscript(s, 100), bounded: readModelTranscript(s, 3) };
    });

    expect(result.all).toHaveLength(12);
    expect(result.all.map((entry) => entry.globalStep)).toEqual([...Array(12).keys()]);
    // Bounded reads keep the NEWEST context, in order — the opposite of the
    // Phase 08 listTurns() mistake.
    expect(result.bounded.map((entry) => entry.globalStep)).toEqual([9, 10, 11]);
    expect(result.bounded[2].message).toEqual({ role: "assistant", content: "step 11" });
  });
});

describe("assistant updates", () => {
  it("appends a batch and replays the same id without a second event", async () => {
    const { stub, fence } = await claimedRun();
    const result = await inRun(stub, (s) => {
      const before = latestSeq(s);
      const first = appendAssistantUpdate(
        s,
        fence,
        { generationId: fence.generationId, attempt: 1, batchSeq: 0, state: "streaming", delta: "hel" },
        3_000,
      );
      const replay = appendAssistantUpdate(
        s,
        fence,
        { generationId: fence.generationId, attempt: 1, batchSeq: 0, state: "streaming", delta: "hel" },
        3_100,
      );
      return { before, first, replay, after: latestSeq(s) };
    });

    if (result.first.outcome === "stale_claim" || result.replay.outcome === "stale_claim") {
      throw new Error("unexpected stale claim");
    }
    expect(result.first.outcome).toBe("appended");
    expect(result.replay.outcome).toBe("replayed");
    expect(result.replay.event.seq).toBe(result.first.event.seq);
    // Exactly one event was burned by the pair.
    expect(result.after).toBe(result.before + 1);
    expect(result.first.event.type).toBe("assistant_update");
  });

  it("broadcasts a batch once and a replay never, through the object", async () => {
    const { stub, fence } = await claimedRun();
    const sockets: string[] = [];
    const upgrade = await stub.fetch("https://run/ws", { headers: { Upgrade: "websocket" } });
    const ws = upgrade.webSocket!;
    ws.accept();
    ws.addEventListener("message", (event) => sockets.push(String(event.data)));

    const first = await stub.appendAssistantUpdate(fence, {
      generationId: fence.generationId,
      attempt: 1,
      batchSeq: 0,
      state: "streaming",
      delta: "partial",
    });
    const replay = await stub.appendAssistantUpdate(fence, {
      generationId: fence.generationId,
      attempt: 1,
      batchSeq: 0,
      state: "streaming",
      delta: "partial",
    });

    expect(first.outcome).toBe("appended");
    expect(replay.outcome).toBe("replayed");
    if (first.outcome === "stale_claim" || replay.outcome === "stale_claim") {
      throw new Error("unexpected stale claim");
    }
    expect(replay.event.seq).toBe(first.event.seq);

    // The customer must not be shown the same sentence twice because an alarm
    // was delivered twice.
    const delivered = sockets
      .map((raw) => JSON.parse(raw) as { type: string; event?: { type: string; seq: number } })
      .filter((frame) => frame.type === "event" && frame.event?.type === "assistant_update");
    expect(delivered).toHaveLength(1);
    expect(delivered[0].event?.seq).toBe(first.event.seq);

    ws.close();
  });

  it("derives the batch id from the generation, not from the caller", async () => {
    const { stub, fence } = await claimedRun();
    const event = await inRun(stub, (s) => {
      const result = appendAssistantUpdate(
        s,
        fence,
        { generationId: fence.generationId, attempt: 1, batchSeq: 4, state: "completed" },
        3_000,
      );
      if (result.outcome === "stale_claim") throw new Error("unexpected stale claim");
      return result.event;
    });

    expect(event.type).toBe("assistant_update");
    if (event.type !== "assistant_update") throw new Error("unreachable");
    expect(event.update.id).toBe(`assistant:${fence.generationId}:1:4`);
  });

  it("truncates a delta and an error rather than storing an unbounded payload", async () => {
    const { stub, fence } = await claimedRun();
    const event = await inRun(stub, (s) => {
      const result = appendAssistantUpdate(
        s,
        fence,
        {
          generationId: fence.generationId,
          attempt: 1,
          batchSeq: 0,
          state: "failed",
          delta: "x".repeat(50_000),
          error: "e".repeat(50_000),
        },
        3_000,
      );
      if (result.outcome === "stale_claim") throw new Error("unexpected stale claim");
      return result.event;
    });

    if (event.type !== "assistant_update") throw new Error("unreachable");
    expect(event.update.delta).toHaveLength(8_192);
    expect(event.update.error).toHaveLength(512);
  });

  it("drops anything the caller smuggled beside the known fields", async () => {
    const { stub, fence } = await claimedRun();
    const event = await inRun(stub, (s) => {
      const result = appendAssistantUpdate(
        s,
        fence,
        {
          generationId: fence.generationId,
          attempt: 1,
          batchSeq: 0,
          state: "streaming",
          delta: "safe",
          // A provider chunk that leaked into the call site.
          reasoning: "the customer is probably wrong",
          signature: "opaque",
        } as never,
        3_000,
      );
      if (result.outcome === "stale_claim") throw new Error("unexpected stale claim");
      return result.event;
    });

    if (event.type !== "assistant_update") throw new Error("unreachable");
    expect(JSON.stringify(event)).not.toContain("reasoning");
    expect(JSON.stringify(event)).not.toContain("probably wrong");
    expect(Object.keys(event.update).sort()).toEqual(
      ["attempt", "createdAt", "delta", "generationId", "id", "state"].sort(),
    );
  });

  it("rejects a malformed update instead of storing it", async () => {
    const { stub, fence } = await claimedRun();
    await expect(
      inRun(stub, (s) =>
        appendAssistantUpdate(
          s,
          fence,
          { generationId: fence.generationId, attempt: 1, batchSeq: 0, state: "thinking" as never },
          3_000,
        ),
      ),
    ).rejects.toThrow(/unknown assistant update state/);
  });
});

describe("settlement", () => {
  it("settles a generation and returns the driver to idle", async () => {
    const { stub, fence } = await claimedRun();
    const result = await inRun(stub, (s) => {
      includePendingInput(s, fence);
      const outcome = finalizeGeneration(s, fence, { kind: "completed" }, 5_000);
      return { outcome, driver: readDriver(s), generation: readGeneration(s, fence.generationId) };
    });

    expect(result.outcome).toMatchObject({ outcome: "settled", driverPhase: "idle" });
    expect(result.driver.phase).toBe("idle");
    expect(result.driver.generationId).toBeNull();
    expect(result.driver.settledThroughSeq).toBe(result.driver.pendingThroughSeq);
    expect(result.generation?.state).toBe("completed");
    expect(result.generation?.finishedAt).toBe(5_000);
  });

  it("continues the same generation when input arrived while it was answering", async () => {
    const { stub, fence } = await claimedRun();
    const result = await inRun(stub, (s) => {
      const seq = turnEventSeq(s, "slack:E1") as number;
      appendInputMessages(s, fence, {
        globalStep: 0,
        messages: [{ sourceEventSeq: seq, message: { role: "user", content: "the deploy is stuck" } }],
        now: 3_000,
      });
      // A late steer, after the model already had its input.
      appendTurn(s, turn("steer:r-1", { source: "human_steer", content: "actually check staging" }), 4_000);
      const outcome = finalizeGeneration(s, fence, { kind: "completed" }, 5_000);
      return { outcome, driver: readDriver(s), generation: readGeneration(s, fence.generationId) };
    });

    // The SAME generation continues: its effect scope and transcript stay
    // coherent, and the stale final is not appended.
    expect(result.outcome).toMatchObject({ outcome: "continued", generationId: fence.generationId });
    expect(result.driver.phase).toBe("scheduled");
    expect(result.driver.generationId).toBe(fence.generationId);
    expect(result.generation?.state).toBe("scheduled");
  });

  it("records a failure with its resume policy and leaves the watermark alone", async () => {
    const { stub, fence } = await claimedRun();
    const result = await inRun(stub, (s) => {
      const before = readDriver(s);
      const outcome = finalizeGeneration(
        s,
        fence,
        {
          kind: "failed",
          state: "refused",
          resumePolicy: "requires_input",
          errorCode: "refusal",
          errorMessage: "the model declined",
        },
        5_000,
      );
      return { before, outcome, driver: readDriver(s), generation: readGeneration(s, fence.generationId) };
    });

    expect(result.outcome).toMatchObject({ outcome: "settled", driverPhase: "failed" });
    expect(result.driver.resumePolicy).toBe("requires_input");
    expect(result.driver.lastErrorCode).toBe("refusal");
    // The inputs it failed to answer are still unanswered.
    expect(result.driver.settledThroughSeq).toBe(result.before.settledThroughSeq);
    expect(result.generation?.state).toBe("refused");
  });

  it("reschedules a retry as the same generation and a later attempt", async () => {
    const { stub, fence } = await claimedRun();
    const result = await inRun(stub, (s) => {
      const outcome = finalizeGeneration(
        s,
        fence,
        { kind: "retry", errorCode: "provider_timeout" },
        5_000,
      );
      const next = claimGeneration(s, { now: 6_000 });
      return { outcome, next, driver: readDriver(s) };
    });

    expect(result.outcome).toMatchObject({ outcome: "rescheduled", generationId: fence.generationId });
    if (result.next.outcome !== "claimed") throw new Error("expected a claim");
    expect(result.next.claim.generationId).toBe(fence.generationId);
    expect(result.next.claim.attempt).toBe(2);
    expect(result.next.claim.fence.claimEpoch).toBe(fence.claimEpoch + 1);
  });
});

describe("turn pagination", () => {
  it("does not silently exclude the newest steer on a long run", async () => {
    const { stub, descriptor } = freshRun();
    const result = await inRun(stub, (s) => {
      initializeSession(s, descriptor, 1_000);
      for (let i = 0; i < 1_010; i += 1) {
        appendTurn(s, turn(`t-${i}`, { content: `message ${i}` }), 1_001 + i);
      }
      const newest = turnEventSeq(s, "t-1009") as number;
      return {
        cursor: latestSeq(s),
        oldest: listTurns(s, 1_000),
        recent: listRecentTurns(s, 50),
        after: listTurnsAfter(s, newest - 1, 50),
        pending: listPendingInputTurns(s, newest - 1, 50),
      };
    });

    // Over a thousand events, which is where the Phase 08 bug bites.
    expect(result.cursor).toBeGreaterThan(1_000);

    // The shipped behaviour, unchanged: oldest-first, and the newest steer is
    // NOT in it. This is exactly why the model must not read history this way.
    expect(result.oldest).toHaveLength(1_000);
    expect(result.oldest[0].id).toBe("t-0");
    expect(result.oldest.some((t) => t.id === "t-1009")).toBe(false);

    // The fix: the newest turns, in conversational order.
    expect(result.recent).toHaveLength(50);
    expect(result.recent[result.recent.length - 1].id).toBe("t-1009");
    expect(result.recent.map((t) => t.id)).toEqual(
      [...result.recent].sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2))).map((t) => t.id),
    );

    // And the cursor read the loop actually uses.
    expect(result.after.map((t) => t.id)).toEqual(["t-1009"]);
    expect(result.pending.map((t) => t.id)).toEqual(["t-1009"]);
  }, 60_000);

  it("excludes the agent's own turns from pending input", async () => {
    const { stub, descriptor } = freshRun();
    const result = await inRun(stub, (s) => {
      initializeSession(s, descriptor, 1_000);
      appendTurn(s, turn("slack:E1"), 1_001);
      appendTurn(s, turn("agent:1", { role: "assistant", source: "agent", content: "answer" }), 1_002);
      appendTurn(s, turn("slack:E2"), 1_003);
      return { all: listTurnsAfter(s, 0, 50), pending: listPendingInputTurns(s, 0, 50) };
    });

    expect(result.all.map((t) => t.id)).toEqual(["slack:E1", "agent:1", "slack:E2"]);
    expect(result.pending.map((t) => t.id)).toEqual(["slack:E1", "slack:E2"]);
  });
});

describe("run index revisions", () => {
  it("advances the revision for a summary change that emits no run event", async () => {
    const { stub, descriptor } = freshRun();
    const result = await inRun(stub, (s) => {
      initializeSession(s, descriptor, 1_000);
      const before = { revision: latestRunIndexRevision(s), seq: latestSeq(s) };
      const summary = setSummary(s, "chasing a stuck deploy", 2_000);
      return { before, summary, after: latestRunIndexRevision(s), seq: latestSeq(s) };
    });

    expect(result.summary.changed).toBe(true);
    // The counter cannot be stream_events.seq: no event was emitted at all.
    expect(result.seq).toBe(result.before.seq);
    expect(result.after?.revision).toBeGreaterThan(result.before.revision?.revision ?? 0);
    expect(result.after?.summary).toBe("chasing a stuck deploy");
  });

  it("orders two same-millisecond lifecycle changes by revision", async () => {
    const { stub, descriptor } = freshRun();
    const result = await inRun(stub, (s) => {
      initializeSession(s, descriptor, 1_000);
      // Identical timestamps. A projector keyed on time would tie here and let
      // the loser win.
      setSummary(s, "first", 5_000);
      const first = latestRunIndexRevision(s);
      setStatus(s, "live", 5_000);
      const second = latestRunIndexRevision(s);
      setSummary(s, "second", 5_000);
      const third = latestRunIndexRevision(s);
      return { first, second, third };
    });

    expect(result.first?.updatedAt).toBe(result.second?.updatedAt);
    expect(result.second!.revision).toBeGreaterThan(result.first!.revision);
    expect(result.third!.revision).toBeGreaterThan(result.second!.revision);
    // Every revision carries the FULL bundle, so status and summary cannot be
    // projected out of step with each other.
    expect(result.third).toMatchObject({ status: "live", summary: "second" });
  });

  it("coalesces recency-only activity instead of one revision per event", async () => {
    const { stub, descriptor } = freshRun();
    const result = await inRun(stub, (s) => {
      initializeSession(s, descriptor, 1_000);
      appendTurn(s, turn("slack:E1"), 1_001);
      const claim = claimGeneration(s, { now: 1_002 });
      if (claim.outcome !== "claimed") throw new Error("expected a claim");
      const start = latestRunIndexRevision(s)!.revision;
      for (let batch = 0; batch < 20; batch += 1) {
        appendAssistantUpdate(
          s,
          claim.claim.fence,
          {
            generationId: claim.claim.generationId,
            attempt: 1,
            batchSeq: batch,
            state: "streaming",
            delta: `chunk ${batch}`,
          },
          1_100 + batch,
        );
      }
      return { start, end: latestRunIndexRevision(s)!.revision };
    });

    // Twenty batches, at most one revision: never one D1 write per chunk.
    expect(result.end - result.start).toBeLessThanOrEqual(1);
  });
});
