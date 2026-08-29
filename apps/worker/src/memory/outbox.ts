import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { orm } from "../db/client";
import type { AgentMemoryOutboxRow } from "../db/schema";
import { agentMemoryOutbox } from "../db/tables";
import { ZEP_REQUEST_TIMEOUT_SECONDS } from "./zep";

/**
 * The D1 side of agent-memory projection: the claim protocol, its fence, and
 * the sweep.
 *
 * WHY A CLAIM AT ALL. `graph.add` accepts no client-supplied episode id and no
 * idempotency key — verified against the installed `@getzep/zep-cloud@3.27.0`
 * declarations and the Zep docs MCP, whose complete request body is `data`,
 * `type`, `createdAt?`, `graphId?`, `metadata?`, `sourceDescription?`,
 * `strictOntology?`, `userId?`. So the vendor cannot deduplicate for us and a
 * second delivery of the same job would create a second semantic episode. The
 * row is therefore claimed BEFORE the call, and another delivery cannot pass
 * that claim.
 *
 * THE WINDOW WE DO NOT CLOSE, stated here because it must not be papered over.
 * A crash after `graph.add` returns and before the completion below commits
 * leaves a real episode in Zep that D1 has no record of; the lease then expires
 * and a fresh claim adds it again. Likewise, after a lease expires an abandoned
 * upstream call can still resolve while the new claimant is retrying. In both
 * cases D1 stays EXACT — one outbox row, one recorded episode uuid, one set of
 * source rows — while Zep delivery is at-least-once and may contain a physical
 * duplicate. This is a bounded, documented window, not exactly-once projection,
 * and nothing in this file should be read as claiming otherwise.
 */

/**
 * How long a claim owns the row.
 *
 * Strictly longer than the enforced Zep request timeout, and asserted below so
 * the relationship cannot rot when either constant is edited. If the lease were
 * shorter, a healthy in-flight request would routinely have its row reclaimed
 * underneath it and the duplicate window would become the normal case rather
 * than the crash case.
 */
export const OUTBOX_LEASE_MS = 60_000;

const ZEP_REQUEST_TIMEOUT_MS = ZEP_REQUEST_TIMEOUT_SECONDS * 1000;

if (OUTBOX_LEASE_MS <= ZEP_REQUEST_TIMEOUT_MS) {
  // Module load, not a test: this is an invariant of the protocol, and a build
  // that violates it should not start.
  throw new Error(
    `the outbox lease (${OUTBOX_LEASE_MS}ms) must exceed the Zep request timeout (${ZEP_REQUEST_TIMEOUT_MS}ms)`
  );
}

/** Backoff for a failed projection attempt, capped so it stays operable. */
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 60 * 60_000;

export function outboxRetryBackoffMs(attempts: number): number {
  const exponent = Math.min(Math.max(0, attempts - 1), 12);
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** exponent);
}

/** Bounded so one poisoned row cannot fill the column with a vendor page. */
const ERROR_MAX = 300;

export function sterileError(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, ERROR_MAX);
}

export type OutboxClaim = {
  id: string;
  runId: string;
  generationId: string;
  graphId: string;
  episodeJson: string;
  sourceJson: string;
  attempts: number;
  /**
   * Non-null when a PREVIOUS attempt reached Zep and then crashed. The
   * projector resumes from it instead of adding the episode a second time,
   * which is the largest single reduction available in the duplicate window.
   */
  episodeUuid: string | null;
  claimToken: string;
  leaseExpiresAt: number;
};

export type OutboxClaimOutcome =
  | { outcome: "claimed"; claim: OutboxClaim }
  /** Another delivery owns the lease, it is already projected, or backoff. */
  | { outcome: "not_claimable" }
  | { outcome: "unknown_row" };

/**
 * Create the row if it is not there, and never touch it if it is.
 *
 * `DO NOTHING` rather than an upsert: the episode payload was frozen in the
 * generation's finalization transaction and is immutable. A repair delivery
 * arriving after the row has already been claimed or projected must not
 * overwrite its state, reset its attempts, or replace a body Zep has already
 * ingested. Re-finalizing the same generation therefore neither changes nor
 * duplicates the episode.
 */
export async function ensureOutboxRow(
  db: D1Database,
  row: {
    id: string;
    runId: string;
    generationId: string;
    graphId: string;
    episodeJson: string;
    sourceJson: string;
    now: number;
  }
): Promise<{ created: boolean }> {
  const result = await orm(db)
    .insert(agentMemoryOutbox)
    .values({
      id: row.id,
      run_id: row.runId,
      generation_id: row.generationId,
      graph_id: row.graphId,
      episode_json: row.episodeJson,
      source_json: row.sourceJson,
      state: "pending",
      attempts: 0,
      next_attempt_at: row.now,
      created_at: row.now,
      updated_at: row.now,
    })
    .onConflictDoNothing()
    .run();
  return { created: (result.meta.changes ?? 0) > 0 };
}

/**
 * The atomic claim. This is the heart of the protocol.
 *
 * ONE statement, so the read of `state` and the write of `projecting` cannot be
 * separated by another delivery. A row is claimable when it is due `pending` or
 * `retry`, or when it is `projecting` under an EXPIRED lease. `projected` never
 * matches, which is what makes an ordinary duplicate delivery a no-op.
 *
 * `attempts` increments here, at claim time, rather than on failure. A claimant
 * that crashes mid-call never reaches a failure path, and an attempt counter
 * that only counted clean failures would sit at zero while a poisoned row
 * looped forever.
 */
export async function claimOutboxRow(
  db: D1Database,
  input: { id: string; now: number; leaseMs?: number }
): Promise<OutboxClaimOutcome> {
  const claimToken = crypto.randomUUID();
  const leaseExpiresAt = input.now + (input.leaseMs ?? OUTBOX_LEASE_MS);

  // STILL ONE STATEMENT. `attempts + 1` is a bound `sql` fragment over the
  // column, and the compound claimability predicate is the same disjunction
  // built with `and`/`or`, so the read of `state` and the write of `projecting`
  // remain inseparable — which is the entire protocol.
  const [claimed] = await orm(db)
    .update(agentMemoryOutbox)
    .set({
      state: "projecting",
      claim_token: claimToken,
      lease_expires_at: leaseExpiresAt,
      attempts: sql`${agentMemoryOutbox.attempts} + 1`,
      updated_at: input.now,
    })
    .where(
      and(
        eq(agentMemoryOutbox.id, input.id),
        or(
          and(
            inArray(agentMemoryOutbox.state, ["pending", "retry"]),
            or(
              isNull(agentMemoryOutbox.next_attempt_at),
              lte(agentMemoryOutbox.next_attempt_at, input.now)
            )
          ),
          and(
            eq(agentMemoryOutbox.state, "projecting"),
            or(
              isNull(agentMemoryOutbox.lease_expires_at),
              lte(agentMemoryOutbox.lease_expires_at, input.now)
            )
          )
        )
      )
    )
    .returning({
      id: agentMemoryOutbox.id,
      run_id: agentMemoryOutbox.run_id,
      generation_id: agentMemoryOutbox.generation_id,
      graph_id: agentMemoryOutbox.graph_id,
      episode_json: agentMemoryOutbox.episode_json,
      source_json: agentMemoryOutbox.source_json,
      attempts: agentMemoryOutbox.attempts,
      episode_uuid: agentMemoryOutbox.episode_uuid,
    });

  if (claimed) {
    return {
      outcome: "claimed",
      claim: {
        id: claimed.id,
        runId: claimed.run_id,
        generationId: claimed.generation_id,
        graphId: claimed.graph_id,
        episodeJson: claimed.episode_json,
        sourceJson: claimed.source_json,
        attempts: claimed.attempts,
        episodeUuid: claimed.episode_uuid,
        claimToken,
        leaseExpiresAt,
      },
    };
  }

  // Nothing changed. Distinguishing "somebody else owns it" from "there is no
  // such row" matters to the caller: the first is an ack, the second may be
  // deploy skew worth retrying.
  const exists = await orm(db)
    .select({ present: sql<number>`1` })
    .from(agentMemoryOutbox)
    .where(eq(agentMemoryOutbox.id, input.id))
    .get();
  return exists ? { outcome: "not_claimable" } : { outcome: "unknown_row" };
}

export type FencedOutcome = { outcome: "applied" } | { outcome: "stale_claim" };

/**
 * `id = ? AND claim_token = ? AND state = 'projecting'` — the fence, written
 * once and shared by the three writes that must carry it. Previously it was
 * three copies of the same WHERE clause in three SQL strings; a builder makes
 * it a value, so a fence that gets weakened gets weakened in one place, under
 * review, rather than in two of three statements by accident.
 */
function fencedToClaim(id: string, claimToken: string) {
  return and(
    eq(agentMemoryOutbox.id, id),
    eq(agentMemoryOutbox.claim_token, claimToken),
    eq(agentMemoryOutbox.state, "projecting")
  );
}

/**
 * Record the uuid Zep returned, FENCED to the claim token, while the row stays
 * `projecting`.
 *
 * This is deliberately its own write rather than part of the completion. It is
 * the first durable trace that the vendor call happened, and the gap between
 * `graph.add` returning and this committing is the entire duplicate window. The
 * narrower that gap, the smaller the window — so nothing else happens in
 * between, and in particular the source resolution (which is several more D1
 * reads) happens afterwards.
 *
 * The fence is what stops an old claimant — one whose lease expired while its
 * request hung, and whose call then resolved — from overwriting the newer
 * claimant's state. It reports `stale_claim`, and its caller then writes
 * nothing at all: the row already belongs to somebody else, and the episode the
 * old claimant created is the documented duplicate, not a reason to corrupt D1.
 */
export async function recordEpisodeUuid(
  db: D1Database,
  input: { id: string; claimToken: string; episodeUuid: string; now: number }
): Promise<FencedOutcome> {
  const result = await orm(db)
    .update(agentMemoryOutbox)
    .set({ episode_uuid: input.episodeUuid, updated_at: input.now })
    .where(fencedToClaim(input.id, input.claimToken))
    .run();
  return (result.meta.changes ?? 0) > 0
    ? { outcome: "applied" }
    : { outcome: "stale_claim" };
}

/**
 * Release the row for a later attempt, FENCED to the same claim token.
 *
 * The state goes back to `retry`, never to a terminal `failed`, however many
 * attempts have been spent. Exhausting a retry budget is not evidence that the
 * work is undeliverable — it is usually evidence that a vendor was down for
 * longer than a queue's retry policy — and the sweeper exists precisely to keep
 * such a row moving after the queue has given up on it. `failed` is reserved
 * for `poisonOutboxRow`, below.
 */
export async function retryOutboxRow(
  db: D1Database,
  input: {
    id: string;
    claimToken: string;
    error: string;
    attempts: number;
    now: number;
    backoffMs?: number;
  }
): Promise<FencedOutcome> {
  const nextAttemptAt =
    input.now + (input.backoffMs ?? outboxRetryBackoffMs(input.attempts));
  const result = await orm(db)
    .update(agentMemoryOutbox)
    .set({
      state: "retry",
      claim_token: null,
      lease_expires_at: null,
      next_attempt_at: nextAttemptAt,
      last_error: sterileError(input.error),
      updated_at: input.now,
    })
    .where(fencedToClaim(input.id, input.claimToken))
    .run();
  return (result.meta.changes ?? 0) > 0
    ? { outcome: "applied" }
    : { outcome: "stale_claim" };
}

/**
 * Terminal failure for content that can never be delivered — an `episode_json`
 * that does not parse, a graph id that is not a graph. Retrying that forever is
 * a permanently armed cron on work that will never succeed. An operator can see
 * the row and its error; nothing retries it.
 */
export async function poisonOutboxRow(
  db: D1Database,
  input: { id: string; claimToken: string; error: string; now: number }
): Promise<FencedOutcome> {
  const result = await orm(db)
    .update(agentMemoryOutbox)
    .set({
      state: "failed",
      claim_token: null,
      lease_expires_at: null,
      next_attempt_at: null,
      last_error: sterileError(input.error),
      updated_at: input.now,
    })
    .where(fencedToClaim(input.id, input.claimToken))
    .run();
  return (result.meta.changes ?? 0) > 0
    ? { outcome: "applied" }
    : { outcome: "stale_claim" };
}

/**
 * A bounded page of rows the sweeper should re-enqueue: due `pending`, due
 * `retry`, and `projecting` under an expired lease.
 *
 * Bounded and ordered, because this runs every minute against a table that
 * grows with every generation forever. `failed` is excluded — see above.
 */
export async function listDueOutboxRows(
  db: D1Database,
  input: { now: number; limit: number }
): Promise<{ id: string; state: string; attempts: number }[]> {
  return orm(db)
    .select({
      id: agentMemoryOutbox.id,
      state: agentMemoryOutbox.state,
      attempts: agentMemoryOutbox.attempts,
    })
    .from(agentMemoryOutbox)
    .where(
      or(
        and(
          inArray(agentMemoryOutbox.state, ["pending", "retry"]),
          or(
            isNull(agentMemoryOutbox.next_attempt_at),
            lte(agentMemoryOutbox.next_attempt_at, input.now)
          )
        ),
        and(
          eq(agentMemoryOutbox.state, "projecting"),
          or(
            isNull(agentMemoryOutbox.lease_expires_at),
            lte(agentMemoryOutbox.lease_expires_at, input.now)
          )
        )
      )
    )
    .orderBy(
      asc(
        sql`coalesce(${agentMemoryOutbox.next_attempt_at}, ${agentMemoryOutbox.created_at})`
      )
    )
    .limit(Math.max(1, Math.min(input.limit, 200)))
    .all();
}
