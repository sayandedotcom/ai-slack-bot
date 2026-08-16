/**
 * Steering: text a human types at a run that is already mid-turn.
 *
 * A queue plus a per-step splice rather than a plain `addMessages`, because
 * `messageConcurrency` governs only overlapping user SUBMITS — it does not
 * inject into a turn that is already running (verified fact 13, spec decision
 * D9). Invariants 12-13: steers splice in insertion order and drain exactly
 * once, so a steer is never shown to the model twice and never lost.
 *
 * The queue lives in the agent's own SQLite rather than in a field, because
 * the whole point of a steer is that it survives the gap between "a human
 * typed it" and "the next model step ran" — a gap that spans hibernation and
 * eviction.
 */

import type { ModelMessage } from "ai";
import type { RunAgent } from "./agent";

/** One queued steer. `id` is the ordering authority; `created_at` is evidence. */
type SteerRow = { id: number; text: string };

/**
 * Create the pending-steer table if it is not there yet.
 *
 * Called from `RunAgent.onStart`, so it runs on every wake and must be
 * idempotent (`CREATE TABLE IF NOT EXISTS`).
 *
 * `id INTEGER PRIMARY KEY AUTOINCREMENT` is load-bearing twice over. It is the
 * insertion order the splice replays (invariant 12 — sequence, never a
 * timestamp: two steers typed inside the same millisecond, or typed either
 * side of a clock correction, still replay in the order the human sent them).
 * And `AUTOINCREMENT` never reuses a rowid, which is what lets the drain
 * delete by an id BOUND rather than by an id list.
 */
export function ensureSteerSchema(agent: RunAgent): void {
  agent.sql`
    CREATE TABLE IF NOT EXISTS pending_steers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `;
}

/**
 * Enqueue one steer. Returns the queue depth AFTER the insert, so a caller can
 * tell a first steer from a fourth without a second round trip.
 *
 * The schema is ensured here as well as in `onStart` because this is the write
 * path: a steer that arrives before the agent's start hook has run must be
 * stored, not dropped with a "no such table". `CREATE TABLE IF NOT EXISTS`
 * against an existing table is a no-op, so the cost is one parse.
 *
 * `created_at` is recorded for the audit trail only. Nothing reads it to
 * decide order.
 */
export async function queueSteer(agent: RunAgent, text: string): Promise<{ queued: number }> {
  ensureSteerSchema(agent);
  agent.sql`INSERT INTO pending_steers (text, created_at) VALUES (${text}, ${Date.now()})`;
  const [counted] = agent.sql<{ queued: number }>`SELECT COUNT(*) AS queued FROM pending_steers`;
  return { queued: Number(counted?.queued ?? 0) };
}

/**
 * Splice every queued steer into this step's messages and mark them drained.
 *
 * Exactly once, and the mechanism is the ABSENCE of an `await` rather than a
 * lock. Everything between the SELECT and the DELETE is synchronous SQLite
 * against this object's own storage, and a Durable Object runs one JavaScript
 * turn at a time — so a second `drainSteers` racing this one cannot observe
 * the rows this one is about to delete. It either runs entirely before (and
 * this call sees nothing) or entirely after (and it sees nothing).
 *
 * The DELETE is bounded by the HIGHEST id read, not by an id list and not
 * unqualified. `AUTOINCREMENT` never reuses an id, so `id <= highest` is
 * exactly the set just read: a steer queued after this drain began is
 * guaranteed a larger id and survives for the next step. A bare
 * `DELETE FROM pending_steers` would silently eat it.
 *
 * The honest limit: this is exactly-once against a concurrent drain, and
 * at-least-once against a crash. Both statements land in the same storage
 * write transaction, so a failure that loses the DELETE loses the whole call —
 * the steer is simply offered to the next step again. Repeated into the prompt
 * is a wasted repetition; dropped is a correction the customer believes the
 * agent received. Invariant 13 picks the first.
 */
export async function drainSteers(
  agent: RunAgent,
  messages: ModelMessage[],
): Promise<ModelMessage[]> {
  const pending = agent.sql<SteerRow>`
    SELECT id, text FROM pending_steers ORDER BY id ASC
  `;
  if (pending.length === 0) return messages;

  const highest = pending[pending.length - 1]!.id;
  agent.sql`DELETE FROM pending_steers WHERE id <= ${highest}`;

  // Appended AFTER the transcript, as `user` turns: a steer is a human
  // instruction, and the last thing the model reads before it plans the step.
  return [
    ...messages,
    ...pending.map((row): ModelMessage => ({ role: "user", content: row.text })),
  ];
}
