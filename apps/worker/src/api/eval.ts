import {
  and,
  asc,
  between,
  desc,
  eq,
  gt,
  gte,
  lte,
  ne,
  sql,
} from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Hono } from "hono";
import { orm } from "../db/client";
import type { MessagesRow, TriageDecisionsRow } from "../db/schema";
import { approvals, eventsSeen, messages, triageDecisions } from "../db/tables";
import { type AiTell, detectAiTells } from "../eval/ai-tells";
import {
  scoreTriage,
  type TriageOutcomeRow,
  type TriageScore,
} from "../eval/triage-eval";
import type { Env } from "../index";
import { requireTeamMember } from "./identity";

/**
 * The eval API: how good was the triage decision, and how close was the shadow
 * draft to what a human actually said.
 *
 * READ-ONLY AND D1-ONLY, and that is a design constraint rather than an
 * accident of the current implementation. Nothing in this file references
 * `env.RUNS`, opens a Durable Object, calls a vendor, touches Zep or reaches
 * Anthropic. Scoring a month of decisions is a bounded set of indexed reads,
 * which is what makes it cheap enough to sit on a dashboard and refresh.
 *
 * NEITHER HALF COMPUTES A RATE. `scoreTriage` (`src/eval/triage-eval.ts`) is
 * the only thing in the codebase that turns outcomes into precision and recall,
 * and `detectAiTells` (`src/eval/ai-tells.ts`) is the only thing that decides
 * what an AI tell is. This file's whole job is to hand each of them CORRECT
 * ROWS. Re-deriving a rate here would give the project two answers to the same
 * question, and the second one would be the untested one.
 *
 * The router is exported unmounted; `src/index.ts` mounts it under `/api`,
 * which is why the paths below are `/eval/triage` and `/eval/shadow`.
 */

export const evalApi = new Hono<{ Bindings: Env }>();

const DAY_MS = 86_400_000;

/**
 * A hard bound on how many decisions one request will score.
 *
 * Ninety days of real traffic is far short of this, so in practice it never
 * binds — it exists so that a pathological window cannot turn a dashboard
 * refresh into an unbounded fan-out of engagement lookups.
 */
const MAX_DECISIONS = 5_000;

/** How many engagement lookups go into one `db.batch` round trip. */
const BATCH_SIZE = 100;

/* ------------------------------------------------------------- ground truth */

/**
 * THE ONE DEFINITION OF "a human engaged", and the only place it is written.
 *
 * The `e.outcome` filter is load-bearing. Since 2026-08-14 the agent's own
 * replies are ingested into `messages` and they carry the ON-DUTY ENGINEER'S
 * `user_id`, because that is whose Slack identity they were sent under.
 * `events_seen.outcome` is the only column that tells them from a real
 * person's message: ours are `ingested_self`, theirs are `ingested`. Without
 * the filter, on any woken run where the agent replied, that reply satisfies
 * "a different user engaged" and the decision scores a TRUE POSITIVE BY
 * CONSTRUCTION — precision would climb toward 1.0 as a direct function of the
 * agent replying more, which is the one thing an eval must never reward.
 */
function humanEngagedQuery(
  db: D1Database,
  input: {
    channelId: string;
    threadTs: string;
    askerUserId: string;
    receivedAt: number;
  }
) {
  return orm(db)
    .select({ present: sql<number>`1` })
    .from(messages)
    .innerJoin(eventsSeen, eq(eventsSeen.event_id, messages.event_id))
    .where(
      and(
        // The e.outcome filter is load-bearing. Without it the agent's own
        // reply counts as engagement and every woken run scores
        // true-positive.
        eq(eventsSeen.outcome, "ingested"),
        eq(messages.channel_id, input.channelId),
        eq(messages.thread_ts, input.threadTs),
        // Not the person who triggered it.
        ne(messages.user_id, input.askerUserId),
        between(
          messages.received_at,
          input.receivedAt,
          input.receivedAt + DAY_MS
        )
      )
    )
    .limit(1);
}

/**
 * Every RIPE decision in the window, with the message it was made about.
 *
 * An INNER JOIN on purpose: a decision whose message row is gone cannot be
 * scored (there is no thread to look for engagement in, and no text to show a
 * human), and counting it as a silent true/false negative would be inventing
 * ground truth rather than reading it.
 *
 * RIPENESS — `m.received_at <= ?` where the bind is `now - 24h` — is the second
 * filter that decides whether the headline number is honest. Engagement is
 * sought in `[received_at, received_at + 24h]`, so a decision made an hour ago
 * is being scored against a window that has not finished yet: it reads FP or TN
 * today and may become TP or FN tomorrow, purely because time passed. The bias
 * is downward, so it never flatters — but it makes `?days=1` a different and
 * worse measurement than `?days=30`, and makes the headline number drift for
 * reasons that have nothing to do with model quality. Only decisions whose full
 * 24 hours have elapsed are scored; the rest are counted and reported as
 * `unripeExcluded` rather than silently dropped.
 */
function decisionsQuery(db: D1Database, since: number, ripeBefore: number) {
  return orm(db)
    .select({
      event_id: triageDecisions.event_id,
      wake: triageDecisions.wake,
      why: triageDecisions.why,
      text: messages.text,
      permalink: messages.permalink,
      channel_id: messages.channel_id,
      ts: messages.ts,
      thread_ts: messages.thread_ts,
      user_id: messages.user_id,
      received_at: messages.received_at,
    })
    .from(triageDecisions)
    .innerJoin(messages, eq(messages.event_id, triageDecisions.event_id))
    .where(
      and(
        gte(triageDecisions.created_at, since),
        // Ripe: its full 24h answer window has elapsed.
        lte(messages.received_at, ripeBefore)
      )
    )
    .orderBy(desc(triageDecisions.created_at))
    .limit(MAX_DECISIONS);
}

/**
 * How many decisions in the same window were left out for being unripe.
 *
 * Reported rather than silently excluded, for the same reason invariant 6
 * reports `null` instead of `0`: `n` is expected to be small, a rate over a
 * dozen decisions is a direction rather than a grade, and a silently shrinking
 * denominator is exactly the kind of quiet distortion this route exists to
 * avoid.
 */
function unripeCountQuery(db: D1Database, since: number, ripeBefore: number) {
  return orm(db)
    .select({ unripe: sql<number>`count(*)` })
    .from(triageDecisions)
    .innerJoin(messages, eq(messages.event_id, triageDecisions.event_id))
    .where(
      and(
        gte(triageDecisions.created_at, since),
        gt(messages.received_at, ripeBefore)
      )
    );
}

/** The shadow corpus: drafts a human never saw sent. `suppressed` ONLY. */
function suppressedQuery(db: D1Database, limit: number) {
  return orm(db)
    .select({
      id: approvals.id,
      draft: approvals.draft,
      why: approvals.why,
      created_at: approvals.created_at,
      channel_id: approvals.channel_id,
      thread_ts: approvals.thread_ts,
    })
    .from(approvals)
    .where(eq(approvals.delivery, "suppressed"))
    .orderBy(desc(approvals.created_at))
    .limit(limit);
}

/**
 * The first message a REAL person posted in the thread after the draft was
 * suppressed — the thing the draft is compared against.
 *
 * The same `e.outcome = 'ingested'` filter as the ground truth above, for the
 * same reason: a shadow draft compared against the agent's own send would be
 * comparing the model to itself.
 */
function humanReplyQuery(
  db: D1Database,
  input: { channelId: string; threadTs: string; after: number }
) {
  return orm(db)
    .select({
      text: messages.text,
      permalink: messages.permalink,
      ts: messages.ts,
    })
    .from(messages)
    .innerJoin(eventsSeen, eq(eventsSeen.event_id, messages.event_id))
    .where(
      and(
        // The same `ingested` filter as the ground truth above, for the same
        // reason: a shadow draft compared against the agent's own send would
        // be comparing the model to itself.
        eq(eventsSeen.outcome, "ingested"),
        eq(messages.channel_id, input.channelId),
        eq(messages.thread_ts, input.threadTs),
        gte(messages.received_at, input.after)
      )
    )
    .orderBy(asc(messages.received_at))
    .limit(1);
}

/* ------------------------------------------------------------------ util --- */

/**
 * Clamp, never reject. A dashboard that sends `days=0` because a text input was
 * cleared should get the narrowest honest window back, not a 400 it has to
 * render as an error.
 */
function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * One `db.batch` per `BATCH_SIZE` statements, results in input order.
 *
 * Typed over the row shape now rather than over `D1Result<T>`: a batched
 * SELECT built by the query builder comes back as the rows themselves, so the
 * callers below index straight into `T[][]` instead of unwrapping `.results`.
 */
async function batched<T>(
  db: D1Database,
  statements: BatchItem<"sqlite">[]
): Promise<T[][]> {
  const out: T[][] = [];
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    const chunk = statements.slice(i, i + BATCH_SIZE) as [
      BatchItem<"sqlite">,
      ...BatchItem<"sqlite">[],
    ];
    out.push(...((await orm(db).batch(chunk)) as unknown as T[][]));
  }
  return out;
}

type DecisionRow = Pick<TriageDecisionsRow, "event_id" | "wake" | "why"> &
  Pick<
    MessagesRow,
    | "text"
    | "permalink"
    | "channel_id"
    | "ts"
    | "thread_ts"
    | "user_id"
    | "received_at"
  >;

/* ---------------------------------------------------------------- routes --- */

/**
 * `GET /api/eval/triage?days=30` — precision and recall over stored triage
 * decisions, plus the rows a human should look at.
 *
 * `n` accompanies every rate and an unmeasured rate is `null`, both of which
 * are `scoreTriage`'s doing. This route does not touch either.
 *
 * Three numbers travel beside the score, and all three exist so that a shrunken
 * or clipped denominator is VISIBLE rather than silent: `windowDays` (what was
 * asked for, after clamping), `unripeExcluded` (decisions too recent to have
 * had their full 24h answer window) and `truncated` (whether the window held
 * more decisions than one request will score).
 */
evalApi.get("/eval/triage", async (c) => {
  const member = await requireTeamMember(c);
  if (member instanceof Response) return member;

  const windowDays = clampInt(c.req.query("days"), 30, 1, 90);
  const now = Date.now();
  const since = now - windowDays * DAY_MS;
  // A decision is ripe once 24h have passed since the message it was made
  // about. `<=` on the boundary: at exactly 24h the window has fully elapsed.
  const ripeBefore = now - DAY_MS;

  const d = orm(c.env.DB);
  const [decisions, unripe] = await d.batch([
    decisionsQuery(c.env.DB, since, ripeBefore),
    unripeCountQuery(c.env.DB, since, ripeBefore),
  ]);
  const rows: DecisionRow[] = decisions;
  const unripeExcluded = unripe[0]?.unripe ?? 0;

  /**
   * The engagement lookup runs once per decision, as the ground-truth statement
   * VERBATIM — one prepared statement, one definition, no second phrasing of it
   * inlined as a correlated subquery. `db.batch` collapses each hundred of them
   * into one round trip, so this is N indexed reads and N/100 round trips, not
   * N round trips.
   *
   * `thread_ts ?? ts` because a top-level message carries no `thread_ts` while
   * its replies carry the parent's `ts` as theirs. `user_id ?? ""` because
   * `user_id != NULL` is NULL in SQL, which would silently exclude every row;
   * no real Slack user id is the empty string, so `!= ''` keeps them all.
   *
   * The ROW side of that comparison is a decision too, not an inherited
   * accident: a candidate reply whose own `m.user_id` is NULL fails
   * `m.user_id != ''` (NULL comparisons are NULL) and therefore never counts as
   * engagement. Per `src/ingest/consumer.ts` those are the bot and subtype
   * messages — a join/leave notice or an app post is not a human answering the
   * customer, so excluding them is correct.
   */
  const lookups = rows.map((row) =>
    humanEngagedQuery(c.env.DB, {
      channelId: row.channel_id,
      threadTs: row.thread_ts ?? row.ts,
      askerUserId: row.user_id ?? "",
      receivedAt: row.received_at,
    })
  );
  const engaged = await batched<{ present: number }>(c.env.DB, lookups);

  const outcomes: TriageOutcomeRow[] = rows.map((row, i) => ({
    eventId: row.event_id,
    wake: row.wake === 1,
    humanEngaged: (engaged[i]?.length ?? 0) > 0,
    why: row.why,
    text: row.text,
    permalink: row.permalink,
  }));

  const score: TriageScore = scoreTriage(outcomes);
  // `truncated` says the window held at least MAX_DECISIONS scoreable rows, so
  // `score` describes the NEWEST MAX_DECISIONS of them rather than the window.
  // The bound is deliberate; reporting it is what stops it being a silent lie.
  return c.json({
    score,
    windowDays,
    unripeExcluded,
    truncated: rows.length === MAX_DECISIONS,
  });
});

/**
 * `GET /api/eval/shadow?limit=20` — suppressed drafts paired with what the
 * human actually said, newest first.
 *
 * `humanReply` is `null` when no human replied. Honest absence: an empty-string
 * stand-in would read downstream as "the human said nothing", which is a
 * different and false claim from "nobody has replied yet".
 */
evalApi.get("/eval/shadow", async (c) => {
  const member = await requireTeamMember(c);
  if (member instanceof Response) return member;

  const limit = clampInt(c.req.query("limit"), 20, 1, 50);

  const rows = await suppressedQuery(c.env.DB, limit).all();

  const replies = await batched<Pick<MessagesRow, "text" | "permalink" | "ts">>(
    c.env.DB,
    rows.map((row) =>
      humanReplyQuery(c.env.DB, {
        channelId: row.channel_id,
        threadTs: row.thread_ts,
        after: row.created_at,
      })
    )
  );

  const pairs = rows.map((row, i) => {
    const reply = replies[i]?.[0];
    const tells: AiTell[] = detectAiTells(row.draft);
    return {
      approvalId: row.id,
      draft: row.draft,
      why: row.why,
      createdAt: row.created_at,
      channelId: row.channel_id,
      threadTs: row.thread_ts,
      tells,
      humanReply:
        reply === undefined
          ? null
          : { text: reply.text, permalink: reply.permalink, ts: reply.ts },
    };
  });

  return c.json({ pairs });
});
