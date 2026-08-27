import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { backfillMemory } from "../src/api/backfill";
import { handleMemoryBatch, type MemoryJob } from "../src/memory/consumer";
import { FakeMemoryStore } from "./helpers/fake-memory";

function batchOf(eventIds: string[]) {
  const acked: string[] = [];
  const retried: string[] = [];
  const batch = {
    queue: "firefighter-memory",
    messages: eventIds.map((event_id) => ({
      body: { event_id } as MemoryJob,
      ack: () => acked.push(event_id),
      retry: () => retried.push(event_id),
    })),
  } as unknown as MessageBatch<MemoryJob>;
  return { batch, acked, retried };
}

async function seedMessage(eventId: string, channelId: string, text: string) {
  await env.DB.prepare(
    `INSERT INTO messages (event_id, channel_id, ts, thread_ts, user_id, text, subtype, permalink, customer_slug, received_at)
     VALUES (?, ?, '1.1', NULL, 'U1', ?, NULL, 'https://slack.example/p1', 'pulsefit', 1)`
  )
    .bind(eventId, channelId, text)
    .run();
}

// The suite shares one D1 instance with every other test file, and these tests
// reuse event ids across cases. Without this the second insert of 'Ev1' — or of
// channel C1 — fails on the primary key, and backfill would see leftover rows.
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM zep_episodes"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM events_seen"),
    env.DB.prepare("DELETE FROM channels"),
  ]);
  await env.DB.prepare(
    "INSERT INTO channels (channel_id, name, customer_slug, mode) VALUES ('C1', 'ext-pulsefit', 'pulsefit', 'live')"
  ).run();
});

describe("handleMemoryBatch", () => {
  it("writes the message to the customer graph and records the episode mapping", async () => {
    await seedMessage("Ev1", "C1", "checkout is broken");
    const store = new FakeMemoryStore();
    const { batch, acked } = batchOf(["Ev1"]);

    await handleMemoryBatch(batch, env, store);

    expect(store.episodes).toHaveLength(1);
    expect(store.episodes[0].graphId).toBe("customer:pulsefit");
    expect(store.episodes[0].data).toContain("checkout is broken");
    const row = await env.DB.prepare(
      "SELECT event_id, graph_id FROM zep_episodes WHERE event_id = 'Ev1'"
    ).first();
    expect(row).toMatchObject({
      event_id: "Ev1",
      graph_id: "customer:pulsefit",
    });
    expect(acked).toEqual(["Ev1"]);
  });

  it("is idempotent: an already-mapped event is acked without a second episode", async () => {
    await seedMessage("Ev1", "C1", "hello");
    const store = new FakeMemoryStore();
    await handleMemoryBatch(batchOf(["Ev1"]).batch, env, store);
    const { batch, acked } = batchOf(["Ev1"]);

    await handleMemoryBatch(batch, env, store);

    expect(store.episodes).toHaveLength(1);
    expect(acked).toEqual(["Ev1"]);
  });

  it("retries the failing message without failing the batch", async () => {
    await seedMessage("Ev1", "C1", "first");
    await seedMessage("Ev2", "C1", "second");
    const store = new FakeMemoryStore();
    store.failNextAdd = true;
    const { batch, acked, retried } = batchOf(["Ev1", "Ev2"]);

    await handleMemoryBatch(batch, env, store);

    expect(retried).toEqual(["Ev1"]);
    expect(acked).toEqual(["Ev2"]);
  });

  it("acks and skips messages whose channel has no graph", async () => {
    await seedMessage("Ev9", "C_UNKNOWN", "noise");
    const store = new FakeMemoryStore();
    const { batch, acked } = batchOf(["Ev9"]);

    await handleMemoryBatch(batch, env, store);

    expect(store.episodes).toHaveLength(0);
    expect(acked).toEqual(["Ev9"]);
  });
});

describe("backfillMemory", () => {
  it("enqueues only unmapped messages, capped", async () => {
    await seedMessage("EvA", "C1", "one");
    await seedMessage("EvB", "C1", "two");
    await env.DB.prepare(
      "INSERT INTO zep_episodes (episode_uuid, event_id, graph_id, created_at) VALUES ('ep-a', 'EvA', 'customer:pulsefit', 1)"
    ).run();
    const sent: string[] = [];
    const queue = {
      send: async (job: MemoryJob) =>
        void sent.push("event_id" in job ? job.event_id : ""),
    } as unknown as Queue<MemoryJob>;

    const enqueued = await backfillMemory(env.DB, queue, 100);

    expect(enqueued).toBe(1);
    expect(sent).toEqual(["EvB"]);
  });
});
