import type { IngestOutcome } from "../ingest/rules";
import { orm } from "./client";
import type { EventsSeenRow } from "./schema";
import { eventsSeen, messages } from "./tables";

/**
 * Record that an envelope was seen. Returns true on first sighting, false if
 * Slack already delivered it.
 *
 * `events_seen` is both the dedupe key and the source of the "heard" counter,
 * which is why it is written for dropped events too. See spec §9.
 *
 * `onConflictDoNothing()` renders `ON CONFLICT DO NOTHING`, where this used to
 * say `INSERT OR IGNORE`. Those are not the same statement: `OR IGNORE`
 * swallows every constraint violation, this one swallows only a uniqueness
 * conflict. The dedupe intent is the primary key, so the behaviour that matters
 * is unchanged — and a NOT NULL or CHECK violation now raises instead of
 * vanishing, which is what anyone reading this line already assumed it did.
 */
export async function recordEvent(
  db: D1Database,
  row: Pick<
    EventsSeenRow,
    "event_id" | "channel_id" | "outcome" | "received_at"
  >
): Promise<boolean> {
  const res = await orm(db)
    .insert(eventsSeen)
    .values({
      event_id: row.event_id,
      channel_id: row.channel_id,
      outcome: row.outcome as IngestOutcome,
      received_at: row.received_at,
    })
    .onConflictDoNothing()
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function insertMessage(
  db: D1Database,
  row: {
    event_id: string;
    channel_id: string;
    ts: string;
    thread_ts: string | null;
    user_id: string | null;
    text: string;
    subtype: string | null;
    permalink: string | null;
    customer_slug: string | null;
    received_at: number;
  }
): Promise<void> {
  await orm(db).insert(messages).values(row).onConflictDoNothing().run();
}
