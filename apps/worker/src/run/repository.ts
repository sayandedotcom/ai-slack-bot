import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { orm } from "../db/client";
import type { ChannelsRow, RunsRow } from "../db/schema";
import {
  agentModelCalls,
  approvals,
  channels,
  runs as runsTable,
} from "../db/tables";
import type { RunOrigin } from "./keys";
import { decimalNanoUsd } from "./money";
import { ACTIVE_RUN_STATUSES, type RunStatus } from "./protocol";

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
  /** Decimal USD from the model-call ledger (invariant 29). "0.000000000" for a run that has not billed. */
  costUsd: string;
  /** Distinct `agent_turn_id`s billed — how many times the model was woken on this run. */
  turns: number;
  /** The one pending approval (idx_approvals_one_open), or null. */
  openApprovalId: string | null;
};

export type RunListFilters = {
  status?: RunStatus;
  origin?: RunOrigin;
  channelId?: string;
  shadow?: boolean;
  /** Case-insensitive substring over summary and channel name; prefix over id. */
  q?: string;
  cursor?: string;
  limit?: number;
};

export type RunListPage = { runs: RunListItem[]; nextCursor: string | null };

/** `${updatedAt}_${id}`: ids are uuids, which never contain `_`. Opaque to the client. */
export function encodeRunCursor(item: {
  updatedAt: number;
  id: string;
}): string {
  return `${item.updatedAt}_${item.id}`;
}

export function decodeRunCursor(
  raw: string
): { updatedAt: number; id: string } | null {
  const at = raw.indexOf("_");
  if (at <= 0 || at === raw.length - 1) return null;
  const updatedAt = Number(raw.slice(0, at));
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) return null;
  return { updatedAt, id: raw.slice(at + 1) };
}

/** LIKE treats `%` and `_` as wildcards; a search for "50%_off" must not become "match anything". */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

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

/**
 * Exactly the columns `RunRow` names, so a projection stays a stated claim
 * rather than `SELECT *`. `projection_seq` is deliberately absent: it is the
 * concurrency token for `projectRunIndex` and nothing outside this file reads
 * it.
 */
const RUN_COLUMNS = {
  id: runsTable.id,
  key: runsTable.key,
  origin: runsTable.origin,
  channel_id: runsTable.channel_id,
  thread_ts: runsTable.thread_ts,
  status: runsTable.status,
  shadow: runsTable.shadow,
  summary: runsTable.summary,
  created_at: runsTable.created_at,
  updated_at: runsTable.updated_at,
} as const;

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
  const d = orm(db);
  // `db.batch` on the Drizzle handle is D1's own `batch()` underneath — the
  // driver calls `client.batch(...)` with the built statements — so this is
  // still ONE implicit transaction, which is the whole reason the two
  // statements are together.
  await d.batch([
    // Created `idle`, for every origin. A row existing is not the agent working:
    // `live` now means a generation is scheduled, and that transition is made by
    // the input transaction inside the RunDO, then projected here. Phase 08's
    // `live` default is repaired by migration 0006.
    d
      .insert(runsTable)
      .values({
        id: crypto.randomUUID(),
        key: descriptor.key,
        origin: descriptor.origin,
        channel_id: descriptor.channelId,
        thread_ts: descriptor.threadTs,
        status: "idle",
        shadow,
        summary: null,
        created_at: now,
        updated_at: now,
      })
      .onConflictDoNothing(),
    // `AND shadow = 0` rather than an unconditional SET, so the common case
    // writes no row at all — and so the statement can only ever move the flag
    // in the safe direction, whatever it is handed. There is no companion
    // statement that sets it to 0; see the note above.
    //
    // `AND ? = 1` survives the move verbatim as a bound fragment. It is what
    // makes `mustShadow: false` match zero rows on every input rather than
    // needing a second statement or a branch in TypeScript — including, and
    // this is the case that would be a bug, against an already-shadowed row.
    d
      .update(runsTable)
      .set({ shadow: 1 })
      .where(
        and(
          eq(runsTable.key, descriptor.key),
          eq(runsTable.shadow, 0),
          sql`${shadow} = 1`
        )
      ),
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
  const row = await orm(db)
    .select(RUN_COLUMNS)
    .from(runsTable)
    .where(eq(runsTable.id, id))
    .get();
  return row ? toRecord(row) : null;
}

export async function getRunByKey(
  db: D1Database,
  key: string
): Promise<RunRecord | null> {
  const row = await orm(db)
    .select(RUN_COLUMNS)
    .from(runsTable)
    .where(eq(runsTable.key, key))
    .get();
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
  const row = await orm(db)
    .select(RUN_COLUMNS)
    .from(runsTable)
    .where(
      and(
        eq(runsTable.origin, "slack"),
        eq(runsTable.channel_id, channelId),
        eq(runsTable.thread_ts, threadTs),
        inArray(runsTable.status, ACTIVE_RUN_STATUSES)
      )
    )
    .limit(1)
    .get();
  return row ? toRecord(row) : null;
}

export async function listRuns(
  db: D1Database,
  filters: RunListFilters
): Promise<RunListPage> {
  const limit = Math.min(
    Math.max(1, Math.floor(filters.limit ?? RUN_LIST_DEFAULT_LIMIT)),
    RUN_LIST_MAX_LIMIT
  );

  const d = orm(db);
  const where: SQL[] = [];

  if (filters.status) where.push(eq(runsTable.status, filters.status));
  if (filters.origin) where.push(eq(runsTable.origin, filters.origin));
  if (filters.channelId)
    where.push(eq(runsTable.channel_id, filters.channelId));
  if (filters.shadow !== undefined)
    where.push(eq(runsTable.shadow, filters.shadow ? 1 : 0));
  if (filters.q) {
    const like = `%${escapeLike(filters.q)}%`;
    const prefix = `${escapeLike(filters.q)}%`;
    // Substring over summary and channel name, PREFIX over id, and each one
    // keeps its explicit `ESCAPE` — SQLite has no default escape character, and
    // `like()` cannot render the clause, so these stay bound `sql` fragments.
    const q = or(
      sql`${runsTable.summary} like ${like} escape '\\'`,
      sql`${channels.name} like ${like} escape '\\'`,
      sql`${runsTable.id} like ${prefix} escape '\\'`
    );
    if (q) where.push(q);
  }
  if (filters.cursor) {
    const cursor = decodeRunCursor(filters.cursor);
    if (cursor) {
      const page = or(
        lt(runsTable.updated_at, cursor.updatedAt),
        and(
          eq(runsTable.updated_at, cursor.updatedAt),
          lt(runsTable.id, cursor.id)
        )
      );
      if (page) where.push(page);
    }
  }

  // The per-run spend rollup, joined rather than correlated so one pass over
  // `agent_model_calls` serves the whole page.
  const usage = d
    .select({
      run_id: agentModelCalls.run_id,
      cost_nano_usd: sql<number>`sum(${agentModelCalls.cost_nano_usd})`.as(
        "cost_nano_usd"
      ),
      turns: sql<number>`count(distinct ${agentModelCalls.agent_turn_id})`.as(
        "turns"
      ),
    })
    .from(agentModelCalls)
    .groupBy(agentModelCalls.run_id)
    .as("u");

  const rows = await d
    .select({
      id: runsTable.id,
      origin: runsTable.origin,
      status: runsTable.status,
      shadow: runsTable.shadow,
      summary: runsTable.summary,
      channel_id: runsTable.channel_id,
      // Widened here, not in the schema: this is a LEFT JOIN, so both columns
      // come back NULL for a run whose channel is absent from `channels` —
      // even though `channels.name` is NOT NULL in the DDL. Drizzle infers
      // that widening for a left-joined TABLE automatically, but these are
      // aliased projections, so the claim is stated.
      channel_name: sql<ChannelsRow["name"] | null>`${channels.name}`,
      customer_slug: sql<
        ChannelsRow["customer_slug"]
      >`${channels.customer_slug}`,
      created_at: runsTable.created_at,
      updated_at: runsTable.updated_at,
      cost_nano_usd: sql<number>`coalesce(${usage.cost_nano_usd}, 0)`,
      turns: sql<number>`coalesce(${usage.turns}, 0)`,
      open_approval_id: sql<string | null>`${approvals.id}`,
    })
    .from(runsTable)
    .leftJoin(channels, eq(channels.channel_id, runsTable.channel_id))
    .leftJoin(usage, eq(usage.run_id, runsTable.id))
    .leftJoin(
      approvals,
      and(eq(approvals.run_id, runsTable.id), eq(approvals.decision, "pending"))
    )
    .where(where.length > 0 ? and(...where) : undefined)
    .orderBy(desc(runsTable.updated_at), desc(runsTable.id))
    .limit(limit + 1)
    .all();

  const page = rows.slice(0, limit);
  const runs = page.map((row) => ({
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
    costUsd: decimalNanoUsd(row.cost_nano_usd),
    turns: row.turns,
    openApprovalId: row.open_approval_id,
  }));
  const last = runs[runs.length - 1];
  return {
    runs,
    nextCursor: rows.length > limit && last ? encodeRunCursor(last) : null,
  };
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
  const results = await orm(db)
    .select({
      model: agentModelCalls.model,
      calls: sql<number>`count(*)`,
      input_tokens: sql<number>`coalesce(sum(${agentModelCalls.input_tokens}), 0)`,
      cache_read_tokens: sql<number>`coalesce(sum(${agentModelCalls.cache_read_tokens}), 0)`,
      cache_write_tokens: sql<number>`coalesce(sum(${agentModelCalls.cache_write_tokens}), 0)`,
      output_tokens: sql<number>`coalesce(sum(${agentModelCalls.output_tokens}), 0)`,
      cost_nano_usd: sql<number>`coalesce(sum(${agentModelCalls.cost_nano_usd}), 0)`,
    })
    .from(agentModelCalls)
    .where(eq(agentModelCalls.run_id, runId))
    .groupBy(agentModelCalls.model)
    .orderBy(asc(agentModelCalls.model))
    .all();

  return results.map((row) => ({
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
  const result = await orm(db)
    .update(runsTable)
    .set({
      status: snapshot.status,
      summary: snapshot.summary,
      // Scalar `max()`, not the aggregate — SQLite's two-argument form. It has
      // no builder equivalent and stays a bound `sql` fragment, which is what
      // keeps a replayed older revision from making a live run look stale.
      updated_at: sql`max(${runsTable.updated_at}, ${snapshot.updatedAt})`,
      projection_seq: revision,
    })
    .where(and(eq(runsTable.id, id), lt(runsTable.projection_seq, revision)))
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
  await orm(db)
    .update(runsTable)
    .set({ updated_at: at })
    .where(and(eq(runsTable.id, id), lt(runsTable.updated_at, at)))
    .run();
}

export async function setRunStatus(
  db: D1Database,
  id: string,
  status: RunStatus,
  at = Date.now()
): Promise<void> {
  await orm(db)
    .update(runsTable)
    .set({ status, updated_at: sql`max(${runsTable.updated_at}, ${at})` })
    .where(eq(runsTable.id, id))
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
  const result = await orm(db)
    .update(runsTable)
    .set({
      status: to,
      updated_at: sql`max(${runsTable.updated_at}, ${at})`,
    })
    .where(and(eq(runsTable.id, id), eq(runsTable.status, from)))
    .run();
  return { applied: (result.meta.changes ?? 0) > 0 };
}

/**
 * Write the run's one-line summary, ONCE.
 *
 * `AND summary IS NULL` is the whole design, not a guard against a race. A
 * summary is what makes one row in the dashboard's run list distinguishable
 * from the next, and a list whose rows rewrite themselves every turn cannot be
 * scanned: the operator re-reads the same five rows looking for the one they
 * were watching. So the FIRST thing a run was asked wins, permanently, and
 * every later turn is a no-op at the database rather than a decision in the
 * caller.
 *
 * It replaced an unconditional `UPDATE runs SET summary = ?` that had no
 * callers at all — the predicate is the difference between the two, and it is
 * why this one is safe to put on the per-turn path.
 *
 * A missing row is `applied: false`, never a throw. The Durable Object owns the
 * session; it must not fail a customer's answer because the index lagged.
 */
export async function setRunSummaryIfAbsent(
  db: D1Database,
  id: string,
  summary: string
): Promise<{ applied: boolean }> {
  const result = await orm(db)
    .update(runsTable)
    .set({ summary })
    .where(and(eq(runsTable.id, id), isNull(runsTable.summary)))
    .run();
  return { applied: (result.meta.changes ?? 0) > 0 };
}
