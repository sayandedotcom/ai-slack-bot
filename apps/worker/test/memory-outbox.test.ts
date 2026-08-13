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
import { readGenerationMemory } from "../src/run/session";
import { resolutionTurnContent } from "../src/approval/contracts";
import type { AddEpisodeInput, MemoryStore } from "../src/memory/store";
import type { AgentEpisode, EpisodeSourceDescriptor } from "../src/memory/episode";
import type { MemoryJob } from "../src/memory/consumer";
import type { RunTurnInput } from "../src/run/protocol";
import { customerTurn, freshLoopRun, mockModel, textStep } from "./helpers/agent-loop";

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

  it("warns when a retried claim may have left a duplicate episode in Zep", async () => {
    const { id } = await seedOutbox();
    const store = new ControllableStore();

    // Attempt one reaches the vendor and fails, so a later attempt cannot know
    // whether an episode was created. This IS the documented window.
    store.failWith = "zep 503";
    await projectAgentEpisode(env.DB, store, id, 1_000);

    const warnings: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args);
    try {
      store.failWith = null;
      const result = await projectAgentEpisode(
        env.DB,
        store,
        id,
        1_000 + outboxRetryBackoffMs(1) + 1,
      );
      expect(result).toMatchObject({ outcome: "projected", duplicateEpisodeRisk: true });
    } finally {
      console.warn = original;
    }

    // The flag is not merely returned — it is EMITTED, so the window is
    // countable in production rather than only described in a docblock.
    const duplicateWarning = warnings.find(
      (args) => typeof args[0] === "string" && args[0].includes("possible duplicate"),
    );
    expect(duplicateWarning).toBeDefined();
    expect(duplicateWarning?.[1]).toMatchObject({ outboxId: id, attempt: 2 });
  });

  it("does not warn on a clean first-attempt projection", async () => {
    const { id } = await seedOutbox();
    const warnings: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args);
    try {
      const result = await projectAgentEpisode(env.DB, new ControllableStore(), id, 2_000);
      expect(result).toMatchObject({ outcome: "projected", duplicateEpisodeRisk: false });
    } finally {
      console.warn = original;
    }
    expect(
      warnings.filter((args) => typeof args[0] === "string" && args[0].includes("duplicate")),
    ).toEqual([]);
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
    // D1 is shared across every case in this pool, so each case re-seeds the
    // exact rows it needs rather than trusting what a neighbour left behind.
    await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM messages WHERE event_id IN
           ('EvSrc1', 'EvGone', 'EvQuestion', 'EvOldQuestion', 'EvOnly')`,
      ),
      env.DB.prepare(
        "DELETE FROM zep_episodes WHERE episode_uuid IN ('zep_src', 'zep_evidence')",
      ),
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

  it("cites the evidence a Slack run READ, not the customer question it answered", async () => {
    // THE SLACK PATH, which is where this went wrong. A Slack input turn
    // carries an `eventId`, so unlike Chat it produces a real, resolvable
    // `run_turn` source — and if it out-ranks the tool read, the citation for
    // "why are exports empty?" is the customer asking the question rather than
    // the engineer's message that answers it.
    await env.DB.prepare(
      `INSERT INTO messages (event_id, channel_id, ts, thread_ts, user_id, text, subtype, permalink, customer_slug, received_at)
       VALUES ('EvQuestion', 'CSRC', '1.0', NULL, 'UCUST', 'why are exports empty?', NULL, 'https://slack.example/archives/CSRC/pQUESTION', 'pulsefit', 1)`,
    ).run();
    await env.DB.prepare(
      "INSERT INTO zep_episodes (episode_uuid, event_id, graph_id, created_at) VALUES ('zep_evidence', 'EvSrc1', 'customer:pulsefit', 1)",
    ).run();

    const { id } = await seedOutbox({
      // Exactly the order `buildGenerationEpisodePayload` produces: what the
      // agent READ, then what it was ANSWERING.
      sources: [
        { kind: "zep_episode", ref: "zep_evidence" },
        { kind: "run_turn", ref: "EvQuestion", turnId: "t1" },
      ],
    });

    const result = await projectAgentEpisode(env.DB, new ControllableStore(), id, 2_000);
    const episodeUuid = result.outcome === "projected" ? result.episodeUuid : "";

    // BOTH are recorded — the question is real provenance and is not discarded.
    const rows = await env.DB.prepare(
      "SELECT source_kind, message_event_id FROM memory_episode_sources WHERE episode_uuid = ? ORDER BY source_index",
    )
      .bind(episodeUuid)
      .all<{ source_kind: string; message_event_id: string }>();
    expect(rows.results.map((r) => r.message_event_id)).toEqual(["EvSrc1", "EvQuestion"]);

    // But the citation points at the EVIDENCE.
    const citations = await cite(env.DB, [
      { factId: "edge_1", fact: "the 04:12 deploy dropped the export worker", episodeUuids: [episodeUuid] },
    ]);
    expect(citations[0].permalink).toBe("https://slack.example/archives/CSRC/p1");
    expect(citations[0].permalink).not.toContain("pQUESTION");
  });

  it("repairs an episode already written with the question at index 0", async () => {
    // Rows projected BEFORE the ordering fix carry `run_turn` at source_index
    // 0. Only the read-side rule can rescue those, which is why the ordering
    // is enforced in `cite()` as well as in the payload.
    await env.DB.prepare(
      `INSERT INTO messages (event_id, channel_id, ts, thread_ts, user_id, text, subtype, permalink, customer_slug, received_at)
       VALUES ('EvOldQuestion', 'CSRC', '1.0', NULL, 'UCUST', 'why?', NULL, 'https://slack.example/archives/CSRC/pOLDQ', 'pulsefit', 1)`,
    ).run();
    const episodeUuid = `legacy-${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO memory_episode_sources (episode_uuid, source_index, source_kind, message_event_id, run_id, turn_id, permalink, created_at)
         VALUES (?, 0, 'run_turn', 'EvOldQuestion', 'run_old', 't1', 'https://slack.example/archives/CSRC/pOLDQ', 1)`,
      ).bind(episodeUuid),
      env.DB.prepare(
        `INSERT INTO memory_episode_sources (episode_uuid, source_index, source_kind, message_event_id, run_id, turn_id, permalink, created_at)
         VALUES (?, 1, 'slack_message', 'EvSrc1', 'run_old', NULL, 'https://slack.example/archives/CSRC/p1', 1)`,
      ).bind(episodeUuid),
    ]);

    const citations = await cite(env.DB, [
      { factId: "edge_1", fact: "exports broke", episodeUuids: [episodeUuid] },
    ]);
    expect(citations[0].permalink).toBe("https://slack.example/archives/CSRC/p1");
  });

  it("still cites the input turn when it is the only exact source", async () => {
    // The rule is a PREFERENCE, not an exclusion. A generation that read
    // nothing still has provenance, and dropping it would trade a mildly
    // unhelpful citation for no citation at all.
    await env.DB.prepare(
      `INSERT INTO messages (event_id, channel_id, ts, thread_ts, user_id, text, subtype, permalink, customer_slug, received_at)
       VALUES ('EvOnly', 'CSRC', '1.0', NULL, 'UCUST', 'just asking', NULL, 'https://slack.example/archives/CSRC/pONLY', 'pulsefit', 1)`,
    ).run();
    const { id } = await seedOutbox({
      sources: [{ kind: "run_turn", ref: "EvOnly", turnId: "t1" }],
    });

    const result = await projectAgentEpisode(env.DB, new ControllableStore(), id, 2_000);
    const episodeUuid = result.outcome === "projected" ? result.episodeUuid : "";

    const citations = await cite(env.DB, [
      { factId: "edge_1", fact: "they asked", episodeUuids: [episodeUuid] },
    ]);
    expect(citations[0].permalink).toBe("https://slack.example/archives/CSRC/pONLY");
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

/* ------------------------------------------------ approval outcomes -- */

/**
 * Phase 11 adds no memory pipeline for approval outcomes — invariant 13 says
 * they reach memory "through the existing outbox", and this is the proof.
 *
 * `appendTurn` already accepts `source: "approval"` (`TURN_SOURCES` in
 * `run/session.ts`) and it is already in `WAKE_TURN_SOURCES`, so a turn
 * carrying a rejection reason or an edited draft is not a new kind of input —
 * it is read by `readAsked()` exactly like a customer message or a steer, and
 * becomes the `asked` field of whatever generation answers it next. Nothing
 * downstream (`buildAgentEpisode`, the outbox, the Zep projector) needs to
 * know approvals exist at all.
 *
 * This test still does not drive a real dashboard PATCH or the driver's
 * `paused` continuation outcome end to end — that is `test/approval-e2e.test.ts`
 * and `test/approval-resolution.test.ts`'s job. What it proves here is that an
 * `approval`-sourced turn's content is ordinary input: it uses the real
 * `resolutionTurnContent` (`src/approval/contracts.ts`) to build the turn, so
 * the exact prose a resolution actually carries — including the rejected
 * draft and the edited-away original — is what gets asserted into the next
 * generation's episode, not a hand-shaped stand-in for it.
 */
describe("approval outcomes reach memory through the existing outbox", () => {
  it("carries a rejection reason and the original draft into the FOLLOWING generation's episode", async () => {
    const harness = await freshLoopRun({
      origin: "slack",
      model: mockModel([
        textStep({ chunks: ["Refund approved, will process by Friday."] }),
        textStep({ chunks: ["Understood — holding off on any refund promise."] }),
      ]),
    });

    await harness.stub.appendTurn(customerTurn("t1", "can I get a refund for this month?"));
    await harness.alarm();

    // Built with the REAL `resolutionTurnContent` — Task 5's actual construction
    // of an `approval`-sourced turn's content, not a stand-in for its shape.
    // A hand-written literal here would stop testing the requirement the
    // moment `resolutionTurnContent` changed underneath it; using the real
    // function is what keeps this test honest about what it proves.
    const rejectionTurn: RunTurnInput = {
      id: "t2",
      role: "user",
      source: "approval",
      content: resolutionTurnContent({
        decision: "rejected",
        text: null,
        reason: "needs manager sign-off before any refund promise",
        draft: "Refund approved, will process by Friday.",
        delivery: "none",
        deliveryError: null,
      }),
    };
    await harness.stub.appendTurn(rejectionTurn);
    await harness.alarm();

    const generationIds = await harness.storage((storage) =>
      storage.sql
        .exec<{ id: string }>("SELECT id FROM agent_generations ORDER BY created_at ASC")
        .toArray()
        .map((row) => row.id),
    );
    expect(generationIds).toHaveLength(2);

    const secondMemory = await harness.storage((storage) =>
      readGenerationMemory(storage, generationIds[1]),
    );
    expect(secondMemory).not.toBeNull();
    const episode = JSON.parse(secondMemory?.episodeJson ?? "{}") as { asked: string };
    expect(episode.asked).toContain("A human REJECTED");
    expect(episode.asked).toContain("needs manager sign-off");
    expect(episode.asked).toContain("Refund approved, will process by Friday");
  });

  it("carries an edit's human text beside the model's own draft", async () => {
    const harness = await freshLoopRun({
      origin: "slack",
      model: mockModel([
        textStep({ chunks: ["We'll ship the fix by end of day."] }),
        textStep({ chunks: ["Noted — sending the reviewed wording instead."] }),
      ]),
    });

    await harness.stub.appendTurn(customerTurn("t1", "when will this be fixed?"));
    await harness.alarm();

    // Built with the REAL `resolutionTurnContent`, same reasoning as the
    // rejection case above: this is what Task 5 actually constructs, not a
    // hand-written stand-in for its shape.
    const editTurn: RunTurnInput = {
      id: "t2",
      role: "user",
      source: "approval",
      content: resolutionTurnContent({
        decision: "edited",
        text: "We are actively working on a fix, no ETA yet.",
        reason: null,
        draft: "We'll ship the fix by end of day.",
        delivery: "blocked",
        deliveryError: "identity_unavailable",
      }),
    };
    await harness.stub.appendTurn(editTurn);
    await harness.alarm();

    const generationIds = await harness.storage((storage) =>
      storage.sql
        .exec<{ id: string }>("SELECT id FROM agent_generations ORDER BY created_at ASC")
        .toArray()
        .map((row) => row.id),
    );
    expect(generationIds).toHaveLength(2);

    const secondMemory = await harness.storage((storage) =>
      readGenerationMemory(storage, generationIds[1]),
    );
    const episode = JSON.parse(secondMemory?.episodeJson ?? "{}") as { asked: string };
    // The human's actual words, beside the model's own draft — both present,
    // because the turn content carries both and `readAsked()` copies it whole.
    expect(episode.asked).toContain("We are actively working on a fix, no ETA yet");
    expect(episode.asked).toContain("We'll ship the fix by end of day");
  });

  /**
   * THE BOUNDARY CASE `EPISODE_LIMITS.asked` (1,000 chars) actually exercises.
   * Both cases above use short fixed strings well under the cap, so neither
   * touches `boundedEpisodeText`'s truncation at all — this one deliberately
   * does, with realistic-length inputs.
   *
   * The edited branch's field order is `[opening, text, superseded draft,
   * deliveryLine]` — deliveryLine LAST, deliberately, mirroring the rejected
   * branch's reasoning (`src/approval/contracts.ts`): `readAsked()` truncates
   * this episode's `asked` from the TAIL (`boundedEpisodeText` keeps
   * `slice(0, max-1)`), so whichever field sits last is what a long turn
   * sacrifices. The delivery line ("it will not be sent automatically…") is
   * the least valuable thing for a FUTURE memory recall to keep — a later
   * recall wants to know what was edited and how, not that one particular
   * message once needed a human to send it by hand — so it is placed where
   * truncation eats it first, and the edited text and the superseded draft
   * are placed where truncation protects them.
   *
   * This is NOT true of the model's own LIVE transcript: `toInputModelMessage`
   * (`src/agent/prompt/evidence.ts`) carries `turn.content` whole, with no
   * length cap, so the model itself always sees the full delivery instruction
   * regardless of length. The cap below is a property of the MEMORY episode
   * only.
   */
  it("protects the edited text and the superseded draft from the episode cap, at the delivery line's expense", async () => {
    const longText =
      "We are actively working on the migration fix and expect it to be fully rolled out within the next " +
      "two business days, pending final validation from the infra team, and we will follow up the moment " +
      "the rollout completes so you have a confirmed date to share with your own stakeholders internally.";
    const longDraft =
      "We can have the migration completely finished and verified in production by end of day tomorrow, " +
      "no further validation steps required on our side, and the customer-facing dashboards will already " +
      "reflect the new numbers by then without any additional confirmation needed from anyone else.";

    const harness = await freshLoopRun({
      origin: "slack",
      model: mockModel([
        textStep({ chunks: [longDraft] }),
        textStep({ chunks: ["Noted — sending the reviewed wording instead."] }),
      ]),
    });

    await harness.stub.appendTurn(customerTurn("t1", "when will the migration be done?"));
    await harness.alarm();

    const editTurn: RunTurnInput = {
      id: "t2",
      role: "user",
      source: "approval",
      content: resolutionTurnContent({
        decision: "edited",
        text: longText,
        reason: null,
        draft: longDraft,
        delivery: "blocked",
        deliveryError: "identity_unavailable",
      }),
    };
    // Confirm the fixture actually crosses the cap before trusting anything
    // the episode does with it — a boundary test that never reaches the
    // boundary proves nothing.
    expect(editTurn.content.replace(/\s+/g, " ").trim().length).toBeGreaterThan(1000);

    await harness.stub.appendTurn(editTurn);
    await harness.alarm();

    const generationIds = await harness.storage((storage) =>
      storage.sql
        .exec<{ id: string }>("SELECT id FROM agent_generations ORDER BY created_at ASC")
        .toArray()
        .map((row) => row.id),
    );
    expect(generationIds).toHaveLength(2);

    const secondMemory = await harness.storage((storage) =>
      readGenerationMemory(storage, generationIds[1]),
    );
    const episode = JSON.parse(secondMemory?.episodeJson ?? "{}") as { asked: string };

    expect(episode.asked.length).toBeLessThanOrEqual(1000);
    // WHAT SURVIVES: the edited text and the superseded draft, whole.
    expect(episode.asked).toContain(longText);
    expect(episode.asked).toContain(longDraft);
    // WHAT DOES NOT: the delivery line's own closing instruction, cut off
    // mid-sentence — proof the LAST field is what a long turn sacrifices,
    // not the two the plan actually needs memory to keep.
    expect(episode.asked).not.toContain("do not try to send it another way");
    expect(episode.asked.endsWith("…")).toBe(true);
  });
});
