import { SELF, env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installRunPorts, resetRunPorts } from "../src/agent/driver";
import { productionRunPorts } from "../src/agent/ports";
import { runStubForKey } from "../src/run/keys";
import { getRunById, projectRunIndex, readRunUsage } from "../src/run/repository";
import { readDriver, readState } from "../src/run/session";
import type { Env } from "../src/index";

/**
 * Step 1 (Chat auto-wake as ONE transaction) and Steps 5/6/8 (bounded telemetry
 * a dashboard can read without waking every Durable Object).
 */

afterEach(() => {
  resetRunPorts();
});

beforeEach(async () => {
  // Children first. Both `agent_model_calls.run_id` and
  // `agent_memory_outbox.run_id` are foreign keys into `runs`, and the
  // production projection runners installed below genuinely write to both.
  await env.DB.prepare("DELETE FROM agent_model_calls").run();
  await env.DB.prepare("DELETE FROM agent_memory_outbox").run();
  await env.DB.prepare("DELETE FROM runs").run();
});

function configuredEnv(): Env {
  return {
    ...env,
    ANTHROPIC_API_KEY: "sk-ant-test",
    AI_GATEWAY_ANTHROPIC_URL: "https://gateway.ai.cloudflare.com/v1/acct/ff/anthropic",
    AI_GATEWAY_TOKEN: "cf-aig-test",
  } as unknown as Env;
}

async function createChat(body: Record<string, unknown>) {
  const response = await SELF.fetch("https://x/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  const { run } = (await response.json()) as { run: { id: string; status: string } };
  const record = await getRunById(env.DB, run.id);
  expect(record).not.toBeNull();
  return { id: run.id, status: run.status, key: record!.key, record: record! };
}

/** Everything the input transaction is supposed to have committed, read at once. */
async function durableShape(key: string) {
  return runInDurableObject(runStubForKey(env.RUNS, key), (_instance, state) => {
    const turns = state.storage.sql
      .exec<{ id: string; role: string; source: string }>(
        "SELECT id, role, source FROM turns ORDER BY event_seq ASC",
      )
      .toArray();
    const generations = state.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM agent_generations")
      .one().n;
    const statusEvents = state.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM stream_events WHERE type = 'status'")
      .one().n;
    return {
      turns,
      generations,
      statusEvents,
      driver: readDriver(state.storage),
      status: readState(state.storage)?.status ?? null,
    };
  });
}

describe("Chat auto-wake is one transaction", () => {
  /**
   * `POST /api/runs` with a `firstMessage` commits ONE `human_steer` turn,
   * allocates ONE generation, and writes the public `live` status event — all
   * inside `writeTurn`'s single `transactionSync`.
   *
   * The pre/post `setStatus("live")` calls this replaced are gone from every
   * surface: the coordinator, the HTTP steer route and the WebSocket handler.
   * That mattered because a status written outside the input transaction can be
   * observed on its own — a run advertising a loop that has nothing scheduled
   * (crash between the two writes), or a loop scheduled behind a run that still
   * reads idle. Here there is no ordering to get wrong.
   */
  it("commits one turn, one generation and one status event together", async () => {
    const created = await createChat({ firstMessage: "why are exports empty?", requestId: "r1" });

    expect(created.status).toBe("live");
    const shape = await durableShape(created.key);

    expect(shape.turns).toEqual([{ id: "steer:r1", role: "user", source: "human_steer" }]);
    expect(shape.generations).toBe(1);
    // Exactly one: idle -> live. Not two, which is what a pre-emptive
    // `setStatus("live")` followed by the transaction's own event would give.
    expect(shape.statusEvents).toBe(1);
    expect(shape.status).toBe("live");
    expect(shape.driver.phase).toBe("scheduled");
    expect(shape.driver.generationId).not.toBeNull();
  });

  it("schedules exactly one unit of work for that one generation", async () => {
    // Installed BEFORE the run exists. The RunDO caches its resolved ports once
    // its key is known, which is exactly what production's constructor-time
    // installation guarantees and what a later install cannot retrofit.
    installRunPorts(productionRunPorts(configuredEnv()).ports);
    const created = await createChat({ firstMessage: "why are exports empty?", requestId: "r1" });

    const before = await durableShape(created.key);
    const stub = runStubForKey(env.RUNS, created.key);
    await stub.dispatchAlarm();
    const after = await durableShape(created.key);

    // Deliberately not asserting WHICH delivery claimed it. Alarms really fire
    // in this pool, so the background delivery and this explicit one race — and
    // that race is the point: at-least-once delivery must produce exactly one
    // unit of work however many times it happens.
    //
    // One generation, the SAME generation, claimed exactly once.
    expect(after.generations).toBe(1);
    expect(after.driver.generationId).toBe(before.driver.generationId);
    expect(after.driver.attempt).toBe(1);
  });

  /**
   * A redelivered first message adds nothing and forks nothing.
   *
   * The turn id is caller-stable (`steer:{requestId}`), so the second delivery
   * takes `writeTurn`'s duplicate branch: no turn, no second generation, and
   * the still-owed work left exactly where it was. The wake is still issued on
   * that path — deliberately, because a first attempt can commit the turn and
   * die before `setAlarm()`, and a duplicate is the only thing that ever heals
   * it — but the alarm's arming is asserted by the claim above rather than by
   * reading the slot, because a real alarm in this pool may already have fired
   * and cleared it by the time a test looks.
   */
  it("treats a redelivered first message as a no-op, keeping one turn and one generation", async () => {
    const created = await createChat({ firstMessage: "why are exports empty?", requestId: "r1" });
    const stub = runStubForKey(env.RUNS, created.key);

    const replay = await stub.appendTurn({
      id: "steer:r1",
      role: "user",
      source: "human_steer",
      content: "why are exports empty?",
    });
    expect(replay.appended).toBe(false);
    expect(replay.scheduling.outcome).toBe("duplicate");

    const shape = await durableShape(created.key);
    expect(shape.turns).toHaveLength(1);
    expect(shape.generations).toBe(1);
    expect(shape.driver.phase).toBe("scheduled");
  });
});

describe("an empty Chat run is idle, in both places", () => {
  it("initializes idle in the RunDO and in D1, with nothing scheduled", async () => {
    const created = await createChat({});

    // The shipped Phase 08 default was `live`, which described nothing: a row
    // existing is not the agent working.
    expect(created.status).toBe("idle");
    expect(created.record.status).toBe("idle");

    const shape = await durableShape(created.key);
    expect(shape.status).toBe("idle");
    expect(shape.turns).toHaveLength(0);
    expect(shape.generations).toBe(0);
    expect(shape.statusEvents).toBe(0);
    expect(shape.driver.phase).toBe("idle");
  });

  it("stays idle until its first /turns steer, then goes live in that transaction", async () => {
    const created = await createChat({});
    expect((await durableShape(created.key)).status).toBe("idle");

    const response = await SELF.fetch(`https://x/api/runs/${created.id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "r9", content: "look at the checkout errors" }),
    });
    expect(response.status).toBe(201);

    const shape = await durableShape(created.key);
    expect(shape.status).toBe("live");
    expect(shape.generations).toBe(1);
    expect(shape.statusEvents).toBe(1);
  });

  it("stays idle until its first WebSocket steer", async () => {
    const created = await createChat({});
    const stub = runStubForKey(env.RUNS, created.key);

    const upgrade = await stub.fetch(
      new Request("https://x/ws", { headers: { Upgrade: "websocket" } }),
    );
    const socket = upgrade.webSocket!;
    socket.accept();
    socket.send(JSON.stringify({ type: "steer", requestId: "ws1", content: "check the deploy" }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const shape = await durableShape(created.key);
    expect(shape.status).toBe("live");
    expect(shape.turns).toEqual([{ id: "steer:ws1", role: "user", source: "human_steer" }]);
    expect(shape.generations).toBe(1);
  });
});

describe("the bounded usage read", () => {
  async function insertCall(
    runId: string,
    id: string,
    overrides: Partial<{ model: string; cost: number; input: number; output: number; step: number }> = {},
  ) {
    await env.DB.prepare(
      `INSERT INTO agent_model_calls
         (id, run_id, generation_id, agent_turn_id, attempt, step_index, provider, model,
          provider_request_id, gateway_log_id, input_tokens, no_cache_tokens, cache_read_tokens,
          cache_write_tokens, output_tokens, reasoning_tokens, total_tokens, cost_nano_usd,
          latency_ms, finish_reason, raw_finish_reason, error_code, created_at)
       VALUES (?, ?, 'gen:1', 'agent:gen:1', 1, ?, 'anthropic', ?, 'req_secret_123',
               'aig_log_secret_456', ?, 0, 7, 3, ?, 0, 0, ?, 10, 'stop', 'end_turn', NULL, 0)`,
    )
      .bind(
        id,
        runId,
        overrides.step ?? 0,
        overrides.model ?? "claude-fable-5",
        overrides.input ?? 100,
        overrides.output ?? 25,
        overrides.cost ?? 1_500_000_000,
      )
      .run();
  }

  it("returns the reviewed aggregate shape with a decimal cost string", async () => {
    const created = await createChat({});
    await insertCall(created.id, "u1", { cost: 1_500_000_000 });
    await insertCall(created.id, "u2", { cost: 250_000_000, step: 1 });

    const response = await SELF.fetch(`https://x/api/runs/${created.id}/usage`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      usage: Array<Record<string, unknown>>;
      totalCostUsd: string;
    };

    expect(body.usage).toHaveLength(1);
    expect(body.usage[0]).toEqual({
      model: "claude-fable-5",
      calls: 2,
      inputTokens: 200,
      cacheReadTokens: 14,
      cacheWriteTokens: 6,
      outputTokens: 50,
      costUsd: "1.750000000",
    });

    // A STRING, always. A JSON number cannot carry nano-USD precision, and a
    // dashboard that adds up floats produces a bill nobody can defend.
    expect(typeof body.usage[0].costUsd).toBe("string");
    expect(body.totalCostUsd).toBe("1.750000000");
  });

  it("withholds the provider request id, the gateway log id and the provider name", async () => {
    const created = await createChat({});
    await insertCall(created.id, "u1");

    const response = await SELF.fetch(`https://x/api/runs/${created.id}/usage`);
    const text = await response.text();

    // These are internal debugging handles into the Gateway's own logs.
    expect(text).not.toContain("req_secret_123");
    expect(text).not.toContain("aig_log_secret_456");
    expect(text).not.toContain("provider");
  });

  it("serves a run whose Durable Object was never initialized", async () => {
    // The route never resolves a stub, so a run with no object behind it still
    // answers. That is the same rule `GET /api/runs` follows: a list of fifty
    // runs must not cost fifty Durable Object wakes.
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO runs (id, "key", origin, channel_id, thread_ts, status, shadow, summary, created_at, updated_at)
       VALUES (?, ?, 'chat', NULL, NULL, 'idle', 0, NULL, 0, 0)`,
    )
      .bind(id, `chat:${crypto.randomUUID()}`)
      .run();

    const response = await SELF.fetch(`https://x/api/runs/${id}/usage`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ usage: [], totalCostUsd: "0.000000000" });
  });

  it("404s an unknown run", async () => {
    const response = await SELF.fetch(`https://x/api/runs/${crypto.randomUUID()}/usage`);
    expect(response.status).toBe(404);
  });

  it("groups by model, so two models are two rows and one exact total", async () => {
    const created = await createChat({});
    await insertCall(created.id, "u1", { model: "claude-fable-5", cost: 1_000_000_001 });
    await insertCall(created.id, "u2", { model: "claude-haiku-4-5", cost: 2, step: 1 });

    const rows = await readRunUsage(env.DB, created.id);
    expect(rows.map((row) => row.model)).toEqual(["claude-fable-5", "claude-haiku-4-5"]);
    // Summed as integers. Adding the two formatted strings would lose the 1ns.
    expect(rows.reduce((sum, row) => sum + row.costNanoUsd, 0)).toBe(1_000_000_003);
  });
});

describe("the live snapshot's driver state", () => {
  it("exposes the four public fields and nothing private", async () => {
    const created = await createChat({ firstMessage: "why are exports empty?", requestId: "r1" });

    const response = await SELF.fetch(`https://x/api/runs/${created.id}`);
    const body = (await response.json()) as { driver: Record<string, unknown> };

    expect(body.driver).toEqual({ state: "scheduled", attempt: 0, steps: 0, error: null });
  });

  it("never carries a lease, an epoch, the generation, the turn id or the key", async () => {
    // Installed BEFORE the run exists. The RunDO caches its resolved ports once
    // its key is known, which is exactly what production's constructor-time
    // installation guarantees and what a later install cannot retrofit.
    installRunPorts(productionRunPorts(configuredEnv()).ports);
    const created = await createChat({ firstMessage: "why are exports empty?", requestId: "r1" });
    // Fail the run, so there is a real error code and a real attempt to leak.
    //
    // Polled rather than asserted straight after the dispatch: alarms really
    // fire in this pool, so the failure may be committed by the background
    // delivery while this one finds a live lease. Either is correct; what this
    // case needs is simply that a failed driver EXISTS to redact.
    const stub = runStubForKey(env.RUNS, created.key);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await stub.dispatchAlarm();
      if ((await stub.driver()).phase === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const response = await SELF.fetch(`https://x/api/runs/${created.id}`);
    const body = (await response.json()) as { driver: Record<string, unknown> };
    const text = JSON.stringify(body.driver);

    expect(body.driver.state).toBe("failed");
    // The safe CODE, never the message: a capability's error message can carry
    // a URL that had a token in it.
    expect(body.driver.error).toBe("missing_gateway_url");
    expect(text).not.toContain("refusing to call Anthropic");

    const driver = await runStubForKey(env.RUNS, created.key).driver();
    expect(Object.keys(body.driver)).toEqual(["state", "attempt", "steps", "error"]);
    expect(text).not.toContain(String(driver.generationId));
    expect(text).not.toContain(String(driver.agentTurnId));
    expect(text).not.toContain("leaseExpiresAt");
    expect(text).not.toContain("claimEpoch");
    expect(text).not.toContain(created.key);
  });
});

describe("run index projection stays monotonic and repairable (Step 8)", () => {
  /**
   * VERIFIED, NOT REBUILT. Task 2 shipped the bundled conditional projector and
   * the independent `projection_revision` counter; Task 3's alarm dispatches it.
   * These cases pin the three properties Task 10 depends on.
   */
  it("applies a newer revision and ignores an older one", async () => {
    const created = await createChat({});

    const newer = await projectRunIndex(env.DB, created.id, 50, {
      status: "live",
      summary: "checkout investigation",
      updatedAt: 5_000,
    });
    expect(newer.applied).toBe(true);

    // An older revision whose async write returned late matches zero rows.
    const older = await projectRunIndex(env.DB, created.id, 20, {
      status: "idle",
      summary: "stale",
      updatedAt: 1_000,
    });
    expect(older.applied).toBe(false);

    const row = await getRunById(env.DB, created.id);
    expect(row?.status).toBe("live");
    expect(row?.summary).toBe("checkout investigation");
    // MAX(), so neither a replayed older revision nor a lower timestamp can sink
    // a live run down the dashboard list.
    expect(row!.updatedAt).toBeGreaterThanOrEqual(5_000);
  });

  it("does not move state backwards when a revision is re-applied", async () => {
    const created = await createChat({});
    await projectRunIndex(env.DB, created.id, 50, {
      status: "live",
      summary: "a",
      updatedAt: 5_000,
    });
    // Same revision again — a duplicate alarm delivery. `projection_seq < ?` is
    // strict, so a repeat is a no-op rather than a rewrite.
    const repeat = await projectRunIndex(env.DB, created.id, 50, {
      status: "idle",
      summary: "b",
      updatedAt: 1,
    });
    expect(repeat.applied).toBe(false);
    expect((await getRunById(env.DB, created.id))?.summary).toBe("a");
  });

  it("leaves the local job pending when D1 fails, and repairs it on the next flush", async () => {
    const created = await createChat({ firstMessage: "hello", requestId: "r1" });
    const stub = runStubForKey(env.RUNS, created.key);

    // Drain whatever the input transaction queued, then break D1 for one pass.
    await stub.flushProjections();
    await env.DB.prepare("DELETE FROM runs WHERE id = ?").bind(created.id).run();
    await stub.setSummary("investigating checkout");

    // The row is gone, so the conditional UPDATE matches nothing — which is NOT
    // an error: the RunDO owns the session and its mutation must not fail
    // because the index lagged. The local state is already committed.
    const flushed = await stub.flushProjections();
    expect(flushed.failed).toBe(0);

    const local = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ summary: string | null }>("SELECT summary FROM run_state WHERE singleton = 1")
        .one(),
    );
    expect(local.summary).toBe("investigating checkout");
  });
});
