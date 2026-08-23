import type { SlackMessage } from "../gateways/ports";

/**
 * Reads over the ingested message table.
 *
 * Deliberately D1 and not Slack's `conversations.history`. The assignment
 * already requires ingesting this traffic, so the system of record is right
 * here — re-reading from Slack would mean asking for another OAuth scope and
 * paying a rate limit to learn something we already stored.
 *
 * Every query is parameterized. There is no code path in this file that
 * concatenates a caller-supplied fragment into SQL, and adding one to gain
 * flexibility is how a bounded read surface becomes an arbitrary one.
 */

type MessageRow = {
  event_id: string;
  ts: string;
  user_id: string | null;
  text: string;
  permalink: string | null;
};

/**
 * Drop the raw row shape at the boundary. Callers never see D1 column names.
 *
 * `eventId` is carried through for the trusted parent's provenance record and
 * is stripped again by the Slack binding before anything reaches model-authored
 * code — see `SlackMessage`.
 */
function toMessage(row: MessageRow): SlackMessage {
  return {
    ts: row.ts,
    userId: row.user_id,
    text: row.text,
    permalink: row.permalink,
    eventId: row.event_id,
  };
}

/**
 * The root message plus its replies, oldest first.
 *
 * Slack timestamps are `<10-digit>.<6-digit>` strings of fixed width, so
 * lexicographic ordering and chronological ordering coincide. That is a
 * property of the format, not a coincidence worth relying on silently.
 */
export async function readThread(
  db: D1Database,
  channelId: string,
  threadTs: string,
  limit: number,
): Promise<SlackMessage[]> {
  const { results } = await db
    .prepare(
      `SELECT event_id, ts, user_id, text, permalink
         FROM messages
        WHERE channel_id = ? AND (ts = ? OR thread_ts = ?)
        ORDER BY ts ASC
        LIMIT ?`,
    )
    .bind(channelId, threadTs, threadTs, limit)
    .all<MessageRow>();
  return (results ?? []).map(toMessage);
}

/**
 * Escape the LIKE metacharacters so a query of `%` cannot mean "everything".
 * The backslash must go first or it would escape the escapes.
 */
function escapeLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** True when a query would match everything once metacharacters are removed. */
export function isWildcardOnly(query: string): boolean {
  return query.replace(/[%_*\s]/g, "").length === 0;
}

/**
 * Search within one customer's ingested messages.
 *
 * The customer is supplied by the trusted scope, never by the caller — that is
 * the whole isolation property. If LIKE becomes too slow at real volume, add an
 * FTS index in its own reviewed migration; do not reach for string
 * concatenation to make the query cleverer.
 */
export async function searchStoredMessages(
  db: D1Database,
  input: { customerSlug: string; query: string; limit: number },
): Promise<SlackMessage[]> {
  const { results } = await db
    .prepare(
      `SELECT event_id, ts, user_id, text, permalink
         FROM messages
        WHERE customer_slug = ? AND text LIKE ? ESCAPE '\\'
        ORDER BY ts DESC
        LIMIT ?`,
    )
    .bind(input.customerSlug, `%${escapeLike(input.query)}%`, input.limit)
    .all<MessageRow>();
  return (results ?? []).map(toMessage);
}
