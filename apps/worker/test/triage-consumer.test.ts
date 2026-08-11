import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleTriageBatch, type TriageJob } from "../src/triage/consumer";
import type { TriageInput } from "../src/triage/prompt";
import type { TriageOutcome } from "../src/triage/run";
import { FakeMemoryStore } from "./helpers/fake-memory";

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

const wakeOutcome: TriageOutcome = {
  wake: true,
  why: "direct question",
  opening_prompt: "Customer asks about language variants.",
  model: "claude-haiku-4-5",
  cost_usd: 0.0003,
  latency_ms: 400,
};

async function seedMessage(eventId: string, opts: { thread_ts?: string; ts?: string; text?: string } = {}) {
  await env.DB.prepare(
    `INSERT INTO messages (event_id, channel_id, ts, thread_ts, user_id, text, subtype, permalink, customer_slug, received_at)
     VALUES (?, 'C1', ?, ?, 'U1', ?, NULL, NULL, 'pulsefit', 1)`,
  ).bind(eventId, opts.ts ?? "9.9", opts.thread_ts ?? null, opts.text ?? "how do I do X?").run();
}

describe("handleTriageBatch", () => {
  // Every case here reuses 'Ev1' and re-seeds channel C1, and the suite shares
  // one D1 with the other test files — without this the second case dies on a
  // primary-key conflict rather than on the behaviour under test.
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM triage_decisions"),
      env.DB.prepare("DELETE FROM messages"),
      env.DB.prepare("DELETE FROM channels"),
    ]);
    await env.DB.prepare(
      "INSERT INTO channels (channel_id, name, customer_slug, mode) VALUES ('C1', 'ext-pulsefit', 'pulsefit', 'live')",
    ).run();
  });

  it("stores a decision with prompt inputs from thread and recall", async () => {
    await seedMessage("Root", { ts: "1.0", text: "earlier in thread" });
    await seedMessage("Ev1", { ts: "2.0", thread_ts: "1.0" });
    const memory = new FakeMemoryStore();
    memory.searchResults = [{ factId: "f1", fact: "known issue", episodeUuids: [] }];
    const seen: TriageInput[] = [];
    const triage = async (input: TriageInput) => (seen.push(input), wakeOutcome);
    const { batch, acked } = batchOf(["Ev1"]);

    await handleTriageBatch(batch, env, { triage, memory });

    expect(seen).toHaveLength(1);
    expect(seen[0].thread.map((m) => m.text)).toEqual(["earlier in thread"]);
    expect(seen[0].recall[0].fact).toBe("known issue");
    const row = await env.DB.prepare("SELECT wake, why, cost_usd FROM triage_decisions WHERE event_id = 'Ev1'").first();
    expect(row).toMatchObject({ wake: 1, why: "direct question", cost_usd: 0.0003 });
    expect(acked).toEqual(["Ev1"]);
  });

  it("is idempotent: a redelivered event does not call the model again", async () => {
    await seedMessage("Ev1");
    let calls = 0;
    const triage = async () => (calls++, wakeOutcome);
    const memory = new FakeMemoryStore();
    await handleTriageBatch(batchOf(["Ev1"]).batch, env, { triage, memory });
    await handleTriageBatch(batchOf(["Ev1"]).batch, env, { triage, memory });
    expect(calls).toBe(1);
  });

  it("skips triage entirely when a live run owns the thread", async () => {
    await seedMessage("Ev1", { thread_ts: "1.0" });
    let calls = 0;
    const triage = async () => (calls++, wakeOutcome);
    const { batch, acked } = batchOf(["Ev1"]);

    await handleTriageBatch(batch, env, {
      triage,
      memory: new FakeMemoryStore(),
      hasLiveRun: async () => true,
    });

    expect(calls).toBe(0);
    expect(acked).toEqual(["Ev1"]);
    const row = await env.DB.prepare("SELECT 1 FROM triage_decisions WHERE event_id = 'Ev1'").first();
    expect(row).toBeNull();
  });

  it("still triages when Zep recall fails — recall is best-effort", async () => {
    await seedMessage("Ev1");
    const memory = new FakeMemoryStore();
    memory.search = async () => {
      throw new Error("zep down");
    };
    const seen: TriageInput[] = [];
    const triage = async (input: TriageInput) => (seen.push(input), wakeOutcome);

    await handleTriageBatch(batchOf(["Ev1"]).batch, env, { triage, memory });

    expect(seen[0].recall).toEqual([]);
  });

  it("retries on model failure without failing the batch", async () => {
    await seedMessage("Ev1");
    await seedMessage("Ev2", { ts: "3.0" });
    let first = true;
    const triage = async () => {
      if (first) {
        first = false;
        throw new Error("model down");
      }
      return wakeOutcome;
    };
    const { batch, acked, retried } = batchOf(["Ev1", "Ev2"]);

    await handleTriageBatch(batch, env, { triage, memory: new FakeMemoryStore() });

    expect(retried).toEqual(["Ev1"]);
    expect(acked).toEqual(["Ev2"]);
  });
});
