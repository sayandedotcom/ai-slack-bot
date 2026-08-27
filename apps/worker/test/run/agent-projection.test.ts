import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  projectStatus,
  recordUsage,
  type UsageRow,
  usageRowId,
} from "../../src/run/agent-projection";
import { chatRunKey } from "../../src/run/keys";
import {
  createOrGetRun,
  getRunById,
  readRunUsage,
  setRunStatus,
} from "../../src/run/repository";

async function freshRun() {
  return createOrGetRun(env.DB, {
    key: chatRunKey(crypto.randomUUID()),
    origin: "chat",
    channelId: null,
    threadTs: null,
  });
}

function usageRow(over: Partial<UsageRow> & Pick<UsageRow, "runId">): UsageRow {
  return {
    // Unique per row: pool storage is shared across tests AND files, and the
    // unique index is on (generation_id, attempt, step_index) alone — a reused
    // generation id would make a later test's insert silently a no-op.
    generationId: `gen-${crypto.randomUUID()}`,
    agentTurnId: "turn-1",
    attempt: 0,
    stepIndex: 0,
    provider: "anthropic",
    model: "claude-fable-5",
    providerRequestId: "req_1",
    gatewayLogId: null,
    inputTokens: 100,
    noCacheTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 10,
    reasoningTokens: 0,
    totalTokens: 110,
    costNanoUsd: 1_500_000,
    latencyMs: 900,
    finishReason: "stop",
    rawFinishReason: "end_turn",
    errorCode: null,
    createdAt: Date.now(),
    ...over,
  };
}

describe("status projection", () => {
  it("applies a legal transition", async () => {
    const run = await freshRun();
    expect(await projectStatus(env.DB, run.id, "live", Date.now())).toEqual({
      applied: true,
    });
    expect((await getRunById(env.DB, run.id))?.status).toBe("live");
  });

  it("refuses an illegal one and changes nothing", async () => {
    // done -> idle would reclaim a Slack thread the run has already released,
    // so a later message would reach a finished session instead of triage.
    const run = await freshRun();
    await setRunStatus(env.DB, run.id, "done");

    const outcome = await projectStatus(env.DB, run.id, "idle", Date.now());
    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toContain("illegal transition done -> idle");
    expect((await getRunById(env.DB, run.id))?.status).toBe("done");
  });

  it("is idempotent on the same status and writes nothing", async () => {
    const run = await freshRun();
    await projectStatus(env.DB, run.id, "live", Date.now());
    const before = await getRunById(env.DB, run.id);

    const outcome = await projectStatus(
      env.DB,
      run.id,
      "live",
      (before?.updatedAt ?? 0) + 5_000
    );
    expect(outcome).toEqual({ applied: false, reason: "same_status" });
    // Not even the timestamp: a re-delivered projection must not make a stale
    // run look fresh and float to the top of the dashboard list.
    expect((await getRunById(env.DB, run.id))?.updatedAt).toBe(
      before?.updatedAt
    );
  });

  it("loses cleanly when another projection moved the row first", async () => {
    // Both readers see `live`, both judge themselves legal, and the loser must
    // become a no-op rather than overwriting the winner's terminal state.
    const run = await freshRun();
    await projectStatus(env.DB, run.id, "live", Date.now());

    const [first, second] = await Promise.all([
      projectStatus(env.DB, run.id, "done", Date.now()),
      projectStatus(env.DB, run.id, "failed", Date.now()),
    ]);
    expect([first.applied, second.applied].filter(Boolean)).toHaveLength(1);
    expect(["done", "failed"]).toContain(
      (await getRunById(env.DB, run.id))?.status
    );
  });

  it("does not fail on a missing row", async () => {
    // The Durable Object owns the session; its mutation must not fail because
    // the index lagged or was never created.
    expect(
      await projectStatus(env.DB, crypto.randomUUID(), "live", Date.now())
    ).toEqual({
      applied: false,
      reason: "run_not_found",
    });
  });
});

describe("usage rows", () => {
  it("records one billed step", async () => {
    const run = await freshRun();
    await recordUsage(env.DB, usageRow({ runId: run.id }));

    const [aggregate] = await readRunUsage(env.DB, run.id);
    expect(aggregate).toMatchObject({
      model: "claude-fable-5",
      calls: 1,
      inputTokens: 100,
      outputTokens: 10,
      costNanoUsd: 1_500_000,
    });
  });

  it("leaves one row when the same step is recorded twice", async () => {
    const run = await freshRun();
    const row = usageRow({ runId: run.id });
    await recordUsage(env.DB, row);
    // A retry of the SAME logical step. The provider request id differs, which
    // is exactly why it cannot be the idempotency key.
    await recordUsage(env.DB, {
      ...row,
      providerRequestId: "req_2",
      costNanoUsd: 9_000_000,
    });

    const [aggregate] = await readRunUsage(env.DB, run.id);
    expect(aggregate.calls).toBe(1);
    expect(aggregate.costNanoUsd).toBe(1_500_000);
  });

  it("counts a different recovery attempt as the distinct billed call it was", async () => {
    const run = await freshRun();
    const row = usageRow({ runId: run.id });
    await recordUsage(env.DB, row);
    await recordUsage(env.DB, { ...row, attempt: 1 });

    const [aggregate] = await readRunUsage(env.DB, run.id);
    expect(aggregate.calls).toBe(2);
    expect(aggregate.costNanoUsd).toBe(3_000_000);
  });

  it("stores cost as an integer", async () => {
    const run = await freshRun();
    await recordUsage(
      env.DB,
      usageRow({ runId: run.id, costNanoUsd: 1_234.9, latencyMs: 10.4 })
    );
    const { results } = await env.DB.prepare(
      "SELECT cost_nano_usd, latency_ms FROM agent_model_calls WHERE run_id = ?"
    )
      .bind(run.id)
      .all<{ cost_nano_usd: number; latency_ms: number }>();
    expect(results?.[0]).toEqual({ cost_nano_usd: 1_234, latency_ms: 10 });
  });

  it("keys a row on the generation, attempt and step and nothing else", () => {
    expect(
      usageRowId({ generationId: "gen-9", attempt: 2, stepIndex: 5 })
    ).toBe("usage:gen-9:2:5");
  });
});
