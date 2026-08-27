import { Hono } from "hono";
import type { MessagesRow } from "../db/schema";
import type { Env } from "../index";
import type { MemoryJob } from "../memory/consumer";

/**
 * Re-enqueues messages that predate the memory layer (or fell into the DLQ)
 * through the exact same consumer path — no second projection code path to
 * drift. Idempotent: the consumer skips already-mapped events anyway.
 */
export async function backfillMemory(
  db: D1Database,
  queue: Queue<MemoryJob>,
  limit: number
): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT m.event_id FROM messages m
       LEFT JOIN zep_episodes z ON z.event_id = m.event_id
       WHERE z.event_id IS NULL
       ORDER BY m.received_at ASC LIMIT ?`
    )
    .bind(limit)
    .all<Pick<MessagesRow, "event_id">>();

  for (const row of results) {
    await queue.send({ event_id: row.event_id });
  }
  return results.length;
}

export const backfillApi = new Hono<{ Bindings: Env }>();

backfillApi.post("/backfill/memory", async (c) => {
  const enqueued = await backfillMemory(c.env.DB, c.env.MEMORY_QUEUE, 200);
  return c.json({ enqueued });
});
