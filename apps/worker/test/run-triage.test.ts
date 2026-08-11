import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleTriageBatch, type TriageJob } from "../src/triage/consumer";
import { routeSlackMessageToOwnedRun, wakeSlackRun } from "../src/run/coordinator";
import { runStubForKey, slackRunKey } from "../src/run/keys";
import { FakeMemoryStore } from "./helpers/fake-memory";
import type { TriageOutcome } from "../src/triage/run";

/**
 * Every case mints its own thread ts. Wiping D1 does not wipe Durable Object
 * storage, so a reused Slack key would keep old state. See phase-08-notes.md.
 */
function freshThreadTs(): string {
  const seconds = 1_720_000_000 + Math.floor(Math.random() * 9_000_000);
  const micros = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
  return `${seconds}.${micros}`;
}

let threadTs: string;

beforeEach(async () => {
  threadTs = freshThreadTs();
  await env.DB.prepare("DELETE FROM runs").run();
  await env.DB.prepare("DELETE FROM triage_decisions").run();
  await env.DB.prepare("DELETE FROM messages").run();
  await env.DB.prepare("DELETE FROM channels").run();
  await env.DB.prepare(
    "INSERT INTO channels (channel_id, name, customer_slug, mode) VALUES ('C1', 'pulsefit-eng', 'pulsefit', 'live')",
  ).run();
});

const wakeOutcome: TriageOutcome = {
  wake: true,
  why: "direct question",
  opening_prompt: "Customer asks why exports are empty.",
  model: "claude-haiku-4-5",
  cost_usd: 0.0003,
  latency_ms: 400,
};

const sleepOutcome: TriageOutcome = { ...wakeOutcome, wake: false, opening_prompt: "" };

async function seedMessage(eventId: string, opts: { ts?: string; thread_ts?: string | null } = {}) {
  await env.DB.prepare(
    `INSERT INTO messages (event_id, channel_id, ts, thread_ts, user_id, text, subtype, permalink, customer_slug, received_at)
     VALUES (?, 'C1', ?, ?, 'U1', 'why are exports empty?', NULL, 'https://slack.com/archives/C1/p1', 'pulsefit', 1)`,
  )
    .bind(eventId, opts.ts ?? threadTs, opts.thread_ts === undefined ? null : opts.thread_ts)
    .run();
}

function batchOf(eventIds: string[]) {
  const acked: string[] = [];
  const retried: string[] = [];
  const batch = {
    queue: "firefighter-triage",
    messages: eventIds.map((event_id) => ({
      body: { event_id } as TriageJob,
      ack: () => acked.push(event_id),
      retry: () => retried.push(event_id),
    })),
  } as unknown as MessageBatch<TriageJob>;
  return { batch, acked, retried };
}

function productionDeps(triage: () => Promise<TriageOutcome>) {
  return {
    triage,
    memory: new FakeMemoryStore(),
    routeToOwnedRun: (message: Parameters<typeof routeSlackMessageToOwnedRun>[1]) =>
      routeSlackMessageToOwnedRun(env, message),
    wakeRun: async (input: Parameters<typeof wakeSlackRun>[1]) => {
      await wakeSlackRun(env, input);
    },
  };
}

describe("a later message in an owned thread", () => {
  beforeEach(async () => {
    await wakeSlackRun(env, {
      eventId: "Ev0",
      channelId: "C1",
      threadTs,
      openingPrompt: "opening",
    });
  });

  it("bypasses the model and is not lost", async () => {
    await seedMessage("Ev1", { ts: "1720000009.999999", thread_ts: threadTs });
    let calls = 0;
    const { batch, acked } = batchOf(["Ev1"]);

    await handleTriageBatch(
      batch,
      env,
      productionDeps(async () => {
        calls += 1;
        return wakeOutcome;
      }),
    );

    expect(calls).toBe(0);
    expect(acked).toEqual(["Ev1"]);

    // No decision was made, so no decision row — and the `triaged` counter
    // correctly does not count this message.
    const decision = await env.DB.prepare(
      "SELECT 1 FROM triage_decisions WHERE event_id = 'Ev1'",
    ).first();
    expect(decision).toBeNull();

    const turns = await runStubForKey(env.RUNS, slackRunKey("C1", threadTs)).turns();
    expect(turns.map((t) => t.id)).toEqual(["triage:Ev0", "slack:Ev1"]);
    expect(turns[1]).toMatchObject({ source: "customer" });
  });

  it("does not create a second turn on a duplicate delivery", async () => {
    await seedMessage("Ev1", { ts: "1720000009.999999", thread_ts: threadTs });

    for (const _ of [0, 1]) {
      const { batch } = batchOf(["Ev1"]);
      await handleTriageBatch(batch, env, productionDeps(async () => wakeOutcome));
    }

    expect(await runStubForKey(env.RUNS, slackRunKey("C1", threadTs)).turns()).toHaveLength(2);
  });

  it("leaves the run live after the interruption", async () => {
    const stub = runStubForKey(env.RUNS, slackRunKey("C1", threadTs));
    await stub.setStatus("awaiting_approval");

    await seedMessage("Ev1", { ts: "1720000009.999999", thread_ts: threadTs });
    const { batch } = batchOf(["Ev1"]);
    await handleTriageBatch(batch, env, productionDeps(async () => wakeOutcome));

    expect((await stub.state())?.status).toBe("live");
  });
});

describe("decision to wake, and its retry", () => {
  it("stores the decision and wakes exactly one run", async () => {
    await seedMessage("Ev1");
    const { batch, acked } = batchOf(["Ev1"]);

    await handleTriageBatch(batch, env, productionDeps(async () => wakeOutcome));

    expect(acked).toEqual(["Ev1"]);
    const turns = await runStubForKey(env.RUNS, slackRunKey("C1", threadTs)).turns();
    expect(turns.map((t) => t.id)).toEqual(["triage:Ev1"]);
    expect(turns[0].content).toBe(wakeOutcome.opening_prompt);
  });

  it("retries when the wake fails, without a second model call", async () => {
    await seedMessage("Ev1");
    let modelCalls = 0;
    let wakeAttempts = 0;

    const flaky = {
      triage: async () => {
        modelCalls += 1;
        return wakeOutcome;
      },
      memory: new FakeMemoryStore(),
      wakeRun: async (input: Parameters<typeof wakeSlackRun>[1]) => {
        wakeAttempts += 1;
        if (wakeAttempts === 1) throw new Error("RunDO unreachable");
        await wakeSlackRun(env, input);
      },
    };

    // Attempt one: decision commits, wake fails, message retries.
    const first = batchOf(["Ev1"]);
    await handleTriageBatch(first.batch, env, flaky);
    expect(first.retried).toEqual(["Ev1"]);
    expect(first.acked).toEqual([]);

    // The decision row survived the failure.
    const stored = await env.DB.prepare(
      "SELECT wake FROM triage_decisions WHERE event_id = 'Ev1'",
    ).first<{ wake: number }>();
    expect(stored?.wake).toBe(1);

    // Attempt two: the stored decision is replayed, not re-decided.
    const second = batchOf(["Ev1"]);
    await handleTriageBatch(second.batch, env, flaky);
    expect(second.acked).toEqual(["Ev1"]);

    expect(modelCalls).toBe(1);
    expect(wakeAttempts).toBe(2);

    const turns = await runStubForKey(env.RUNS, slackRunKey("C1", threadTs)).turns();
    expect(turns.map((t) => t.id)).toEqual(["triage:Ev1"]);
  });

  it("does not append the triggering message twice when a half-succeeded wake retries", async () => {
    // The regression this task's ordering exists to prevent: on retry a live
    // run now owns the thread, and if routeToOwnedRun ran before the decision
    // check it would append the very message the opening prompt contains.
    await seedMessage("Ev1");

    const deps = productionDeps(async () => wakeOutcome);
    await handleTriageBatch(batchOf(["Ev1"]).batch, env, deps);
    await handleTriageBatch(batchOf(["Ev1"]).batch, env, deps);

    const turns = await runStubForKey(env.RUNS, slackRunKey("C1", threadTs)).turns();
    expect(turns.map((t) => t.id)).toEqual(["triage:Ev1"]);
    expect(turns.some((t) => t.source === "customer")).toBe(false);
  });

  it("converges on one run and one opening turn when deliveries repeat", async () => {
    await seedMessage("Ev1");
    const deps = productionDeps(async () => wakeOutcome);

    await Promise.all([
      handleTriageBatch(batchOf(["Ev1"]).batch, env, deps),
      handleTriageBatch(batchOf(["Ev1"]).batch, env, deps),
    ]);

    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM runs").first<{ n: number }>();
    expect(rows?.n).toBe(1);
    expect(await runStubForKey(env.RUNS, slackRunKey("C1", threadTs)).turns()).toHaveLength(1);
  });

  it("never creates a run when the decision is not to wake", async () => {
    await seedMessage("Ev1");
    let wakes = 0;

    await handleTriageBatch(batchOf(["Ev1"]).batch, env, {
      triage: async () => sleepOutcome,
      memory: new FakeMemoryStore(),
      wakeRun: async () => {
        wakes += 1;
      },
    });

    expect(wakes).toBe(0);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM runs").first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("does not replay a wake for a stored no-wake decision", async () => {
    await seedMessage("Ev1");
    const deps = {
      triage: async () => sleepOutcome,
      memory: new FakeMemoryStore(),
      wakeRun: async () => {
        throw new Error("must not be called");
      },
    };

    await handleTriageBatch(batchOf(["Ev1"]).batch, env, deps);
    const second = batchOf(["Ev1"]);
    await handleTriageBatch(second.batch, env, deps);

    expect(second.acked).toEqual(["Ev1"]);
  });
});

describe("a completed thread that earns a new wake", () => {
  it("is not owned before triage, and reopens the same run after it", async () => {
    const first = await wakeSlackRun(env, {
      eventId: "Ev0",
      channelId: "C1",
      threadTs,
      openingPrompt: "first",
    });
    const stub = runStubForKey(env.RUNS, first.key);
    await stub.setStatus("done");

    await seedMessage("Ev1", { ts: "1720000009.999999", thread_ts: threadTs });
    let modelCalls = 0;

    await handleTriageBatch(
      batchOf(["Ev1"]).batch,
      env,
      productionDeps(async () => {
        modelCalls += 1;
        return wakeOutcome;
      }),
    );

    // A done run does not own the thread, so triage ran.
    expect(modelCalls).toBe(1);

    const state = await stub.state();
    expect(state?.runId).toBe(first.id);
    expect(state?.status).toBe("live");
    // History is continuous across the reopen.
    expect((await stub.turns()).map((t) => t.id)).toEqual(["triage:Ev0", "triage:Ev1"]);
  });
});
