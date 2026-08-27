import type { IngestOutcome } from "../ingest/rules";
import type { EventsSeenRow } from "./schema";

/**
 * Record that an envelope was seen. Returns true on first sighting, false if
 * Slack already delivered it.
 *
 * `events_seen` is both the dedupe key and the source of the "heard" counter,
 * which is why it is written for dropped events too. See spec §9.
 */
export async function recordEvent(
  db: D1Database,
  row: Pick<
    EventsSeenRow,
    "event_id" | "channel_id" | "outcome" | "received_at"
  >
): Promise<boolean> {
  const res = await db
    .prepare(
      "INSERT OR IGNORE INTO events_seen (event_id, channel_id, outcome, received_at) VALUES (?, ?, ?, ?)"
    )
    .bind(row.event_id, row.channel_id, row.outcome, row.received_at)
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
  await db
    .prepare(
      `INSERT OR IGNORE INTO messages
        (event_id, channel_id, ts, thread_ts, user_id, text, subtype, permalink, customer_slug, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      row.event_id,
      row.channel_id,
      row.ts,
      row.thread_ts,
      row.user_id,
      row.text,
      row.subtype,
      row.permalink,
      row.customer_slug,
      row.received_at
    )
    .run();
}
