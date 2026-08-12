import { getChannelPolicy } from "../db/channels";
import { agentGraphIdFor } from "../memory/graphs";
import { ensureOutboxRow } from "../memory/outbox";
import type { MemoryJob } from "../memory/consumer";
import {
  markGenerationMemoryProjected,
  readGenerationMemory,
  recordGenerationSources,
} from "../run/session";
import type { ProvenanceSink } from "../memory/episode";
import type { AgentProjectionRunner, ClaimedProjectionJob, ProjectionOutcome } from "./driver";
import { safeErrorText } from "./driver";

/**
 * The RunDO half of agent-memory projection, and the generation-local
 * provenance sink the capability layer writes through.
 *
 * The handoff has a deliberate order, because it is the only place local
 * durable state becomes someone else's problem:
 *
 *  1. the generation's finalization transaction froze the episode locally and
 *     wrote a `memory_outbox` projection job. Nothing external happened;
 *  2. this runner, on the alarm, CREATES OR REPAIRS the D1 outbox row;
 *  3. only then does it send the queue job.
 *
 * If (3) fails, the local job stays pending and the alarm retries it; if the
 * alarm never comes back, the D1 row from (2) is already visible to the
 * one-minute cron sweeper. Both halves are idempotent, so a repeat of either
 * writes nothing new.
 *
 * WHAT THIS CANNOT DO, and must not: it cannot discard, delay, or fail the
 * customer's answer. The answer was durable and broadcast before this runner
 * existed. Memory lag is an operational warning (invariant 32 applied to Zep).
 */

/** The local job's `source_id` is `memory:{runId}:{generationId}`. */
export function generationIdFromOutboxId(outboxId: string, runId: string): string | null {
  const prefix = `memory:${runId}:`;
  return outboxId.startsWith(prefix) ? outboxId.slice(prefix.length) : null;
}

export type MemoryOutboxRunnerInput = {
  storage: DurableObjectStorage;
  db: D1Database;
  queue: Queue<MemoryJob>;
  /** From the RunDO's own `run_state`. Never from a turn or a tool argument. */
  origin: "slack" | "chat";
  channelId: string | null;
  now?: () => number;
};

export function makeMemoryOutboxRunner(
  input: MemoryOutboxRunnerInput,
): AgentProjectionRunner {
  const now = input.now ?? (() => Date.now());

  return {
    async run(job: ClaimedProjectionJob): Promise<ProjectionOutcome> {
      const generationId = generationIdFromOutboxId(job.job.sourceId, job.runId);
      if (generationId === null) {
        return { outcome: "dropped", reason: "outbox job id does not belong to this run" };
      }

      const memory = readGenerationMemory(input.storage, generationId);
      if (memory === null) {
        // No frozen episode. Either the generation is gone or it settled in a
        // way that produces no memory; either way there is nothing to deliver
        // and retrying forever would keep an alarm armed on empty work.
        return { outcome: "dropped", reason: "generation has no frozen episode" };
      }

      // The graph, decided HERE from trusted host state, once, and then stored
      // on the row. Deciding it at delivery time instead would let a channel
      // reclassified after the fact move an episode that has already been
      // written under the old scope.
      let graphId: string;
      try {
        const policy =
          input.channelId === null ? null : await getChannelPolicy(input.db, input.channelId);
        graphId = agentGraphIdFor({ origin: input.origin, policy });
      } catch (error) {
        return { outcome: "retry", error: safeErrorText(error, "channel policy read failed") };
      }

      try {
        await ensureOutboxRow(input.db, {
          id: job.job.sourceId,
          runId: job.runId,
          generationId,
          graphId,
          episodeJson: memory.episodeJson,
          sourceJson: memory.sourceJson,
          now: now(),
        });
      } catch (error) {
        return { outcome: "retry", error: safeErrorText(error, "D1 outbox upsert failed") };
      }

      try {
        await input.queue.send({ kind: "agent_generation", outboxId: job.job.sourceId });
      } catch (error) {
        // The D1 row exists, so the sweeper will pick this up within a minute
        // even if this run's alarm never fires again. Retrying is still the
        // cheaper repair, so this is a retry rather than a delivered.
        return { outcome: "retry", error: safeErrorText(error, "memory queue send failed") };
      }

      markGenerationMemoryProjected(input.storage, generationId, now());
      return { outcome: "delivered" };
    },
  };
}

/* ------------------------------------------------------------ provenance -- */

/**
 * The production sink: synchronous local SQL, scoped to ONE generation.
 *
 * Synchronous and unawaited by design. Provenance is a side record of a read
 * that already happened; making the capability await a durable write would put
 * a storage round-trip in front of every recall for no correctness gain, and
 * losing a record on a crash costs a citation, never an answer.
 */
export function makeProvenanceSink(
  storage: DurableObjectStorage,
  generationId: string,
): ProvenanceSink {
  return {
    record(sources) {
      if (sources.length === 0) return;
      recordGenerationSources(storage, generationId, sources);
    },
  };
}
