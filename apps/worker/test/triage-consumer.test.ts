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

  it("skips triage entirely when a run already owns the thread", async () => {
    await seedMessage("Ev1", { thread_ts: "1.0" });
    let calls = 0;
    const triage = async () => (calls++, wakeOutcome);
    const { batch, acked } = batchOf(["Ev1"]);

    await handleTriageBatch(batch, env, {
      triage,
      memory: new FakeMemoryStore(),
      // true means the callback has already COMMITTED the message as a turn.
      routeToOwnedRun: async () => true,
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

  /**
   * Observed live, twice. The agent replies "Looking at it now", its run dies,
   * and triage then reads that promise as evidence the work is in hand — so
   * every follow-up is reasoned into silence and the thread is dead for good.
   * The model is not wrong about the conversation; it cannot see that the run
   * behind the promise is gone.
   */
  describe("a thread whose run died is not 'already handled'", () => {
    const declineOutcome: TriageOutcome = {
      wake: false,
      why: "already being handled in-thread",
      opening_prompt: "",
      model: "claude-haiku-4-5",
      cost_usd: 0.0001,
      latency_ms: 200,
    };

    // Scoped to this block rather than added to the file's global teardown:
    // `runs` is referenced by other tables and shared with the other test
    // files, so only the rows these cases create get removed.
    beforeEach(async () => {
      await env.DB.prepare("DELETE FROM runs WHERE channel_id = 'C1'").run();
    });

    const seedRun = async (id: string, status: string, threadTs: string, createdAt: number) =>
      env.DB.prepare(
        `INSERT INTO runs (id, "key", origin, channel_id, thread_ts, status, summary, created_at, updated_at)
         VALUES (?, ?, 'slack', 'C1', ?, ?, NULL, ?, ?)`,
      )
        .bind(id, `slack:C1:${threadTs}:${id}`, threadTs, status, createdAt, createdAt)
        .run();

    it("wakes anyway when the thread's last run failed", async () => {
      await seedMessage("Ev1", { ts: "2.0", thread_ts: "1.0", text: "any luck?" });
      await seedRun("r-dead", "failed", "1.0", 1000);
      const woke: unknown[] = [];

      await handleTriageBatch(batchOf(["Ev1"]).batch, env, {
        triage: async () => declineOutcome,
        memory: new FakeMemoryStore(),
        wakeRun: async (m) => void woke.push(m),
      });

      const row = await env.DB.prepare("SELECT wake, why, opening_prompt FROM triage_decisions WHERE event_id = 'Ev1'")
        .first<{ wake: number; why: string; opening_prompt: string }>();
      expect(row?.wake).toBe(1);
      expect(row?.why).toContain("abandoned-thread override");
      // A declining decision has no reason to carry a usable prompt, so the
      // override must supply one rather than wake the agent with "".
      expect(row?.opening_prompt).toContain("any luck?");
      expect(woke).toHaveLength(1);
    });

    it("leaves an idle run's thread to the model's judgement", async () => {
      await seedMessage("Ev1", { ts: "2.0", thread_ts: "1.0" });
      await seedRun("r-idle", "idle", "1.0", 1000);

      await handleTriageBatch(batchOf(["Ev1"]).batch, env, {
        triage: async () => declineOutcome,
        memory: new FakeMemoryStore(),
      });

      // `idle` means waiting on the customer -- healthy, and exactly the case
      // triage exists to judge. Overriding it would wake a run per follow-up.
      const row = await env.DB.prepare("SELECT wake, opening_prompt FROM triage_decisions WHERE event_id = 'Ev1'")
        .first<{ wake: number; opening_prompt: string }>();
      expect(row?.wake).toBe(0);
      // The "previous attempt failed" fallback belongs to the override only.
      // Storing it on an ordinary decline made the table say a run had died
      // when none had.
      expect(row?.opening_prompt).not.toContain("previous attempt");
      expect(row?.opening_prompt).toBe("");
    });

    it("stops overriding once a later run succeeds", async () => {
      await seedMessage("Ev1", { ts: "3.0", thread_ts: "1.0" });
      await seedRun("r-dead", "failed", "1.0", 1000);
      await seedRun("r-ok", "idle", "1.0", 2000);

      await handleTriageBatch(batchOf(["Ev1"]).batch, env, {
        triage: async () => declineOutcome,
        memory: new FakeMemoryStore(),
      });

      // Newest run only. A thread that failed once and then recovered must not
      // be forced awake for the rest of its life.
      const row = await env.DB.prepare("SELECT wake FROM triage_decisions WHERE event_id = 'Ev1'")
        .first<{ wake: number }>();
      expect(row?.wake).toBe(0);
    });

    it("does not touch a decision the model already wanted to wake", async () => {
      await seedMessage("Ev1", { ts: "2.0", thread_ts: "1.0" });
      await seedRun("r-dead", "failed", "1.0", 1000);

      await handleTriageBatch(batchOf(["Ev1"]).batch, env, {
        triage: async () => wakeOutcome,
        memory: new FakeMemoryStore(),
      });

      const row = await env.DB.prepare("SELECT why, opening_prompt FROM triage_decisions WHERE event_id = 'Ev1'")
        .first<{ why: string; opening_prompt: string }>();
      expect(row?.why).toBe("direct question");
      expect(row?.opening_prompt).toBe("Customer asks about language variants.");
    });
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
