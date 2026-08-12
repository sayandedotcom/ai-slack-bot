import type { Env } from "../index";
import { listDueOutboxRows } from "./outbox";

/**
 * The one-minute recovery sweep for agent-memory projection.
 *
 * WHY IT EXISTS. Every other path to Zep depends on something that can be lost:
 * a RunDO alarm that never fires again because the object was evicted mid-crash,
 * or a queue message that has exhausted its retries and gone to the DLQ. The D1
 * outbox row survives both. This handler is what turns that row back into work,
 * and it explicitly owns DLQ and exhausted-retry recovery after the local
 * handoff — which is why `retryOutboxRow` never marks a row terminally failed
 * for running out of attempts.
 *
 * WHAT IT MUST NOT DO. It cannot touch a customer-facing answer, and there is
 * no code path here that could: the answer was durable and broadcast before the
 * outbox row existed. A permanently stuck row is an operational warning about
 * memory lag, never a reason to discard or delay what the customer sees.
 *
 * BOUNDED, because this runs every minute forever against a table that grows
 * with every generation. One page, oldest first. If the backlog is larger than
 * a page, the next minute takes the next page — a sweep that tried to drain
 * everything would take longer than its own interval and overlap itself.
 */
export const SWEEP_PAGE_SIZE = 50;

export type SweepResult = {
  due: number;
  enqueued: number;
  failed: number;
};

export async function sweepMemoryOutbox(
  env: Env,
  now: number = Date.now(),
  limit: number = SWEEP_PAGE_SIZE,
): Promise<SweepResult> {
  const due = await listDueOutboxRows(env.DB, { now, limit });
  let enqueued = 0;
  let failed = 0;

  for (const row of due) {
    try {
      // Re-enqueue only. The sweeper deliberately does NOT claim the row or
      // call Zep itself: the consumer already owns the claim protocol, and a
      // second implementation of it is a second thing that can be wrong. It
      // also means a row whose lease is still live is simply re-delivered and
      // no-ops on the claim, which is the cheapest possible outcome.
      await env.MEMORY_QUEUE.send({ kind: "agent_generation", outboxId: row.id });
      enqueued += 1;
    } catch {
      // One unsendable row must not abandon the rest of the page. The row stays
      // due and the next sweep tries it again.
      failed += 1;
    }
  }

  if (failed > 0 || due.length >= limit) {
    // Operational visibility, deliberately at warn: a persistent backlog means
    // memory is lagging behind reality, which someone should know about before
    // an answer is built on a stale graph.
    console.warn("memory sweep", { due: due.length, enqueued, failed, limit });
  }

  return { due: due.length, enqueued, failed };
}
