import { asc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { orm } from "../db/client";
import { messages, zepEpisodes } from "../db/tables";
import type { Env } from "../index";
import type { MemoryJob } from "../memory/consumer";
import { requireTeamMember } from "./identity";

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
  const results = await orm(db)
    .select({ event_id: messages.event_id })
    .from(messages)
    .leftJoin(zepEpisodes, eq(zepEpisodes.event_id, messages.event_id))
    .where(isNull(zepEpisodes.event_id))
    .orderBy(asc(messages.received_at))
    .limit(limit)
    .all();

  for (const row of results) {
    await queue.send({ event_id: row.event_id });
  }
  return results.length;
}

export const backfillApi = new Hono<{ Bindings: Env }>();

backfillApi.post("/backfill/memory", async (c) => {
  const member = await requireTeamMember(c);
  if (member instanceof Response) return member;
  const enqueued = await backfillMemory(c.env.DB, c.env.MEMORY_QUEUE, 200);
  return c.json({ enqueued });
});
