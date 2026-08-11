import { ACTIVE_RUN_STATUSES, type RunStatus } from "./protocol";
import type { RunOrigin } from "./keys";

/**
 * D1-only operations on the run index. Nothing here touches the RUNS namespace:
 * `GET /api/runs` must be able to render the dashboard without waking a single
 * Durable Object.
 *
 * `"key"` is quoted in every statement. It is the spec's column name and an
 * unquoted keyword-shaped identifier is an avoidable portability trap.
 */

export type RunRecord = {
  id: string;
  key: string;
  origin: RunOrigin;
  channelId: string | null;
  threadTs: string | null;
  status: RunStatus;
  shadow: boolean;
  summary: string | null;
  createdAt: number;
  updatedAt: number;
};

/** The public list shape. Note the absence of `key` — see invariant 10. */
export type RunListItem = {
  id: string;
  origin: RunOrigin;
  status: RunStatus;
  shadow: boolean;
  summary: string | null;
  channelId: string | null;
  channelName: string | null;
  customerSlug: string | null;
  createdAt: number;
  updatedAt: number;
};

export type RunDescriptor = {
  key: string;
  origin: RunOrigin;
  channelId: string | null;
  threadTs: string | null;
};

export const RUN_LIST_DEFAULT_LIMIT = 50;
export const RUN_LIST_MAX_LIMIT = 200;

type RunRow = {
  id: string;
  key: string;
  origin: RunOrigin;
  channel_id: string | null;
  thread_ts: string | null;
  status: RunStatus;
  shadow: number;
  summary: string | null;
  created_at: number;
  updated_at: number;
};

const COLUMNS = `id, "key", origin, channel_id, thread_ts, status, shadow, summary, created_at, updated_at`;

function toRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    key: row.key,
    origin: row.origin,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    status: row.status,
    shadow: row.shadow === 1,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Idempotent on the origin key. `INSERT OR IGNORE` then SELECT: on a concurrent
 * create the losing insert is a no-op and both callers read back the same
 * canonical row. Returning the candidate uuid from a losing insert would hand
 * one caller an id that names nothing.
 */
export async function createOrGetRun(
  db: D1Database,
  descriptor: RunDescriptor,
  now = Date.now(),
): Promise<RunRecord> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO runs
         (id, "key", origin, channel_id, thread_ts, status, shadow, summary, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'live', 0, NULL, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      descriptor.key,
      descriptor.origin,
      descriptor.channelId,
      descriptor.threadTs,
      now,
      now,
    )
    .run();

  const run = await getRunByKey(db, descriptor.key);
  if (!run) throw new Error(`run vanished immediately after insert: ${descriptor.key}`);
  return run;
}

export async function getRunById(db: D1Database, id: string): Promise<RunRecord | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM runs WHERE id = ?`)
    .bind(id)
    .first<RunRow>();
  return row ? toRecord(row) : null;
}

export async function getRunByKey(db: D1Database, key: string): Promise<RunRecord | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM runs WHERE "key" = ?`)
    .bind(key)
    .first<RunRow>();
  return row ? toRecord(row) : null;
}

/**
 * Does a run still own this Slack thread? Only active statuses count: a `done`
 * or `failed` run releases the thread back to triage, which may then reopen the
 * same run through its key and keep the history continuous.
 */
export async function findOwnedSlackRun(
  db: D1Database,
  channelId: string,
  threadTs: string,
): Promise<RunRecord | null> {
  const placeholders = ACTIVE_RUN_STATUSES.map(() => "?").join(", ");
  const row = await db
    .prepare(
      `SELECT ${COLUMNS} FROM runs
       WHERE origin = 'slack' AND channel_id = ? AND thread_ts = ?
         AND status IN (${placeholders})
       LIMIT 1`,
    )
    .bind(channelId, threadTs, ...ACTIVE_RUN_STATUSES)
    .first<RunRow>();
  return row ? toRecord(row) : null;
}

export async function listRuns(
  db: D1Database,
  options: { status?: RunStatus; limit?: number },
): Promise<RunListItem[]> {
  const limit = Math.min(
    Math.max(1, Math.floor(options.limit ?? RUN_LIST_DEFAULT_LIMIT)),
    RUN_LIST_MAX_LIMIT,
  );

  const where = options.status ? "WHERE r.status = ?" : "";
  const bindings = options.status ? [options.status, limit] : [limit];

  const { results } = await db
    .prepare(
      `SELECT r.id, r.origin, r.status, r.shadow, r.summary, r.channel_id,
              c.name AS channel_name, c.customer_slug, r.created_at, r.updated_at
       FROM runs r
       LEFT JOIN channels c ON c.channel_id = r.channel_id
       ${where}
       ORDER BY r.updated_at DESC
       LIMIT ?`,
    )
    .bind(...bindings)
    .all<{
      id: string;
      origin: RunOrigin;
      status: RunStatus;
      shadow: number;
      summary: string | null;
      channel_id: string | null;
      channel_name: string | null;
      customer_slug: string | null;
      created_at: number;
      updated_at: number;
    }>();

  return (results ?? []).map((row) => ({
    id: row.id,
    origin: row.origin,
    status: row.status,
    shadow: row.shadow === 1,
    summary: row.summary,
    channelId: row.channel_id,
    channelName: row.channel_name,
    customerSlug: row.customer_slug,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/**
 * Bump recency after a committed session event. Never moves backwards: a queue
 * retry replaying an older event must not make a live run look stale and sink
 * down the dashboard list. A missing row is not an error — the RunDO owns the
 * session, and its mutation must not fail because the index lagged.
 */
export async function touchRun(db: D1Database, id: string, at: number): Promise<void> {
  await db
    .prepare("UPDATE runs SET updated_at = ? WHERE id = ? AND updated_at < ?")
    .bind(at, id, at)
    .run();
}

export async function setRunStatus(
  db: D1Database,
  id: string,
  status: RunStatus,
  at = Date.now(),
): Promise<void> {
  await db
    .prepare("UPDATE runs SET status = ?, updated_at = MAX(updated_at, ?) WHERE id = ?")
    .bind(status, at, id)
    .run();
}

export async function setRunSummary(db: D1Database, id: string, summary: string): Promise<void> {
  await db.prepare("UPDATE runs SET summary = ? WHERE id = ?").bind(summary, id).run();
}
