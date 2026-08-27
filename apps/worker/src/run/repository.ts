import { ACTIVE_RUN_STATUSES, type RunStatus } from "./protocol";
import type { RunOrigin } from "./keys";
import type { ChannelsRow, RunsRow } from "../db/schema";

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

type RunRow = Pick<
  RunsRow,
  | "id"
  | "key"
  | "origin"
  | "channel_id"
  | "thread_ts"
  | "status"
  | "shadow"
  | "summary"
  | "created_at"
  | "updated_at"
>;

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
 *
 * ONE INSERT STATEMENT FOR THE `runs` TABLE, and this is it — the version
 * below adds a shadow ratchet to it and nothing else. This used to be a
 * verbatim copy of that block: same column list, same ten binds, same read-back
 * and throw, differing only in whether `shadow` was a literal `0` or a bind. A
 * column added to `runs` then had to be added in two places, and the day
 * somebody added it to one of them the two functions would have diverged
 * silently, because each has its own passing tests.
 *
 * The delegation is exact, not approximate. With `mustShadow: false` the bound
 * `shadow` is `0`, so the INSERT is character-for-character the statement that
 * was here; and the ratchet statement's WHERE ends in `AND ? = 1` bound to that
 * same `0`, so it matches ZERO rows on every input — a fresh insert, an
 * existing unshadowed row, and, the case that would actually be a bug, an
 * existing SHADOWED row, whose flag is left alone. Nothing here can clear a
 * shadow, which is what invariant 37 rests on. `run-repository.test.ts` proves
 * all three against real D1 rather than by reading the SQL.
 */
export async function createOrGetRun(
  db: D1Database,
  descriptor: RunDescriptor,
  now = Date.now()
): Promise<RunRecord> {
  return createOrGetRunUnderPolicy(db, descriptor, { mustShadow: false }, now);
}

/**
 * Create-or-find this thread's unique run under the CURRENT channel policy, and
 * ratchet its shadow flag before anything schedules work on it.
 *
 * THE RATCHET IS ONE-WAY, AND THAT IS THE WHOLE POINT.
 *
 * `shadow = 1` is set whenever the channel is not currently a known `live`
 * channel — observe, internal, or absent from the table altogether. It is never
 * cleared. There is deliberately NO code path anywhere in this Worker that
 * turns a shadow run back into an acting one: not this function, not queue
 * redelivery, not owned-thread continuation, not a steer, not an alarm. Adding
 * one would be an authority change, and it belongs in a reviewed promotion
 * operation with its own state, not in the path a redelivered Slack event takes
 * at 3am.
 *
 * That asymmetry is what makes invariant 37 hold under redelivery. A run
 * created while its channel was `live` and unshadowed keeps acting, correctly;
 * a run whose channel has since been downgraded to `observe` is shadowed on the
 * very next message and stays shadowed, even though it was created unshadowed
 * and even though its D1 row still says the run is active. A live channel's run
 * never needs the flag cleared, because it was never set.
 *
 * BOTH STATEMENTS RUN IN ONE `db.batch()`, which D1 executes as a single
 * implicit transaction. Split into two awaited calls, the window between them
 * is a window in which a concurrent reader — the write guard, which re-reads
 * `runs.shadow` immediately before every external write — can see the row
 * created and the ratchet not yet applied, which is precisely the moment an
 * observing run posts to a customer.
 *
 * `mustShadow` is computed by the CALLER from `canPost(policy)` so this stays a
 * D1 module with no policy semantics of its own; see `coordinator.ts`, which
 * resolves the policy immediately before calling. The other caller is
 * `createOrGetRun` above, which passes `mustShadow: false` — the policy-free
 * create is this create with the ratchet bound off, not a second copy of it.
 */
export async function createOrGetRunUnderPolicy(
  db: D1Database,
  descriptor: RunDescriptor,
  options: { mustShadow: boolean },
  now = Date.now()
): Promise<RunRecord> {
  const shadow = options.mustShadow ? 1 : 0;
  await db.batch([
    // Created `idle`, for every origin. A row existing is not the agent working:
    // `live` now means a generation is scheduled, and that transition is made by
    // the input transaction inside the RunDO, then projected here. Phase 08's
    // `live` default is repaired by migration 0006.
    db
      .prepare(
        `INSERT OR IGNORE INTO runs
           (id, "key", origin, channel_id, thread_ts, status, shadow, summary, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'idle', ?, NULL, ?, ?)`
      )
      .bind(
        crypto.randomUUID(),
        descriptor.key,
        descriptor.origin,
        descriptor.channelId,
        descriptor.threadTs,
        shadow,
        now,
        now
      ),
    // `AND shadow = 0` rather than an unconditional SET, so the common case
    // writes no row at all — and so the statement can only ever move the flag
    // in the safe direction, whatever it is handed. There is no companion
    // statement that sets it to 0; see the note above.
    db
      .prepare(
        `UPDATE runs SET shadow = 1 WHERE "key" = ? AND shadow = 0 AND ? = 1`
      )
      .bind(descriptor.key, shadow),
  ]);

  const run = await getRunByKey(db, descriptor.key);
  if (!run)
    throw new Error(`run vanished immediately after insert: ${descriptor.key}`);
  return run;
}

export async function getRunById(
  db: D1Database,
  id: string
): Promise<RunRecord | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM runs WHERE id = ?`)
    .bind(id)
    .first<RunRow>();
  return row ? toRecord(row) : null;
}

export async function getRunByKey(
  db: D1Database,
  key: string
): Promise<RunRecord | null> {
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
  threadTs: string
): Promise<RunRecord | null> {
  const placeholders = ACTIVE_RUN_STATUSES.map(() => "?").join(", ");
  const row = await db
    .prepare(
      `SELECT ${COLUMNS} FROM runs
       WHERE origin = 'slack' AND channel_id = ? AND thread_ts = ?
         AND status IN (${placeholders})
       LIMIT 1`
    )
    .bind(channelId, threadTs, ...ACTIVE_RUN_STATUSES)
    .first<RunRow>();
  return row ? toRecord(row) : null;
}

export async function listRuns(
  db: D1Database,
  options: { status?: RunStatus; limit?: number }
): Promise<RunListItem[]> {
  const limit = Math.min(
    Math.max(1, Math.floor(options.limit ?? RUN_LIST_DEFAULT_LIMIT)),
    RUN_LIST_MAX_LIMIT
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
       LIMIT ?`
    )
    .bind(...bindings)
    .all<
      Pick<
        RunsRow,
        | "id"
        | "origin"
        | "status"
        | "shadow"
        | "summary"
        | "channel_id"
        | "created_at"
        | "updated_at"
      > & {
        // Widened at the call site, not in the schema: this is a LEFT JOIN, so
        // both columns come back NULL for a run whose channel is absent from
        // `channels` — even though `channels.name` is NOT NULL in the DDL.
        channel_name: ChannelsRow["name"] | null;
        customer_slug: ChannelsRow["customer_slug"];
      }
    >();

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
 * What one run has spent, per model, straight out of D1.
 *
 * Served from `agent_model_calls` and NOTHING ELSE. The dashboard's cost view
 * must not wake a Durable Object — the local `model_step_usage` table is the
 * system of record, but reading it costs a wake per run, and a list of fifty
 * runs would cost fifty. That is the same rule `GET /api/runs` already follows.
 *
 * The consequence is honest and worth naming: a step billed seconds ago whose
 * projection has not landed yet is not in this total. It is a projection, it
 * lags, and it never over-reports.
 *
 * `costNanoUsd` stays an INTEGER all the way to the route, which formats it as
 * a decimal string (invariant 29). Nothing in this file produces a float.
 */
export type RunUsageAggregate = {
  model: string;
  calls: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costNanoUsd: number;
};

export async function readRunUsage(
  db: D1Database,
  runId: string
): Promise<RunUsageAggregate[]> {
  const { results } = await db
    .prepare(
      `SELECT model,
              COUNT(*)                       AS calls,
              COALESCE(SUM(input_tokens), 0)       AS input_tokens,
              COALESCE(SUM(cache_read_tokens), 0)  AS cache_read_tokens,
              COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
              COALESCE(SUM(output_tokens), 0)      AS output_tokens,
              COALESCE(SUM(cost_nano_usd), 0)      AS cost_nano_usd
         FROM agent_model_calls
        WHERE run_id = ?
        GROUP BY model
        ORDER BY model ASC`
    )
    .bind(runId)
    .all<{
      model: string;
      calls: number;
      input_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      output_tokens: number;
      cost_nano_usd: number;
    }>();

  return (results ?? []).map((row) => ({
    model: row.model,
    calls: row.calls,
    inputTokens: row.input_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    outputTokens: row.output_tokens,
    costNanoUsd: row.cost_nano_usd,
  }));
}

/**
 * Apply one bundled run-index revision, conditionally.
 *
 * This is the only writer on the RunDO event path, and it is monotonic by
 * construction: `projection_seq < ?` means an older revision whose async write
 * returned late matches zero rows and changes nothing. Two updates in the same
 * millisecond are ordered too, because the comparison is on the revision, not
 * on a timestamp that can tie.
 *
 * Status, summary and recency travel together on purpose. Projecting them
 * through separate statements is what let Phase 08's list show a fresh status
 * beside a stale summary — or, for a summary, nothing at all.
 *
 * `updated_at` still uses MAX() so a replayed older revision cannot make a
 * live run look stale and sink down the dashboard list. A missing row is not an
 * error: the RunDO owns the session, and its mutation must not fail because the
 * index lagged.
 */
export async function projectRunIndex(
  db: D1Database,
  id: string,
  revision: number,
  snapshot: { status: RunStatus; summary: string | null; updatedAt: number }
): Promise<{ applied: boolean }> {
  const result = await db
    .prepare(
      `UPDATE runs SET
         status = ?, summary = ?, updated_at = MAX(updated_at, ?), projection_seq = ?
       WHERE id = ? AND projection_seq < ?`
    )
    .bind(
      snapshot.status,
      snapshot.summary,
      snapshot.updatedAt,
      revision,
      id,
      revision
    )
    .run();
  return { applied: (result.meta.changes ?? 0) > 0 };
}

/**
 * Bump recency after a committed session event. Never moves backwards.
 *
 * Kept as a repository primitive, but NO LONGER on the RunDO's event path: that
 * path projects a bundled revision through `projectRunIndex` instead, so a
 * summary reaches D1 at all and two async writes cannot land out of order.
 */
export async function touchRun(
  db: D1Database,
  id: string,
  at: number
): Promise<void> {
  await db
    .prepare("UPDATE runs SET updated_at = ? WHERE id = ? AND updated_at < ?")
    .bind(at, id, at)
    .run();
}

export async function setRunStatus(
  db: D1Database,
  id: string,
  status: RunStatus,
  at = Date.now()
): Promise<void> {
  await db
    .prepare(
      "UPDATE runs SET status = ?, updated_at = MAX(updated_at, ?) WHERE id = ?"
    )
    .bind(status, at, id)
    .run();
}

/**
 * Move a run's status only if it is still in the state the caller validated
 * against.
 *
 * The twin of `setRunStatus`, and the one the agent's projection uses. The
 * unconditional version cannot be safe on that path: two projections racing
 * would both read `live`, both find their own transition legal, and the loser
 * would overwrite the winner — writing a change that was legal only against a
 * row that no longer exists. Comparing on `status` makes the loser a no-op,
 * which `projectStatus` reports rather than swallowing.
 */
export async function casRunStatus(
  db: D1Database,
  id: string,
  from: RunStatus,
  to: RunStatus,
  at = Date.now()
): Promise<{ applied: boolean }> {
  const result = await db
    .prepare(
      "UPDATE runs SET status = ?, updated_at = MAX(updated_at, ?) WHERE id = ? AND status = ?"
    )
    .bind(to, at, id, from)
    .run();
  return { applied: (result.meta.changes ?? 0) > 0 };
}

export async function setRunSummary(
  db: D1Database,
  id: string,
  summary: string
): Promise<void> {
  await db
    .prepare("UPDATE runs SET summary = ? WHERE id = ?")
    .bind(summary, id)
    .run();
}
