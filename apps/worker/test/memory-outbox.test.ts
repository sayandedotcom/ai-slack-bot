import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  claimOutboxRow,
  ensureOutboxRow,
  listDueOutboxRows,
  OUTBOX_LEASE_MS,
  outboxRetryBackoffMs,
  recordEpisodeUuid,
} from "../src/memory/outbox";
import { projectAgentEpisode } from "../src/memory/consumer";
import { sweepMemoryOutbox } from "../src/memory/sweeper";
import { ZEP_REQUEST_TIMEOUT_SECONDS } from "../src/memory/zep";
import { cite } from "../src/memory/cite";
import { createOrGetRun } from "../src/run/repository";
import { chatRunKey } from "../src/run/keys";
import type { AddEpisodeInput, MemoryStore } from "../src/memory/store";
import type { AgentEpisode, EpisodeSourceDescriptor } from "../src/memory/episode";
import type { MemoryJob } from "../src/memory/consumer";

/**
 * The claim protocol, and the exact shape of the duplicate window it does and
 * does not close.
 *
 * Zep is faked at the `MemoryStore` seam — nothing here reaches a vendor. What
 * is REAL is D1: every claim, fence and sweep below runs the production SQL
 * against the real migrated database, because the whole protocol is a claim
 * about what a single `UPDATE … RETURNING` guarantees.
 */

const EPISODE: AgentEpisode = {
  asked: "why are exports empty",
  actions: ["slack.thread", "supabase.query"],
  draft: "the 04:12 deploy dropped the export worker",
  outcome: "completed",
  run_id: "placeholder",
  agent_turn_id: "agent:gen_x",
};

/** A store that records calls and can be made to hang or fail on demand. */
class ControllableStore implements MemoryStore {
  calls: AddEpisodeInput[] = [];
  private gate: Promise<void> | null = null;
  private release: (() => void) | null = null;
  failWith: string | null = null;
  /**
   * Unique across the whole file: D1 is shared by every case in this pool, and
   * a reused episode uuid would let one case read another's source rows.
   */
  private readonly prefix = crypto.randomUUID();
  private counter = 0;

  blockNext(): void {
    this.gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  releaseAll(): void {
    this.release?.();
    this.gate = null;
    this.release = null;
  }

  async ensureGraph(): Promise<void> {}

  async addEpisode(input: AddEpisodeInput): Promise<{ episodeUuid: string }> {
    this.calls.push(input);
    if (this.gate) await this.gate;
    if (this.failWith !== null) throw new Error(this.failWith);
    return { episodeUuid: `zep-agent-${this.prefix}-${++this.counter}` };
  }

  async addMessage(graphId: string, data: string): Promise<{ episodeUuid: string }> {
    return this.addEpisode({ graphId, type: "message", data });
  }

  async search(): Promise<never[]> {
    return [];
  }
}

async function seedOutbox(
  overrides: {
    graphId?: string;
    episode?: Partial<AgentEpisode>;
    sources?: EpisodeSourceDescriptor[];
    episodeJson?: string;
  } = {},
): Promise<{ id: string; runId: string; generationId: string }> {
  const key = chatRunKey(crypto.randomUUID());
  const run = await createOrGetRun(env.DB, {
    key,
    origin: "chat",
    channelId: null,
    threadTs: null,
  });
  const generationId = `gen:${crypto.randomUUID()}`;
  const id = `memory:${run.id}:${generationId}`;
  await ensureOutboxRow(env.DB, {
    id,
    runId: run.id,
    generationId,
    graphId: overrides.graphId ?? "org",
    episodeJson:
      overrides.episodeJson ??
      JSON.stringify({ ...EPISODE, run_id: run.id, ...overrides.episode }),
    sourceJson: JSON.stringify(overrides.sources ?? []),
    now: 1_000,
  });
  return { id, runId: run.id, generationId };
}

async function readRow(id: string) {
  return env.DB.prepare(
    `SELECT state, attempts, claim_token, lease_expires_at, next_attempt_at,
            last_error, episode_uuid, projected_at
       FROM agent_memory_outbox WHERE id = ?`,
  )
    .bind(id)
    .first<{
      state: string;
      attempts: number;
      claim_token: string | null;
      lease_expires_at: number | null;
      next_attempt_at: number | null;
      last_error: string | null;
      episode_uuid: string | null;
      projected_at: number | null;
    }>();
}

describe("the lease/timeout relationship", () => {
  it("keeps the D1 claim lease strictly longer than the enforced Zep timeout", () => {
    // If this ever inverts, a healthy in-flight request has its row reclaimed
    // underneath it and the duplicate window becomes the NORMAL case.
    expect(OUTBOX_LEASE_MS).toBeGreaterThan(ZEP_REQUEST_TIMEOUT_SECONDS * 1000);
  });

  it("backs off without ever abandoning a row", () => {
    expect(outboxRetryBackoffMs(1)).toBeLessThan(outboxRetryBackoffMs(4));
    expect(outboxRetryBackoffMs(999)).toBeLessThanOrEqual(60 * 60_000);
  });
});

describe("the claim protocol", () => {
  it("lets exactly ONE of two concurrent deliveries call the vendor", async () => {
    const { id } = await seedOutbox();
    const store = new ControllableStore();
    // The barrier: the first claimant is inside `addEpisode` and holding its
    // lease when the second delivery arrives.
    store.blockNext();

    const first = projectAgentEpisode(env.DB, store, id, 2_000);
    // Give the first delivery time to take the claim before the second tries.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await projectAgentEpisode(env.DB, store, id, 2_001);

    expect(second).toMatchObject({ outcome: "noop" });
    store.releaseAll();
    const firstResult = await first;

    expect(firstResult).toMatchObject({ outcome: "projected" });
    // ONE vendor call for one logical episode. This is the property.
    expect(store.calls).toHaveLength(1);

    const row = await readRow(id);
    expect(row).toMatchObject({ state: "projected", claim_token: null });
    // The recorded uuid is the one the SINGLE vendor call returned.
    expect(row?.episode_uuid).toBe(
      firstResult.outcome === "projected" ? firstResult.episodeUuid : null,
    );
  });

  it("no-ops an ordinary redelivery of an already projected row", async () => {
    const { id } = await seedOutbox();
    const store = new ControllableStore();

    await projectAgentEpisode(env.DB, store, id, 2_000);
    const again = await projectAgentEpisode(env.DB, store, id, 3_000);

    expect(again).toMatchObject({ outcome: "noop" });
    expect(store.calls).toHaveLength(1);
  });

  it("refuses an old claimant's completion after its lease expired and a new claim took over", async () => {
    const { id } = await seedOutbox();

    // The old claimant takes the row.
    const old = await claimOutboxRow(env.DB, { id, now: 1_000 });
    expect(old.outcome).toBe("claimed");
    const oldToken = old.outcome === "claimed" ? old.claim.claimToken : "";

    // Its lease expires and a new delivery claims the row.
    const fresh = await claimOutboxRow(env.DB, { id, now: 1_000 + OUTBOX_LEASE_MS + 1 });
    expect(fresh.outcome).toBe("claimed");
    const freshToken = fresh.outcome === "claimed" ? fresh.claim.claimToken : "";
    expect(freshToken).not.toBe(oldToken);

    // The abandoned upstream call finally resolves and the old claimant tries
    // to write. It must not overwrite the newer claimant's state.
    const stale = await recordEpisodeUuid(env.DB, {
      id,
      claimToken: oldToken,
      episodeUuid: "zep-from-the-past",
      now: 9_999,
    });
    expect(stale).toEqual({ outcome: "stale_claim" });

    const row = await readRow(id);
    expect(row?.episode_uuid).toBeNull();
    expect(row?.claim_token).toBe(freshToken);
    expect(row?.state).toBe("projecting");
  });

  it("resumes from a recorded uuid instead of adding the episode a second time", async () => {
    const { id } = await seedOutbox();

    // Simulate a crash AFTER the vendor call and AFTER the uuid was recorded,
    // but before the sources and completion landed.
    const claim = await claimOutboxRow(env.DB, { id, now: 1_000 });
    const token = claim.outcome === "claimed" ? claim.claim.claimToken : "";
    await recordEpisodeUuid(env.DB, {
      id,
      claimToken: token,
      episodeUuid: "zep-already-created",
      now: 1_100,
    });

    // The lease expires, a fresh delivery arrives.
    const store = new ControllableStore();
    const result = await projectAgentEpisode(env.DB, store, id, 1_000 + OUTBOX_LEASE_MS + 1);

    expect(result).toMatchObject({ outcome: "projected", episodeUuid: "zep-already-created" });
    // The whole point: NO second vendor call, so no duplicate episode.
    expect(store.calls).toHaveLength(0);
    const row = await readRow(id);
    expect(row).toMatchObject({ state: "projected", episode_uuid: "zep-already-created" });
  });

  it("schedules a retry with a sterile message when the vendor fails", async () => {
    const { id } = await seedOutbox();
    const store = new ControllableStore();
    store.failWith = "zep 503\n  at Object.<anonymous> (/secret/path)";

    const result = await projectAgentEpisode(env.DB, store, id, 5_000);

    expect(result).toMatchObject({ outcome: "noop" });
    const row = await readRow(id);
    expect(row?.state).toBe("retry");
    expect(row?.attempts).toBe(1);
    expect(row?.claim_token).toBeNull();
    expect(row?.next_attempt_at ?? 0).toBeGreaterThan(5_000);
    expect(row?.last_error).toContain("zep 503");
    // Bounded and single-line, so a vendor page cannot fill the column.
    expect(row?.last_error?.length ?? 0).toBeLessThanOrEqual(300);
    expect(row?.last_error).not.toContain("\n");

    // And it is claimable again once the backoff has passed — never abandoned.
    const later = await claimOutboxRow(env.DB, { id, now: 5_000 + outboxRetryBackoffMs(1) + 1 });
    expect(later.outcome).toBe("claimed");
  });

  it("marks content that can never be delivered as terminally failed", async () => {
    const { id } = await seedOutbox({ episodeJson: "{not json" });
    const store = new ControllableStore();

    const result = await projectAgentEpisode(env.DB, store, id, 6_000);

    expect(result).toMatchObject({ outcome: "poisoned" });
    expect(store.calls).toHaveLength(0);
    const row = await readRow(id);
    expect(row?.state).toBe("failed");
    // A terminally failed row is NOT swept: retrying it forever would keep a
    // cron permanently armed on work that can never succeed.
    const due = await listDueOutboxRows(env.DB, { now: 10_000_000, limit: 50 });
    expect(due.map((r) => r.id)).not.toContain(id);
  });

  it("asks for a redelivery when the row is not there yet", async () => {
    const store = new ControllableStore();
    // Deploy skew or a read replica behind the queue. Throwing is what makes
    // the consumer retry rather than ack a job it never did.
    await expect(
      projectAgentEpisode(env.DB, store, "memory:nope:nope", 1_000),
    ).rejects.toThrow(/not found/);
  });

  it("never re-creates or overwrites a row that already exists", async () => {
    const { id, runId, generationId } = await seedOutbox();
    await projectAgentEpisode(env.DB, new ControllableStore(), id, 2_000);

    // A repair delivery of the SAME generation. It must not reset the state,
    // the attempts, or the body Zep has already ingested.
    const repair = await ensureOutboxRow(env.DB, {
      id,
      runId,
      generationId,
      graphId: "org",
      episodeJson: JSON.stringify({ ...EPISODE, draft: "a different answer" }),
      sourceJson: "[]",
      now: 8_000,
    });

    expect(repair.created).toBe(false);
    const row = await env.DB.prepare(
      "SELECT state, episode_json FROM agent_memory_outbox WHERE id = ?",
    )
      .bind(id)
      .first<{ state: string; episode_json: string }>();
    expect(row?.state).toBe("projected");
    expect(row?.episode_json).not.toContain("a different answer");
  });
});

/* ---------------------------------------------------------- provenance -- */

describe("source resolution and citation", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM messages WHERE event_id IN ('EvSrc1', 'EvGone')"),
      env.DB.prepare("DELETE FROM zep_episodes WHERE episode_uuid = 'zep_src'"),
    ]);
    await env.DB.prepare(
      `INSERT INTO messages (event_id, channel_id, ts, thread_ts, user_id, text, subtype, permalink, customer_slug, received_at)
       VALUES ('EvSrc1', 'CSRC', '1.1', NULL, 'U1', 'exports are empty', NULL, 'https://slack.example/archives/CSRC/p1', 'pulsefit', 1)`,
    ).run();
  });

  it("resolves a recalled episode uuid back to the real stored message", async () => {
    await env.DB.prepare(
      "INSERT INTO zep_episodes (episode_uuid, event_id, graph_id, created_at) VALUES ('zep_src', 'EvSrc1', 'customer:pulsefit', 1)",
    ).run();
    const { id } = await seedOutbox({
      sources: [{ kind: "zep_episode", ref: "zep_src" }],
    });

    const result = await projectAgentEpisode(env.DB, new ControllableStore(), id, 2_000);
    expect(result.outcome).toBe("projected");
    const episodeUuid = result.outcome === "projected" ? result.episodeUuid : "";

    const rows = await env.DB.prepare(
      "SELECT source_kind, message_event_id, permalink FROM memory_episode_sources WHERE episode_uuid = ?",
    )
      .bind(episodeUuid)
      .all<{ source_kind: string; message_event_id: string; permalink: string }>();
    expect(rows.results).toEqual([
      {
        source_kind: "slack_message",
        message_event_id: "EvSrc1",
        permalink: "https://slack.example/archives/CSRC/p1",
      },
    ]);

    // And a fact attributed to the AGENT episode now cites the real message.
    const citations = await cite(env.DB, [
      { factId: "edge_1", fact: "exports broke at 04:12", episodeUuids: [episodeUuid] },
    ]);
    expect(citations).toHaveLength(1);
    expect(citations[0].permalink).toBe("https://slack.example/archives/CSRC/p1");
  });

  it("drops a source that resolves to nothing rather than inventing a link", async () => {
    const { id } = await seedOutbox({
      sources: [
        { kind: "slack_message", ref: "EvGone" },
        { kind: "zep_episode", ref: "zep_missing" },
      ],
    });

    const result = await projectAgentEpisode(env.DB, new ControllableStore(), id, 2_000);
    const episodeUuid = result.outcome === "projected" ? result.episodeUuid : "";

    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM memory_episode_sources WHERE episode_uuid = ?",
    )
      .bind(episodeUuid)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);

    // No exact source means NO citation. Not a permalink assembled from a
    // channel and a timestamp.
    const citations = await cite(env.DB, [
      { factId: "edge_1", fact: "something", episodeUuids: [episodeUuid] },
    ]);
    expect(citations).toEqual([]);
  });

  it("returns no citation for an episode uuid nothing knows about", async () => {
    const citations = await cite(env.DB, [
      { factId: "edge_1", fact: "invented", episodeUuids: ["zep_never_existed"] },
    ]);
    expect(citations).toEqual([]);
  });
});

/* ------------------------------------------------------------- the sweep -- */

describe("the cron sweeper", () => {
  it("re-enqueues due rows and stays within its page", async () => {
    const seeded: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const { id } = await seedOutbox();
      seeded.push(id);
    }

    const sent: string[] = [];
    const sweepEnv = {
      ...env,
      MEMORY_QUEUE: {
        send: async (job: MemoryJob) => {
          if ("outboxId" in job) sent.push(job.outboxId);
        },
      },
    } as unknown as Parameters<typeof sweepMemoryOutbox>[0];

    const result = await sweepMemoryOutbox(sweepEnv, 2_000, 2);

    expect(result.due).toBe(2);
    expect(result.enqueued).toBe(2);
    expect(sent).toHaveLength(2);
    // Oldest first, and every id it sent is a real due row.
    for (const id of sent) expect(seeded).toContain(id);
  });

  it("recovers a row whose projecting lease expired, which is the DLQ backstop", async () => {
    const { id } = await seedOutbox();
    await claimOutboxRow(env.DB, { id, now: 1_000 });

    // Still leased: not due.
    const early = await listDueOutboxRows(env.DB, { now: 1_500, limit: 50 });
    expect(early.map((r) => r.id)).not.toContain(id);

    // Lease expired: due again, with no queue delivery and no alarm involved.
    const late = await listDueOutboxRows(env.DB, {
      now: 1_000 + OUTBOX_LEASE_MS + 1,
      limit: 50,
    });
    expect(late.map((r) => r.id)).toContain(id);
  });

  it("keeps sweeping after every queue retry is exhausted", async () => {
    const { id } = await seedOutbox();
    const store = new ControllableStore();
    store.failWith = "zep down";

    // Ten failures — far past any queue's retry budget.
    let now = 1_000;
    for (let i = 0; i < 10; i += 1) {
      await projectAgentEpisode(env.DB, store, id, now);
      now += outboxRetryBackoffMs(i + 1) + 1;
    }

    const row = await readRow(id);
    expect(row?.attempts).toBe(10);
    // Still `retry`, never terminally failed: exhausting a retry budget is
    // evidence a vendor was down, not evidence the work is undeliverable.
    expect(row?.state).toBe("retry");
    const due = await listDueOutboxRows(env.DB, { now: now + 1, limit: 50 });
    expect(due.map((r) => r.id)).toContain(id);
  });
});
