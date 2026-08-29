import { and, eq, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { getChannelPolicy } from "../db/channels";
import { orm } from "../db/client";
import {
  agentMemoryOutbox,
  memoryEpisodeSources,
  messages,
  zepEpisodes,
} from "../db/tables";
import type { Env } from "../index";
import {
  type AgentEpisode,
  boundedMetadata,
  boundedSourceDescription,
  type EpisodeMetadata,
} from "./episode";
import { graphIdFor } from "./graphs";
import {
  claimOutboxRow,
  type OutboxClaim,
  poisonOutboxRow,
  recordEpisodeUuid,
  retryOutboxRow,
  sterileError,
} from "./outbox";
import { parseSourceDescriptors, resolveSources } from "./sources";
import type { MemoryStore } from "./store";

/**
 * Two projections, one queue.
 *
 * `message` is Phase 06's: one Zep episode per ingested customer message. It is
 * unchanged, and a legacy `{ event_id }` body still reaches it — see
 * `classifyMemoryJob`.
 *
 * `agent_generation` is Task 9's other half: what the agent was asked, what it
 * did, what it drafted and how it ended, projected from a claimed D1 outbox row
 * so a duplicate delivery cannot create a second episode.
 */
export type MemoryJob =
  | { kind: "message"; eventId: string }
  | { kind: "agent_generation"; outboxId: string }
  /**
   * Temporary queue compatibility. Jobs enqueued by the previous deploy are
   * already sitting in `firefighter-memory` when this one goes live, and a
   * consumer that rejected them would send every one of them to the DLQ. It
   * comes out once the queue has drained past the deploy — it is a migration
   * window, not a supported shape.
   */
  | { event_id: string };

/* ------------------------------------------------------------ validation -- */

export type ClassifiedMemoryJob =
  | { kind: "message"; eventId: string; legacy: boolean }
  | { kind: "agent_generation"; outboxId: string }
  | { kind: "unrecognized"; retryable: boolean; reason: string };

/**
 * Validate the body BEFORE branching on it.
 *
 * The distinction that matters is between a body this build cannot understand
 * YET and one it never will:
 *
 *  - a well-formed job carrying an unknown `kind` is deploy skew. A newer
 *    version of this Worker enqueued it and an older instance is draining the
 *    queue; retrying is right, because the newer instance will handle it.
 *  - anything else — a string, an array, a null, an object with neither `kind`
 *    nor `event_id` — can never become valid. Retrying it burns the queue's
 *    budget and then poisons the DLQ with something no future deploy will fix,
 *    so it is recorded and dropped instead.
 *
 * Neither outcome may throw. One malformed body must not take out the other
 * nine messages in its batch.
 */
export function classifyMemoryJob(body: unknown): ClassifiedMemoryJob {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return {
      kind: "unrecognized",
      retryable: false,
      reason: `memory job body was ${Array.isArray(body) ? "an array" : typeof body}`,
    };
  }

  const job = body as Record<string, unknown>;

  if (typeof job.kind === "string") {
    if (job.kind === "message") {
      return typeof job.eventId === "string" && job.eventId.length > 0
        ? { kind: "message", eventId: job.eventId, legacy: false }
        : {
            kind: "unrecognized",
            retryable: false,
            reason: "message job without eventId",
          };
    }
    if (job.kind === "agent_generation") {
      return typeof job.outboxId === "string" && job.outboxId.length > 0
        ? { kind: "agent_generation", outboxId: job.outboxId }
        : {
            kind: "unrecognized",
            retryable: false,
            reason: "agent_generation job without outboxId",
          };
    }
    // A shape a NEWER deploy understands. Hand it back to the queue.
    return {
      kind: "unrecognized",
      retryable: true,
      reason: `unknown memory job kind ${job.kind.slice(0, 40)}`,
    };
  }

  // The legacy shape, accepted for exactly as long as the queue may still hold
  // one. It is a `message` job that predates the discriminant.
  if (typeof job.event_id === "string" && job.event_id.length > 0) {
    return { kind: "message", eventId: job.event_id, legacy: true };
  }

  return {
    kind: "unrecognized",
    retryable: false,
    reason: "memory job matched no known shape",
  };
}

/* ---------------------------------------------------------- the consumer -- */

export async function handleMemoryBatch(
  batch: MessageBatch<MemoryJob>,
  env: Env,
  store: MemoryStore
): Promise<void> {
  for (const message of batch.messages) {
    const job = classifyMemoryJob(message.body);
    try {
      if (job.kind === "message") {
        await projectOne(job.eventId, env, store);
        message.ack();
        continue;
      }
      if (job.kind === "agent_generation") {
        // ACK even when the projection scheduled a retry, and the reason is
        // deliberate: a vendor failure has already been recorded DURABLY on the
        // D1 row with its own attempt count and backoff, and the one-minute
        // sweeper owns redelivery from there. Handing the message back instead
        // would spend the queue's five retries inside a single outage and then
        // drop the job into a DLQ, which is a worse place to recover from than
        // a row a cron already scans. A THROW still retries — that is reserved
        // for the case where the row could not be read at all.
        await projectAgentEpisode(env.DB, store, job.outboxId);
        message.ack();
        continue;
      }
      // Unrecognized. Retry only if a later deploy could make sense of it.
      if (job.retryable) {
        message.retry();
        continue;
      }
      console.warn("memory: dropping unusable job", { reason: job.reason });
      message.ack();
    } catch {
      message.retry();
    }
  }
}

/**
 * Projects D1 messages into Zep, one episode per message. D1 committed before
 * this job existed, so every failure path here is safe: retry re-reads the row,
 * and the zep_episodes check makes a duplicate delivery a no-op.
 */
async function projectOne(
  eventId: string,
  env: Env,
  store: MemoryStore
): Promise<void> {
  const mapped = await orm(env.DB)
    .select({ present: sql<number>`1` })
    .from(zepEpisodes)
    .where(eq(zepEpisodes.event_id, eventId))
    .get();
  if (mapped) return;

  const row = await orm(env.DB)
    .select({
      event_id: messages.event_id,
      channel_id: messages.channel_id,
      user_id: messages.user_id,
      text: messages.text,
    })
    .from(messages)
    .where(eq(messages.event_id, eventId))
    .get();
  if (!row) return; // Nothing in D1 means nothing to project.

  const policy = await getChannelPolicy(env.DB, row.channel_id);
  const graphId = graphIdFor(policy);
  if (!graphId) return;

  const { episodeUuid } = await store.addMessage(
    graphId,
    `${row.user_id ?? "unknown"}: ${row.text}`
  );
  await orm(env.DB)
    .insert(zepEpisodes)
    .values({
      episode_uuid: episodeUuid,
      event_id: eventId,
      graph_id: graphId,
      created_at: Date.now(),
    })
    .onConflictDoNothing()
    .run();
}

/* ------------------------------------------------- the agent projector -- */

export type AgentProjectionResult =
  | { outcome: "projected"; episodeUuid: string; duplicateEpisodeRisk: boolean }
  /** Another delivery owns the claim, or the row is already projected. */
  | { outcome: "noop"; reason: string }
  | { outcome: "poisoned"; reason: string };

/**
 * Deliver ONE agent episode, under the claim protocol.
 *
 * The order is the correctness argument, so it is written out:
 *
 *  1. claim the row atomically as `projecting` with a random token and a lease
 *     LONGER than the enforced Zep request timeout. A second delivery running
 *     concurrently cannot pass this and no-ops;
 *  2. if the claimed row already carries an episode uuid, a previous attempt
 *     got as far as Zep and crashed before finishing. RESUME from that uuid
 *     rather than calling `graph.add` again — this is the single biggest
 *     reduction available in the duplicate window;
 *  3. otherwise call `graph.add` once, with no transport-level retry;
 *  4. record the returned uuid, fenced to the claim token, before anything
 *     else. From this instant a crash costs nothing;
 *  5. insert `memory_episode_sources` and mark `projected` in ONE fenced D1
 *     batch, so the caller only acks after D1 has recorded the uuid.
 *
 * THE DUPLICATE WINDOW, precisely. Between the vendor call in (3) returning and
 * the fenced write in (4) committing, a crash leaves a real Zep episode that D1
 * has no record of. The lease then expires, a later claim finds no uuid, and
 * `graph.add` runs again — two physical episodes, one logical memory. The same
 * is true if this claimant's lease expires while its request hangs and the
 * abandoned call resolves after a new claimant has started. Zep offers no
 * client-supplied episode id or idempotency key to close this (verified against
 * the installed 3.27.0 types and the Zep docs MCP), so D1 is exact and Zep
 * delivery is at-least-once. This is NOT exactly-once projection.
 */
export async function projectAgentEpisode(
  db: D1Database,
  store: MemoryStore,
  outboxId: string,
  now: number = Date.now()
): Promise<AgentProjectionResult> {
  const claimed = await claimOutboxRow(db, { id: outboxId, now });
  if (claimed.outcome === "unknown_row") {
    // The row is not there yet. The RunDO alarm creates it and then sends the
    // job, but a queue can outrun a D1 read replica, and a redelivery is the
    // cheapest possible repair. Throwing asks for exactly that.
    throw new Error(`memory outbox row ${outboxId} not found`);
  }
  if (claimed.outcome === "not_claimable") {
    return {
      outcome: "noop",
      reason: "already projected or claimed by another delivery",
    };
  }

  const claim = claimed.claim;

  let episode: AgentEpisode;
  try {
    episode = parseEpisode(claim.episodeJson);
  } catch (error) {
    const reason = sterileError(
      error instanceof Error ? error.message : "episode_json did not parse"
    );
    // Content that can never be delivered. Terminal, and visible.
    await poisonOutboxRow(db, {
      id: claim.id,
      claimToken: claim.claimToken,
      error: reason,
      now,
    });
    return { outcome: "poisoned", reason };
  }

  let episodeUuid = claim.episodeUuid;
  let duplicateEpisodeRisk = false;

  if (episodeUuid === null) {
    try {
      const added = await store.addEpisode({
        graphId: claim.graphId,
        type: "json",
        // The body is what becomes semantic memory. It was bounded and redacted
        // in the generation's finalization transaction and is re-serialized
        // here from the parsed value, never concatenated with anything.
        data: JSON.stringify(episode),
        metadata: episodeMetadata(episode, claim),
        sourceDescription: episodeSourceDescription(episode),
      });
      episodeUuid = added.episodeUuid;
      // A retried claim that had to call the vendor again may have created a
      // second physical episode, because a previous attempt could have reached
      // Zep and died before recording anything. Reported, never hidden.
      duplicateEpisodeRisk = claim.attempts > 1;
      if (duplicateEpisodeRisk) {
        // EMITTED, not merely returned. The honest-limit story depends on this
        // window being observable in production, and a flag nobody logs is a
        // window nobody can measure — the docblock explaining it would be the
        // only evidence it exists. This is the line that turns "may contain a
        // physical duplicate" into something an operator can count and, if it
        // ever becomes common, act on.
        //
        // Warn rather than error: the projection SUCCEEDED. What is uncertain
        // is whether an earlier attempt also left an episode behind.
        console.warn("memory: possible duplicate Zep episode", {
          outboxId: claim.id,
          generationId: claim.generationId,
          graphId: claim.graphId,
          attempt: claim.attempts,
          episodeUuid,
        });
      }
    } catch (error) {
      const message = sterileError(
        error instanceof Error
          ? error.message
          : "the memory store rejected the episode"
      );
      await retryOutboxRow(db, {
        id: claim.id,
        claimToken: claim.claimToken,
        error: message,
        attempts: claim.attempts,
        now,
      });
      return { outcome: "noop", reason: `retry scheduled: ${message}` };
    }

    // Step 4. Everything between the line above and this one is the window.
    const recorded = await recordEpisodeUuid(db, {
      id: claim.id,
      claimToken: claim.claimToken,
      episodeUuid,
      now,
    });
    if (recorded.outcome === "stale_claim") {
      // Our lease expired and somebody else owns this row. The episode we just
      // created is the documented duplicate; corrupting the newer claimant's
      // state to record it would be strictly worse than leaving it orphaned.
      return {
        outcome: "noop",
        reason: "claim expired before the episode uuid could be recorded",
      };
    }
  }
  // The `else` is deliberately empty: a claim that already carries an episode
  // uuid is RESUMING a crashed attempt, so no vendor call happens and this
  // delivery cannot duplicate anything.

  const finished = await finishProjection(db, claim, episodeUuid, now);
  if (finished.outcome === "stale_claim") {
    return { outcome: "noop", reason: "claim expired before completion" };
  }
  return { outcome: "projected", episodeUuid, duplicateEpisodeRisk };
}

/**
 * Sources and completion, atomically and fenced.
 *
 * Every statement carries its own `WHERE EXISTS (… claim_token = ?)` guard, so
 * an expired claimant cannot insert provenance rows for the newer claimant's
 * episode even though a D1 batch has no way to abort halfway through.
 */
async function finishProjection(
  db: D1Database,
  claim: OutboxClaim,
  episodeUuid: string,
  now: number
): Promise<{ outcome: "applied" | "stale_claim" }> {
  const descriptors = parseSourceDescriptors(claim.sourceJson);
  const resolved = await resolveSources(db, descriptors, claim.runId);

  const d = orm(db);

  // The same fence as the completion below, as a subquery: a source row is
  // written only while the claim still holds. `INSERT ... SELECT ... WHERE
  // EXISTS` is what makes that one statement rather than a check and a write.
  // The column list is now rendered from the table definition instead of being
  // spelled out beside a matching row of `?`s, so a renamed column is a build
  // error rather than a positional mismatch.
  const sourceRows = resolved.map((source) =>
    d
      .insert(memoryEpisodeSources)
      .select(
        sql`select ${episodeUuid}, ${source.sourceIndex}, ${source.sourceKind}, ${source.messageEventId}, ${source.runId}, ${source.turnId}, ${source.permalink}, ${now}
             where exists (
               select 1 from ${agentMemoryOutbox}
                where ${agentMemoryOutbox.id} = ${claim.id}
                  and ${agentMemoryOutbox.claim_token} = ${claim.claimToken}
                  and ${agentMemoryOutbox.state} = 'projecting'
             )`
      )
      .onConflictDoNothing()
  );

  const completion = d
    .update(agentMemoryOutbox)
    .set({
      state: "projected",
      episode_uuid: episodeUuid,
      projected_at: now,
      claim_token: null,
      lease_expires_at: null,
      next_attempt_at: null,
      last_error: null,
      updated_at: now,
    })
    .where(
      and(
        eq(agentMemoryOutbox.id, claim.id),
        eq(agentMemoryOutbox.claim_token, claim.claimToken),
        eq(agentMemoryOutbox.state, "projecting")
      )
    )
    // `RETURNING` rather than `meta.changes`, for the same reason as
    // `decideApproval`: it is the signal that survives the batch's result
    // mapping, and for a fenced update on the primary key it is the same claim.
    .returning({ id: agentMemoryOutbox.id });

  // Sources first, completion last, and the order is load-bearing: the
  // completion flips `state` off `projecting`, which is the very predicate the
  // source inserts are fenced on. Non-empty by construction — `completion` is
  // always appended — which the tuple type cannot see for itself.
  const statements = [...sourceRows, completion] as unknown as [
    BatchItem<"sqlite">,
    ...BatchItem<"sqlite">[],
  ];
  const results = await d.batch(statements);
  const applied = results[results.length - 1] as { id: string }[];
  return applied.length > 0
    ? { outcome: "applied" }
    : { outcome: "stale_claim" };
}

/* ---------------------------------------------------- the Zep call shape -- */

function parseEpisode(json: string): AgentEpisode {
  const parsed: unknown = JSON.parse(json);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("episode_json is not an object");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.outcome !== "string" || typeof record.run_id !== "string") {
    throw new Error("episode_json is missing outcome or run_id");
  }
  return parsed as AgentEpisode;
}

/**
 * Bounded scalar tags, within Zep's verified maximum of TEN.
 *
 * Chosen for what a later search actually filters on, and deliberately opaque:
 * run and turn ids, the outcome, the shape of the work. No customer name, no
 * channel, no thread, no text (invariant 39).
 */
export function episodeMetadata(
  episode: AgentEpisode,
  claim: Pick<OutboxClaim, "generationId" | "graphId">
): EpisodeMetadata {
  return boundedMetadata({
    source: "firefighter_agent",
    outcome: episode.outcome,
    run_id: episode.run_id,
    agent_turn_id: episode.agent_turn_id,
    generation_id: claim.generationId,
    graph_id: claim.graphId,
    action_count: episode.actions.length,
  });
}

/**
 * A short human-readable label, within Zep's documented 500-character maximum.
 * It is a description of the RECORD, not a second copy of its content.
 */
export function episodeSourceDescription(episode: AgentEpisode): string {
  return boundedSourceDescription(
    `Firefighter agent turn ${episode.agent_turn_id} (${episode.outcome}) — what the agent was asked, did, and drafted.`
  );
}
