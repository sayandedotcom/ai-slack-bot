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
import type { ClaimFence, NormalizedUsage, StepUsageInput } from "../src/agent/contracts";
import type { LanguageModelUsage } from "ai";
import {
  costNanoUsd,
  evaluateSpendGuard,
  FABLE_5_MODEL_ID,
  FABLE_5_PRICES,
  formatNanoUsd,
  isPricedModel,
  normalizeSdkUsage,
  pricesFor,
  UnknownModelPriceError,
} from "../src/agent/cost";
import { gatewayHeaders } from "../src/agent/gateway";
import {
  GATEWAY_MAX_ATTEMPTS,
  GENERATION_SPEND_CAP_NANO_USD,
  MAX_OUTPUT_TOKENS_PER_STEP,
  NANO_USD_PER_USD,
  RUN_SPEND_CAP_NANO_USD,
} from "../src/agent/limits";

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
  it("has no migration number collision, and 0006 is still the agent-loop one", () => {
    const numbers = env.TEST_MIGRATIONS.map((migration) => migration.name.slice(0, 4));
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers).toContain("0006");
    expect(env.TEST_MIGRATIONS.find((migration) => migration.name.startsWith("0006"))?.name).toContain(
      "agent_loop",
    );
    // This assertion used to read `expect(numbers).not.toContain("0007")`,
    // pinning that Phase 10 had not reached into Phase 11's migration number.
    // Phase 11 Task 1 then wrote `0007_approvals.sql`, so the guard had done
    // its job and outlived it. What is worth keeping is the uniqueness of the
    // prefixes above and the fact that NOBODY renumbered 0006 out from under
    // the applied remote database — an applied migration's number is frozen.
    expect(numbers).toContain("0007");
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

// ---------------------------------------------------------------------------
// Task 5: the price table, the AI SDK usage adapter, and the pre-step guard.
// ---------------------------------------------------------------------------

/** Build an installed-shape `LanguageModelUsage` without repeating the nesting. */
function sdkUsage(
  overrides: {
    inputTokens?: number;
    noCacheTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    outputTokens?: number;
    textTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
  } = {},
): LanguageModelUsage {
  return {
    inputTokens: overrides.inputTokens,
    inputTokenDetails: {
      noCacheTokens: overrides.noCacheTokens,
      cacheReadTokens: overrides.cacheReadTokens,
      cacheWriteTokens: overrides.cacheWriteTokens,
    },
    outputTokens: overrides.outputTokens,
    outputTokenDetails: {
      textTokens: overrides.textTokens,
      reasoningTokens: overrides.reasoningTokens,
    },
    totalTokens: overrides.totalTokens,
  };
}

function tokens(overrides: Partial<NormalizedUsage> = {}): NormalizedUsage {
  return { ...ZERO_USAGE, ...overrides };
}

describe("fable price table", () => {
  it("holds the reviewed prices as integer nano-USD per token", () => {
    expect(FABLE_5_PRICES).toEqual({
      input: 10_000,
      cacheWrite5m: 12_500,
      cacheWrite1h: 20_000,
      cacheRead: 1_000,
      output: 50_000,
    });
    // $10.00 per million uncached input tokens, and so on down the table.
    expect(FABLE_5_PRICES.input * 1_000_000).toBe(10 * NANO_USD_PER_USD);
    expect(FABLE_5_PRICES.cacheWrite5m * 1_000_000).toBe(12.5 * NANO_USD_PER_USD);
    expect(FABLE_5_PRICES.cacheWrite1h * 1_000_000).toBe(20 * NANO_USD_PER_USD);
    expect(FABLE_5_PRICES.cacheRead * 1_000_000).toBe(1 * NANO_USD_PER_USD);
    expect(FABLE_5_PRICES.output * 1_000_000).toBe(50 * NANO_USD_PER_USD);
  });

  it("stores every price as an integer, never a floating-point dollar amount", () => {
    for (const price of Object.values(FABLE_5_PRICES)) {
      expect(Number.isInteger(price)).toBe(true);
    }
  });

  it("fails closed on an unknown model instead of applying fable's rate", () => {
    expect(isPricedModel(FABLE_5_MODEL_ID)).toBe(true);
    expect(isPricedModel("claude-fable-6")).toBe(false);

    for (const unknown of ["claude-fable-6", "claude-sonnet-4", "", "gpt-5"]) {
      expect(() => pricesFor(unknown)).toThrow(UnknownModelPriceError);
      expect(() => costNanoUsd({ modelId: unknown, usage: tokens({ inputTokens: 1_000 }) })).toThrow(
        UnknownModelPriceError,
      );
    }
  });

  it("cannot be tricked into a price by a prototype key", () => {
    expect(() => pricesFor("constructor")).toThrow(UnknownModelPriceError);
    expect(() => pricesFor("toString")).toThrow(UnknownModelPriceError);
  });

  it("even a refused, unbilled step refuses to price an unknown model", () => {
    expect(() =>
      costNanoUsd({ modelId: "claude-fable-6", usage: tokens(), billing: "none" }),
    ).toThrow(UnknownModelPriceError);
  });
});

describe("ai sdk usage adapter", () => {
  it("reads the installed flat LanguageModelUsage shape, not the nested provider one", () => {
    const normalized = normalizeSdkUsage(
      sdkUsage({
        inputTokens: 1_000,
        noCacheTokens: 200,
        cacheReadTokens: 700,
        cacheWriteTokens: 100,
        outputTokens: 350,
        textTokens: 230,
        reasoningTokens: 120,
        totalTokens: 1_350,
      }),
    );

    expect(normalized).toEqual({
      inputTokens: 1_000,
      noCacheTokens: 200,
      cacheReadTokens: 700,
      cacheWriteTokens: 100,
      outputTokens: 350,
      reasoningTokens: 120,
      totalTokens: 1_350,
    });
  });

  it("records zero for every unreported field, which means none", () => {
    // `undefined` is the SDK's way of saying the provider reported nothing for
    // that class. Every field is a COUNT, so unreported and none are the same
    // number — and the row survives to record that the money was spent.
    expect(normalizeSdkUsage(sdkUsage())).toEqual(ZERO_USAGE);
    expect(normalizeSdkUsage(undefined)).toEqual(ZERO_USAGE);
  });

  it("recomputes a missing total without double-counting the detail subsets", () => {
    const normalized = normalizeSdkUsage(
      sdkUsage({
        inputTokens: 1_000,
        noCacheTokens: 200,
        cacheReadTokens: 700,
        cacheWriteTokens: 100,
        outputTokens: 350,
        reasoningTokens: 120,
      }),
    );
    // 1,000 + 350. NOT 1,000 + 200 + 700 + 100 + 350, and not + reasoning.
    expect(normalized.totalTokens).toBe(1_350);
  });

  it("coerces negative, fractional and non-finite counts to safe integers", () => {
    const normalized = normalizeSdkUsage(
      sdkUsage({
        inputTokens: 10.6,
        noCacheTokens: -5,
        cacheReadTokens: Number.NaN,
        cacheWriteTokens: Number.POSITIVE_INFINITY,
        outputTokens: 20.4,
      }),
    );
    expect(normalized).toMatchObject({
      inputTokens: 11,
      noCacheTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 20,
    });
    for (const value of Object.values(normalized)) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it("survives a large but valid response", () => {
    const normalized = normalizeSdkUsage(
      sdkUsage({ inputTokens: 200_000, cacheReadTokens: 190_000, outputTokens: 8_192 }),
    );
    expect(normalized.inputTokens).toBe(200_000);
    expect(normalized.totalTokens).toBe(208_192);
  });
});

describe("step cost", () => {
  const model = FABLE_5_MODEL_ID;

  it("costs a zero-token step at zero", () => {
    expect(costNanoUsd({ modelId: model, usage: tokens() }).totalNanoUsd).toBe(0);
  });

  it("costs exactly one token of each class at its own rate", () => {
    const oneEach = costNanoUsd({
      modelId: model,
      usage: tokens({
        inputTokens: 3,
        noCacheTokens: 1,
        cacheReadTokens: 1,
        cacheWriteTokens: 1,
        outputTokens: 1,
      }),
    });
    // 10,000 + 1,000 + 12,500 + 50,000. Nothing left unclassified.
    expect(oneEach.unclassifiedInputTokens).toBe(0);
    expect(oneEach.totalNanoUsd).toBe(73_500);
  });

  it("bills a 1-hour cache write at the higher rate when that ttl was used", () => {
    const usage5m = costNanoUsd({
      modelId: model,
      usage: tokens({ inputTokens: 100, cacheWriteTokens: 100 }),
    });
    const usage1h = costNanoUsd({
      modelId: model,
      usage: tokens({ inputTokens: 100, cacheWriteTokens: 100 }),
      cacheWriteTtl: "1h",
    });
    expect(usage5m.totalNanoUsd).toBe(100 * 12_500);
    expect(usage1h.totalNanoUsd).toBe(100 * 20_000);
  });

  it("does not add inputTokens on top of its own detail subsets", () => {
    // The whole 1,000 is classified, so the ONLY charge is the three classes.
    const fullyClassified = costNanoUsd({
      modelId: model,
      usage: tokens({
        inputTokens: 1_000,
        noCacheTokens: 200,
        cacheReadTokens: 700,
        cacheWriteTokens: 100,
      }),
    });
    expect(fullyClassified.unclassifiedInputTokens).toBe(0);
    expect(fullyClassified.unclassifiedInputNanoUsd).toBe(0);
    expect(fullyClassified.totalNanoUsd).toBe(200 * 10_000 + 700 * 1_000 + 100 * 12_500);

    // The naive double-count would have charged all 1,000 at the input rate
    // AGAIN on top of that. Prove we are strictly below it.
    expect(fullyClassified.totalNanoUsd).toBeLessThan(
      1_000 * 10_000 + 200 * 10_000 + 700 * 1_000 + 100 * 12_500,
    );
  });

  it("charges only the unclassified remainder of input", () => {
    const partial = costNanoUsd({
      modelId: model,
      usage: tokens({ inputTokens: 1_000, cacheReadTokens: 600 }),
    });
    // 600 read at 1,000; the other 400 at the plain input rate. Not 1,000 + 600.
    expect(partial.unclassifiedInputTokens).toBe(400);
    expect(partial.totalNanoUsd).toBe(600 * 1_000 + 400 * 10_000);
  });

  it("treats total input as uncached when the provider classifies nothing", () => {
    const noDetails = costNanoUsd({ modelId: model, usage: tokens({ inputTokens: 1_000 }) });
    // The dangerous alternative is recording a free request.
    expect(noDetails.totalNanoUsd).toBe(1_000 * 10_000);
    expect(noDetails.totalNanoUsd).toBeGreaterThan(0);
  });

  it("never charges a negative remainder when classified input exceeds the total", () => {
    // Anthropic's raw wire format reports input_tokens EXCLUDING cache tokens.
    // If an adapter change ever leaks that through, each class is still
    // charged exactly once and nothing is subtracted.
    const raw = costNanoUsd({
      modelId: model,
      usage: tokens({ inputTokens: 200, noCacheTokens: 200, cacheReadTokens: 700 }),
    });
    expect(raw.unclassifiedInputTokens).toBe(0);
    expect(raw.totalNanoUsd).toBe(200 * 10_000 + 700 * 1_000);
    expect(raw.totalNanoUsd).toBeGreaterThan(0);
  });

  it("records reasoning tokens without charging for them twice", () => {
    const withReasoning = costNanoUsd({
      modelId: model,
      usage: tokens({ outputTokens: 1_000, reasoningTokens: 400 }),
    });
    const withoutReasoning = costNanoUsd({
      modelId: model,
      usage: tokens({ outputTokens: 1_000 }),
    });
    // reasoningTokens is a diagnostic SUBSET of outputTokens.
    expect(withReasoning.totalNanoUsd).toBe(withoutReasoning.totalNanoUsd);
    expect(withReasoning.totalNanoUsd).toBe(1_000 * 50_000);
  });

  it("produces integer nano-USD for every combination it is given", () => {
    for (const inputTokens of [0, 1, 7, 1_001, 199_999]) {
      for (const outputTokens of [0, 3, 8_192]) {
        const result = costNanoUsd({
          modelId: model,
          usage: tokens({ inputTokens, outputTokens, cacheReadTokens: inputTokens >> 1 }),
        });
        expect(Number.isInteger(result.totalNanoUsd)).toBe(true);
        expect(result.totalNanoUsd).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("charges zero for an unbilled refusal but keeps the breakdown", () => {
    const refused = costNanoUsd({
      modelId: model,
      usage: tokens({ inputTokens: 5_000, noCacheTokens: 5_000 }),
      billing: "none",
    });
    expect(refused.totalNanoUsd).toBe(0);
    // Usage is retained for rate and observability; only the money is zero.
    expect(refused.noCacheNanoUsd).toBe(5_000 * 10_000);
  });
});

describe("pre-step spend guard", () => {
  const base = {
    modelId: FABLE_5_MODEL_ID,
    generationSpentNanoUsd: 0,
    runSpentNanoUsd: 0,
    promptBytes: 40_000,
    requestedMaxOutputTokens: MAX_OUTPUT_TOKENS_PER_STEP,
    gatewayAttempts: GATEWAY_MAX_ATTEMPTS,
  };

  it("clamps a fresh generation to the reviewed step ceiling, not the provider's", () => {
    const result = evaluateSpendGuard(base);
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    // 40,000 bytes / 2 = 20,000 estimated tokens.
    expect(result.estimatedInputTokens).toBe(20_000);
    // 20,000 x 20,000 nano x 2 attempts = $0.80 reserved.
    expect(result.reservedInputNanoUsd).toBe(800_000_000);
    expect(result.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS_PER_STEP);
  });

  it("estimates input at the highest input rate, never at the cache-read rate", () => {
    const result = evaluateSpendGuard({ ...base, gatewayAttempts: 1 });
    if (result.outcome !== "ok") throw new Error("expected ok");
    // 20,000 tokens at the 1-hour cache-write rate, which is the highest.
    expect(result.reservedInputNanoUsd).toBe(20_000 * 20_000);
    // Assuming a cache hit would have reserved 20x less.
    expect(result.reservedInputNanoUsd).toBe(20 * (20_000 * FABLE_5_PRICES.cacheRead));
  });

  it("does not assume a cache hit that has not happened yet", () => {
    // Two calls with identical prompt bytes must reserve identically, whether
    // or not earlier steps in the generation happened to hit cache. The guard
    // takes no cache input at all, which is the structural form of that claim.
    const cold = evaluateSpendGuard(base);
    const afterCacheHits = evaluateSpendGuard({ ...base, generationSpentNanoUsd: 0 });
    expect(cold).toEqual(afterCacheHits);
    if (cold.outcome !== "ok") throw new Error("expected ok");
    expect(cold.reservedInputNanoUsd).toBeGreaterThan(
      cold.estimatedInputTokens * FABLE_5_PRICES.cacheRead,
    );
  });

  it("multiplies provider exposure by the gateway attempt count", () => {
    const one = evaluateSpendGuard({ ...base, gatewayAttempts: 1 });
    const two = evaluateSpendGuard({ ...base, gatewayAttempts: 2 });
    if (one.outcome !== "ok" || two.outcome !== "ok") throw new Error("expected ok");
    expect(two.reservedInputNanoUsd).toBe(one.reservedInputNanoUsd * 2);
    // And the header the request actually carries agrees with the budget math.
    const headers = gatewayHeaders({
      run: "run:a",
      generation: "gen:b",
      attempt: 1,
      surface: "chat",
    });
    expect(headers["cf-aig-max-attempts"]).toBe(String(GATEWAY_MAX_ATTEMPTS));
  });

  it("clamps output when the remaining budget is smaller than the step ceiling", () => {
    const result = evaluateSpendGuard({
      ...base,
      promptBytes: 2_000,
      // $1.90 of the $2.00 generation cap is gone; $0.10 remains.
      generationSpentNanoUsd: 1_900_000_000,
    });
    if (result.outcome !== "ok") throw new Error("expected ok");
    expect(result.remainingNanoUsd).toBe(100_000_000);
    // 1,000 estimated tokens x 20,000 x 2 = $0.04 reserved, $0.06 left for
    // output, at 50,000 nano x 2 attempts = 600 tokens.
    expect(result.reservedInputNanoUsd).toBe(40_000_000);
    expect(result.maxOutputTokens).toBe(600);
    expect(result.maxOutputTokens).toBeLessThan(MAX_OUTPUT_TOKENS_PER_STEP);
  });

  it("stops before the call when input alone does not fit", () => {
    const result = evaluateSpendGuard({ ...base, generationSpentNanoUsd: 1_990_000_000 });
    expect(result.outcome).toBe("cost_limit");
    if (result.outcome !== "cost_limit") return;
    expect(result.reason).toBe("input_reservation");
    expect(result.scope).toBe("generation");
  });

  it("stops before the call when no USEFUL output budget remains", () => {
    const result = evaluateSpendGuard({
      ...base,
      promptBytes: 2_000,
      // Leaves enough for the input reservation but only a few output tokens.
      generationSpentNanoUsd: 1_955_000_000,
    });
    expect(result.outcome).toBe("cost_limit");
    if (result.outcome !== "cost_limit") return;
    expect(result.reason).toBe("no_useful_output");
  });

  it("reports whichever cap is binding, generation or run", () => {
    const runBound = evaluateSpendGuard({
      ...base,
      promptBytes: 2_000,
      generationSpentNanoUsd: 0,
      runSpentNanoUsd: RUN_SPEND_CAP_NANO_USD - 100_000_000,
    });
    if (runBound.outcome !== "ok") throw new Error("expected ok");
    expect(runBound.bindingScope).toBe("run");
    expect(runBound.remainingNanoUsd).toBe(100_000_000);

    const runExhausted = evaluateSpendGuard({ ...base, runSpentNanoUsd: RUN_SPEND_CAP_NANO_USD });
    expect(runExhausted).toMatchObject({ outcome: "cost_limit", scope: "run" });
  });

  it("refuses a step once a cap is already spent or overspent", () => {
    for (const spent of [GENERATION_SPEND_CAP_NANO_USD, GENERATION_SPEND_CAP_NANO_USD * 2]) {
      const result = evaluateSpendGuard({ ...base, generationSpentNanoUsd: spent });
      expect(result.outcome).toBe("cost_limit");
      if (result.outcome !== "cost_limit") continue;
      expect(result.remainingNanoUsd).toBe(0);
    }
  });

  it("fails closed on an unknown model rather than budgeting at fable's rate", () => {
    expect(() => evaluateSpendGuard({ ...base, modelId: "claude-fable-6" })).toThrow(
      UnknownModelPriceError,
    );
  });

  it("PROVES THE MAXIMUM OVERSHOOT: zero, while the byte estimate holds", () => {
    // Take the worst admitted step under a series of caps, then charge it the
    // worst thing that can actually happen: every attempt billed, the full
    // estimated input at the most expensive input rate, and the full clamped
    // output. If the guard is correct, that total still fits under the cap.
    let admitted = 0;
    for (const spent of [0, 500_000_000, 1_000_000_000, 1_900_000_000, 1_950_000_000]) {
      for (const promptBytes of [0, 2_000, 40_000, 90_000]) {
        const result = evaluateSpendGuard({ ...base, promptBytes, generationSpentNanoUsd: spent });
        if (result.outcome !== "ok") continue;
        admitted += 1;

        const worstActual = costNanoUsd({
          modelId: FABLE_5_MODEL_ID,
          usage: tokens({
            // The estimate holding means actual input <= estimated input.
            inputTokens: result.estimatedInputTokens,
            cacheWriteTokens: result.estimatedInputTokens,
            outputTokens: result.maxOutputTokens,
          }),
          // The most expensive cache ttl, even though policy configures 5m.
          cacheWriteTtl: "1h",
        }).totalNanoUsd;

        const billedForEveryAttempt = worstActual * GATEWAY_MAX_ATTEMPTS;
        expect(result.worstCaseStepNanoUsd).toBeGreaterThanOrEqual(billedForEveryAttempt);
        expect(spent + billedForEveryAttempt).toBeLessThanOrEqual(GENERATION_SPEND_CAP_NANO_USD);
      }
    }
    // The loop must have actually exercised admitted steps, not skipped all.
    expect(admitted).toBeGreaterThan(4);
  });

  it("documents the ONE overshoot term: an input under-estimate", () => {
    const result = evaluateSpendGuard({ ...base, promptBytes: 40_000 });
    if (result.outcome !== "ok") throw new Error("expected ok");

    // A pathological prompt of single-byte tokens: 40,000 real tokens where
    // the reviewed 2-bytes-per-token floor estimated 20,000.
    const actualInputTokens = 40_000;
    const underEstimate = actualInputTokens - result.estimatedInputTokens;
    expect(underEstimate).toBe(20_000);

    const overshoot =
      GATEWAY_MAX_ATTEMPTS *
      Math.max(FABLE_5_PRICES.input, FABLE_5_PRICES.cacheWrite1h) *
      underEstimate;
    // The exact, documented bound: 2 x 20,000 nano x 20,000 tokens = $0.80.
    expect(overshoot).toBe(800_000_000);

    // Output and attempts contribute NOTHING to overshoot: output is clamped
    // to what the guard returned, and every attempt was reserved in full.
    const actualWorst =
      GATEWAY_MAX_ATTEMPTS *
      costNanoUsd({
        modelId: FABLE_5_MODEL_ID,
        usage: tokens({ inputTokens: actualInputTokens, outputTokens: result.maxOutputTokens }),
      }).totalNanoUsd;
    expect(actualWorst).toBeLessThanOrEqual(result.worstCaseStepNanoUsd + overshoot);
  });
});

describe("nano-USD formatting", () => {
  it("renders money without ever computing in floating-point dollars", () => {
    expect(formatNanoUsd(0)).toBe("$0.000000");
    expect(formatNanoUsd(NANO_USD_PER_USD)).toBe("$1.000000");
    expect(formatNanoUsd(73_500)).toBe("$0.000073");
    expect(formatNanoUsd(2 * NANO_USD_PER_USD)).toBe("$2.000000");
  });
});
