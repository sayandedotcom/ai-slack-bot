import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { chatRunKey } from "../src/run/keys";
import { createOrGetRun } from "../src/run/repository";
import {
  appendTurn,
  claimGeneration,
  countPendingProjectionJobs,
  initializeSession,
  listPendingUsageProjections,
  readStepUsage,
  recordStepUsage,
  type RunDescriptor,
} from "../src/run/session";
import {
  normalizeUsage,
  projectPendingUsage,
  projectStepUsageToD1,
  ZERO_USAGE,
} from "../src/agent/usage";
import type { ClaimFence, StepUsageInput } from "../src/agent/contracts";

/**
 * Model-step telemetry: the local ledger is the authority and D1 is its
 * projection, so a D1 outage can only delay a dashboard number — it can never
 * be a reason to ask the provider for the same answer twice.
 */

async function freshClaimedRun() {
  const key = chatRunKey(crypto.randomUUID());
  const record = await createOrGetRun(env.DB, {
    key,
    origin: "chat",
    channelId: null,
    threadTs: null,
  });
  const stub = env.RUNS.get(env.RUNS.idFromName(key));
  const descriptor: RunDescriptor = {
    runId: record.id,
    key,
    origin: "chat",
    channelId: null,
    threadTs: null,
  };

  const fence = await runInDurableObject(stub, (_instance, state) => {
    initializeSession(state.storage, descriptor, 1_000);
    appendTurn(
      state.storage,
      { id: "slack:E1", role: "user", source: "customer", content: "the deploy is stuck" },
      1_001,
    );
    const claim = claimGeneration(state.storage, { now: 2_000, leaseMs: 60_000 });
    if (claim.outcome !== "claimed") throw new Error("expected a claim");
    return claim.claim.fence;
  });

  return { runId: record.id, key, stub, fence };
}

function inRun<T>(stub: DurableObjectStub, fn: (storage: DurableObjectStorage) => T): Promise<T> {
  return runInDurableObject(stub, (_instance, state) => fn(state.storage));
}

function usage(fence: ClaimFence, overrides: Partial<StepUsageInput> = {}): StepUsageInput {
  return {
    generationId: fence.generationId,
    agentTurnId: `agent:${fence.generationId}`,
    attempt: 1,
    globalStep: 0,
    provider: "anthropic",
    model: "claude-fable",
    providerRequestId: "req_123",
    gatewayLogId: "log_456",
    usage: {
      inputTokens: 1_000,
      noCacheTokens: 200,
      cacheReadTokens: 700,
      cacheWriteTokens: 100,
      outputTokens: 350,
      reasoningTokens: 120,
      totalTokens: 2_150,
    },
    costNanoUsd: 8_400_000,
    latencyMs: 1_800,
    finishReason: "tool_calls",
    rawFinishReason: "tool_use",
    ...overrides,
  };
}

/** A D1 binding that is simply down. */
const brokenDb = {
  prepare() {
    throw new Error("D1_ERROR: network");
  },
} as unknown as D1Database;

describe("usage normalization", () => {
  it("coerces every token class to a non-negative integer", () => {
    const normalized = normalizeUsage({
      inputTokens: 10.6,
      noCacheTokens: -5,
      cacheReadTokens: "700",
      cacheWriteTokens: null,
      outputTokens: 20,
      reasoningTokens: Number.NaN,
      totalTokens: Number.POSITIVE_INFINITY,
    });

    expect(normalized.inputTokens).toBe(11);
    expect(normalized.noCacheTokens).toBe(0);
    expect(normalized.cacheReadTokens).toBe(0);
    expect(normalized.cacheWriteTokens).toBe(0);
    expect(normalized.outputTokens).toBe(20);
    expect(normalized.reasoningTokens).toBe(0);
    // Recomputed rather than left at zero, so the column is self-consistent.
    expect(normalized.totalTokens).toBe(31);
  });

  it("survives a provider that sends nothing usable", () => {
    expect(normalizeUsage(undefined)).toEqual(ZERO_USAGE);
    expect(normalizeUsage("nonsense")).toEqual(ZERO_USAGE);
    // A changed provider shape must not lose the billed row entirely.
    expect(normalizeUsage({ totally: "different" })).toEqual(ZERO_USAGE);
  });

  it("keeps a supplied total instead of second-guessing the provider", () => {
    const normalized = normalizeUsage({ inputTokens: 5, outputTokens: 5, totalTokens: 99 });
    expect(normalized.totalTokens).toBe(99);
  });
});

describe("local usage ledger", () => {
  it("reports whether it created the row and refuses to double a replayed step", async () => {
    const { stub, fence } = await freshClaimedRun();
    const result = await inRun(stub, (s) => ({
      first: recordStepUsage(s, usage(fence), 3_000),
      replay: recordStepUsage(s, usage(fence), 3_100),
      rows: listPendingUsageProjections(s, 10),
    }));

    expect(result.first.outcome).toBe("recorded");
    expect(result.replay).toEqual({ outcome: "duplicate", id: result.first.id });
    expect(result.first.id).toBe(`usage:${fence.generationId}:1:0`);
    expect(result.rows).toHaveLength(1);
  });

  it("treats a different attempt or step as a distinct billed call", async () => {
    const { stub, fence } = await freshClaimedRun();
    const result = await inRun(stub, (s) => ({
      step0: recordStepUsage(s, usage(fence, { globalStep: 0 }), 3_000),
      step1: recordStepUsage(s, usage(fence, { globalStep: 1 }), 3_100),
      attempt2: recordStepUsage(s, usage(fence, { attempt: 2, globalStep: 0 }), 3_200),
      pending: listPendingUsageProjections(s, 10).length,
    }));

    expect(result.step0.outcome).toBe("recorded");
    expect(result.step1.outcome).toBe("recorded");
    // A retry after a crash really did buy a second provider request.
    expect(result.attempt2.outcome).toBe("recorded");
    expect(result.pending).toBe(3);
  });

  it("refuses a fractional or negative cost rather than storing it", async () => {
    const { stub, fence } = await freshClaimedRun();
    await expect(
      inRun(stub, (s) => recordStepUsage(s, usage(fence, { costNanoUsd: -1 }), 3_000)),
    ).rejects.toThrow(/non-negative integer/);
    await expect(
      inRun(stub, (s) => recordStepUsage(s, usage(fence, { costNanoUsd: 0.5 }), 3_000)),
    ).rejects.toThrow(/non-negative integer/);
  });
});

describe("d1 projection", () => {
  it("inserts once and reports a replay as a duplicate", async () => {
    const { stub, runId, fence } = await freshClaimedRun();
    const record = await inRun(stub, (s) => {
      const written = recordStepUsage(s, usage(fence), 3_000);
      return readStepUsage(s, written.id)!;
    });

    const first = await projectStepUsageToD1(env.DB, runId, record);
    const second = await projectStepUsageToD1(env.DB, runId, record);

    expect(first).toEqual({ outcome: "inserted" });
    expect(second).toEqual({ outcome: "duplicate" });

    const row = await env.DB.prepare("SELECT * FROM agent_model_calls WHERE id = ?")
      .bind(record.id)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      run_id: runId,
      generation_id: fence.generationId,
      attempt: 1,
      step_index: 0,
      input_tokens: 1_000,
      cache_read_tokens: 700,
      cache_write_tokens: 100,
      output_tokens: 350,
      reasoning_tokens: 120,
      total_tokens: 2_150,
      cost_nano_usd: 8_400_000,
      finish_reason: "tool_calls",
      raw_finish_reason: "tool_use",
    });
  });

  it("stores no prompt, completion, reasoning or tool body", async () => {
    const columns = await env.DB.prepare("PRAGMA table_info(agent_model_calls)").all<{
      name: string;
    }>();
    const names = (columns.results ?? []).map((c) => c.name);

    for (const banned of [
      "prompt",
      "completion",
      "messages",
      "request_json",
      "response_json",
      "reasoning",
      "thinking",
      "tool_input",
      "tool_output",
    ]) {
      expect(names).not.toContain(banned);
    }
    // reasoning_TOKENS is a count, which is the only reasoning fact telemetry keeps.
    expect(names).toContain("reasoning_tokens");
  });

  it("marks a projected row and drains the pending list", async () => {
    const { stub, runId, fence } = await freshClaimedRun();
    await inRun(stub, (s) => recordStepUsage(s, usage(fence), 3_000));

    const drained = await runInDurableObject(stub, (_instance, state) =>
      projectPendingUsage(state.storage, env.DB, runId),
    );

    expect(drained).toMatchObject({ projected: 1, failed: 0, pending: 0 });
    const after = await inRun(stub, (s) => listPendingUsageProjections(s, 10));
    expect(after).toHaveLength(0);
  });

  it("leaves the local row pending when d1 is down, without throwing", async () => {
    const { stub, runId, fence } = await freshClaimedRun();
    await inRun(stub, (s) => recordStepUsage(s, usage(fence), 3_000));

    const drained = await runInDurableObject(stub, (_instance, state) =>
      projectPendingUsage(state.storage, brokenDb, runId),
    );

    // Reported, not thrown: the driver's next decision must never depend on
    // whether telemetry reached D1.
    expect(drained.failed).toBe(1);
    expect(drained.projected).toBe(0);
    expect(drained.pending).toBe(1);

    const state = await inRun(stub, (s) => ({
      pending: listPendingUsageProjections(s, 10).length,
      jobs: countPendingProjectionJobs(s, "d1_usage"),
    }));
    expect(state.pending).toBe(1);
    expect(state.jobs).toBe(1);

    // And it still delivers once D1 comes back — with no second model request
    // anywhere in that story.
    const recovered = await runInDurableObject(stub, (_instance, doState) =>
      projectPendingUsage(doState.storage, env.DB, runId, { now: Date.now() + 60_000 }),
    );
    expect(recovered).toMatchObject({ projected: 1, pending: 0 });
  });
});

describe("0006 migration properties", () => {
  it("has no migration number collision and does not reach into phase 11", () => {
    const numbers = env.TEST_MIGRATIONS.map((migration) => migration.name.slice(0, 4));
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers).toContain("0006");
    // Phase 11's approvals migration is 0007 and is not this task's to write.
    expect(numbers).not.toContain("0007");
  });

  it("enforces model-step uniqueness in d1, not only locally", async () => {
    const { runId, fence } = await freshClaimedRun();
    const insert = (id: string) =>
      env.DB.prepare(
        `INSERT INTO agent_model_calls
           (id, run_id, generation_id, agent_turn_id, attempt, step_index, provider, model,
            input_tokens, no_cache_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
            reasoning_tokens, total_tokens, cost_nano_usd, latency_ms, created_at)
         VALUES (?, ?, ?, ?, 1, 0, 'anthropic', 'claude-fable', 1, 0, 0, 0, 1, 0, 2, 10, 5, 1)`,
      )
        .bind(id, runId, fence.generationId, `agent:${fence.generationId}`)
        .run();

    await insert("usage:a");
    // Same (generation, attempt, step) under a different id is still one step.
    await expect(insert("usage:b")).rejects.toThrow();
  });

  it("refuses negative token and cost values", async () => {
    const { runId, fence } = await freshClaimedRun();
    await expect(
      env.DB.prepare(
        `INSERT INTO agent_model_calls
           (id, run_id, generation_id, agent_turn_id, attempt, step_index, provider, model,
            input_tokens, no_cache_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
            reasoning_tokens, total_tokens, cost_nano_usd, latency_ms, created_at)
         VALUES (?, ?, ?, ?, 1, 0, 'anthropic', 'claude-fable', 1, 0, 0, 0, 1, 0, 2, -10, 5, 1)`,
      )
        .bind(`usage:neg:${crypto.randomUUID()}`, runId, fence.generationId, "agent:x")
        .run(),
    ).rejects.toThrow();
  });

  it("keeps one memory episode per run generation", async () => {
    const { runId, fence } = await freshClaimedRun();
    const insert = (id: string) =>
      env.DB.prepare(
        `INSERT INTO agent_memory_outbox
           (id, run_id, generation_id, graph_id, episode_json, source_json, state, attempts,
            next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, 'graph', '{}', '[]', 'pending', 0, 1, 1, 1)`,
      )
        .bind(id, runId, fence.generationId)
        .run();

    await insert(`memory:${runId}:${fence.generationId}`);
    await expect(insert(`memory:other:${crypto.randomUUID()}`)).rejects.toThrow();
  });

  it("gives runs a projection cursor that starts at zero", async () => {
    const { runId } = await freshClaimedRun();
    const row = await env.DB.prepare("SELECT projection_seq FROM runs WHERE id = ?")
      .bind(runId)
      .first<{ projection_seq: number }>();
    expect(row?.projection_seq).toBe(0);
  });

  it("declares its delete policy explicitly rather than cascading by accident", async () => {
    const schema = await env.DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('agent_model_calls', 'agent_memory_outbox')",
    ).all<{ name: string; sql: string }>();

    expect(schema.results).toHaveLength(2);
    for (const table of schema.results ?? []) {
      expect(table.sql).toContain("FOREIGN KEY (run_id) REFERENCES runs(id)");
      // No implicit cascade: deleting a run must not silently erase its billing
      // history or its undelivered memory work.
      expect(table.sql).not.toContain("ON DELETE CASCADE");
      expect(table.sql).not.toContain("ON DELETE SET NULL");
    }
  });

  it("maps a memory episode back to its exact sources", async () => {
    const episodeUuid = crypto.randomUUID();
    const insert = (index: number) =>
      env.DB.prepare(
        `INSERT INTO memory_episode_sources
           (episode_uuid, source_index, source_kind, message_event_id, run_id, turn_id, permalink, created_at)
         VALUES (?, ?, 'slack_message', 'Ev1', NULL, NULL, 'https://slack.com/archives/C1/p1', 1)`,
      )
        .bind(episodeUuid, index)
        .run();

    await insert(0);
    await insert(1);
    // The pair is the primary key, so a redelivered projection cannot duplicate
    // a citation.
    await expect(insert(1)).rejects.toThrow();

    const rows = await env.DB.prepare(
      "SELECT permalink FROM memory_episode_sources WHERE episode_uuid = ?",
    )
      .bind(episodeUuid)
      .all<{ permalink: string }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results?.[0].permalink).toBe("https://slack.com/archives/C1/p1");
  });

  it("rejects an unknown source kind", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO memory_episode_sources
           (episode_uuid, source_index, source_kind, created_at)
         VALUES (?, 0, 'guesswork', 1)`,
      )
        .bind(crypto.randomUUID())
        .run(),
    ).rejects.toThrow();
  });
});
