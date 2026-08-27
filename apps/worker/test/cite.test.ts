import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { cite } from "../src/memory/cite";
import type { MemoryFact } from "../src/memory/store";

describe("cite", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM zep_episodes"),
      env.DB.prepare("DELETE FROM messages"),
    ]);
    await env.DB.prepare(
      `INSERT INTO messages (event_id, channel_id, ts, thread_ts, user_id, text, subtype, permalink, customer_slug, received_at)
       VALUES ('Ev1', 'C1', '1.1', NULL, 'U1', 'checkout broke', NULL, 'https://zellify.slack.com/archives/C1/p11', 'pulsefit', 1)`
    ).run();
    await env.DB.prepare(
      "INSERT INTO zep_episodes (episode_uuid, event_id, graph_id, created_at) VALUES ('ep-1', 'Ev1', 'customer:pulsefit', 1)"
    ).run();
  });

  it("resolves a fact to the stored permalink", async () => {
    const facts: MemoryFact[] = [
      { factId: "edge-1", fact: "checkout broke", episodeUuids: ["ep-1"] },
    ];
    const citations = await cite(env.DB, facts);
    expect(citations).toEqual([
      {
        factId: "edge-1",
        fact: "checkout broke",
        permalink: "https://zellify.slack.com/archives/C1/p11",
        channel_id: "C1",
        ts: "1.1",
      },
    ]);
  });

  it("returns nothing for a fact with no matching episode — never a fabricated URL", async () => {
    const facts: MemoryFact[] = [
      { factId: "edge-2", fact: "ghost", episodeUuids: ["ep-unknown"] },
    ];
    expect(await cite(env.DB, facts)).toEqual([]);
  });

  it("skips episodes whose message has no stored permalink", async () => {
    await env.DB.prepare(
      `INSERT INTO messages (event_id, channel_id, ts, thread_ts, user_id, text, subtype, permalink, customer_slug, received_at)
       VALUES ('Ev2', 'C1', '2.2', NULL, 'U1', 'no link', NULL, NULL, 'pulsefit', 2)`
    ).run();
    await env.DB.prepare(
      "INSERT INTO zep_episodes (episode_uuid, event_id, graph_id, created_at) VALUES ('ep-2', 'Ev2', 'customer:pulsefit', 2)"
    ).run();
    const facts: MemoryFact[] = [
      { factId: "edge-3", fact: "no link", episodeUuids: ["ep-2"] },
    ];
    expect(await cite(env.DB, facts)).toEqual([]);
  });
});
