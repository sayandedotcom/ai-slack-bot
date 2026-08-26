/**
 * A human typing into a run that is already working.
 *
 * Three states, three different right answers, and the difference between them
 * is what this module exists for:
 *
 *  - **idle** — there is no turn to splice into, so the steer IS the wake. The
 *    submit does both.
 *  - **a turn in flight** — splice it in at the next model step, so the model
 *    sees it without the turn being torn down and restarted.
 *  - **parked on an approval** — store it and say nothing. Surfacing it now
 *    would have the model answer a new instruction while a human still has its
 *    previous reply open for decision, which is the one thing the pause exists
 *    to prevent.
 *
 * The rows here are the middle case only. Deduplication is NOT done here: the
 * SDK has no idempotency for a `@callable`, and a tab may re-send after a
 * reconnect, so the agent dedupes on `addMessages`, which is idempotent by
 * message id across the whole session tree. This table's primary key is a second
 * line of defence for the queued path, not the first.
 */

import { CapabilityError } from "../gateways/errors";

/** `Agent.sql`, exactly as the SDK declares it, so these helpers take it directly. */
export type SqlTag = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

export type SteerRow = {
  requestId: string;
  text: string;
  createdAt: number;
};

/**
 * Created on demand rather than in a migration: it belongs to the agent's own
 * SQLite, which `Agent` creates per object, and there is no schema version to
 * coordinate with.
 */
export function ensureSteerTable(sql: SqlTag): void {
  sql`
    CREATE TABLE IF NOT EXISTS pending_steers (
      request_id TEXT PRIMARY KEY,
      text       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `;
}

/**
 * Store one steer for the running turn to pick up.
 *
 * `INSERT OR IGNORE`: a re-sent request id keeps the FIRST text. Overwriting
 * would let a reconnect silently change what a human asked for.
 */
export function queueSteer(sql: SqlTag, row: SteerRow): void {
  ensureSteerTable(sql);
  sql`
    INSERT OR IGNORE INTO pending_steers (request_id, text, created_at)
    VALUES (${row.requestId}, ${row.text}, ${row.createdAt})
  `;
}

/** What is waiting, oldest first. A read: nothing is consumed. */
export function pendingSteers(sql: SqlTag): SteerRow[] {
  ensureSteerTable(sql);
  const rows = sql<{ request_id: string; text: string; created_at: number }>`
    SELECT request_id, text, created_at FROM pending_steers ORDER BY created_at ASC, request_id ASC
  `;
  return rows.map((row) => ({
    requestId: row.request_id,
    text: row.text,
    createdAt: row.created_at,
  }));
}

/**
 * Take everything waiting, once.
 *
 * Read-then-delete in one synchronous call. Durable Object storage is
 * single-threaded, so nothing can interleave between the two statements and no
 * steer can be delivered twice or dropped.
 */
export function consumeSteers(sql: SqlTag): SteerRow[] {
  const rows = pendingSteers(sql);
  if (rows.length > 0) sql`DELETE FROM pending_steers`;
  return rows;
}

/**
 * A steer's text, or a refusal.
 *
 * Whitespace is not an instruction. Refusing here rather than storing an empty
 * row means a mis-fired keystroke cannot wake a run or splice a blank message
 * into a turn.
 */
export function steerText(raw: string): string {
  const text = raw.trim();
  if (text === "") {
    throw new CapabilityError("invalid_input", "a steer needs text");
  }
  return text;
}

/**
 * How a steer reaches the model mid-turn.
 *
 * A `user` message, spliced in before the next step, and framed as what it is:
 * the human watching the run, not the customer. The model has to be able to
 * tell those apart — one is an instruction from its own operator, the other is
 * evidence about the conversation.
 */
export function steerMessageText(row: SteerRow): string {
  return [
    "The engineer watching this run just said:",
    "",
    row.text,
    "",
    "That is an instruction from your operator, not a customer message. Take it into account from here.",
  ].join("\n");
}
