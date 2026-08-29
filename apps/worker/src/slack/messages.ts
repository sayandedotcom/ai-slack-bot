import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import { orm } from "../db/client";
import type { MessagesRow } from "../db/schema";
import { messages } from "../db/tables";
import type { SlackMessage } from "../gateways/ports";

/** Exactly the columns `MessageRow` names — never the whole row. */
const MESSAGE_COLUMNS = {
  event_id: messages.event_id,
  ts: messages.ts,
  user_id: messages.user_id,
  text: messages.text,
  permalink: messages.permalink,
} as const;

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

type MessageRow = Pick<
  MessagesRow,
  "event_id" | "ts" | "user_id" | "text" | "permalink"
>;

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
  limit: number
): Promise<SlackMessage[]> {
  const results = await orm(db)
    .select(MESSAGE_COLUMNS)
    .from(messages)
    .where(
      and(
        eq(messages.channel_id, channelId),
        or(eq(messages.ts, threadTs), eq(messages.thread_ts, threadTs))
      )
    )
    .orderBy(asc(messages.ts))
    .limit(limit)
    .all();
  return results.map(toMessage);
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
  input: { customerSlug: string; query: string; limit: number }
): Promise<SlackMessage[]> {
  const results = await orm(db)
    .select(MESSAGE_COLUMNS)
    .from(messages)
    .where(
      and(
        eq(messages.customer_slug, input.customerSlug),
        // Explicit `ESCAPE`, as everywhere else in this repo: SQLite has no
        // default escape character and `like()` cannot render the clause.
        sql`${messages.text} like ${`%${escapeLike(input.query)}%`} escape '\\'`
      )
    )
    .orderBy(desc(messages.ts))
    .limit(input.limit)
    .all();
  return results.map(toMessage);
}
