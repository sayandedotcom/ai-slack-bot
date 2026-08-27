import { Hono } from "hono";
import type { Env } from "../index";
import { requireTeamMember } from "./identity";
import { detectAiTells, type AiTell } from "../eval/ai-tells";
import {
  scoreTriage,
  type TriageOutcomeRow,
  type TriageScore,
} from "../eval/triage-eval";
import type {
  ApprovalsRow,
  MessagesRow,
  TriageDecisionsRow,
} from "../db/schema";

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
const HUMAN_ENGAGED_SQL = `
-- humanEngaged: did a REAL person reply in this thread within 24h?
-- The e.outcome filter is load-bearing. Without it the agent's own reply
-- counts as engagement and every woken run scores true-positive.
SELECT 1
  FROM messages m
  JOIN events_seen e ON e.event_id = m.event_id
 WHERE e.outcome = 'ingested'
   AND m.channel_id = ?
   AND m.thread_ts  = ?
   AND m.user_id   != ?           -- not the person who triggered it
   AND m.received_at BETWEEN ? AND ? + 86400000
 LIMIT 1
`;

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
const DECISIONS_SQL = `
SELECT t.event_id, t.wake, t.why,
       m.text, m.permalink, m.channel_id, m.ts, m.thread_ts, m.user_id, m.received_at
  FROM triage_decisions t
  JOIN messages m ON m.event_id = t.event_id
 WHERE t.created_at >= ?
   AND m.received_at <= ?          -- ripe: its full 24h answer window has elapsed
 ORDER BY t.created_at DESC
 LIMIT ${MAX_DECISIONS}
`;

/**
 * How many decisions in the same window were left out for being unripe.
 *
 * Reported rather than silently excluded, for the same reason invariant 6
 * reports `null` instead of `0`: `n` is expected to be small, a rate over a
 * dozen decisions is a direction rather than a grade, and a silently shrinking
 * denominator is exactly the kind of quiet distortion this route exists to
 * avoid.
 */
const UNRIPE_COUNT_SQL = `
SELECT COUNT(*) AS unripe
  FROM triage_decisions t
  JOIN messages m ON m.event_id = t.event_id
 WHERE t.created_at >= ?
   AND m.received_at > ?
`;

/** The shadow corpus: drafts a human never saw sent. `suppressed` ONLY. */
const SUPPRESSED_SQL = `
SELECT a.id, a.draft, a.why, a.created_at, a.channel_id, a.thread_ts
  FROM approvals a
 WHERE a.delivery = 'suppressed'
 ORDER BY a.created_at DESC
 LIMIT ?
`;

/**
 * The first message a REAL person posted in the thread after the draft was
 * suppressed — the thing the draft is compared against.
 *
 * The same `e.outcome = 'ingested'` filter as the ground truth above, for the
 * same reason: a shadow draft compared against the agent's own send would be
 * comparing the model to itself.
 */
const HUMAN_REPLY_SQL = `
SELECT m.text, m.permalink, m.ts
  FROM messages m
  JOIN events_seen e ON e.event_id = m.event_id
 WHERE e.outcome = 'ingested'
   AND m.channel_id = ?
   AND m.thread_ts  = ?
   AND m.received_at >= ?
 ORDER BY m.received_at ASC
 LIMIT 1
`;

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

/** One `db.batch` per `BATCH_SIZE` statements, results in input order. */
async function batched<T>(
  db: D1Database,
  statements: D1PreparedStatement[]
): Promise<D1Result<T>[]> {
  const out: D1Result<T>[] = [];
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    out.push(...(await db.batch<T>(statements.slice(i, i + BATCH_SIZE))));
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

  const [decisions, unripe] = await c.env.DB.batch<
    DecisionRow | { unripe: number }
  >([
    c.env.DB.prepare(DECISIONS_SQL).bind(since, ripeBefore),
    c.env.DB.prepare(UNRIPE_COUNT_SQL).bind(since, ripeBefore),
  ]);
  const rows = (decisions?.results ?? []) as DecisionRow[];
  const unripeExcluded =
    ((unripe?.results ?? []) as { unripe: number }[])[0]?.unripe ?? 0;

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
    c.env.DB.prepare(HUMAN_ENGAGED_SQL).bind(
      row.channel_id,
      row.thread_ts ?? row.ts,
      row.user_id ?? "",
      row.received_at,
      row.received_at
    )
  );
  const engaged = await batched<{ 1: number }>(c.env.DB, lookups);

  const outcomes: TriageOutcomeRow[] = rows.map((row, i) => ({
    eventId: row.event_id,
    wake: row.wake === 1,
    humanEngaged: (engaged[i]?.results.length ?? 0) > 0,
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

  const suppressed = await c.env.DB.prepare(SUPPRESSED_SQL)
    .bind(limit)
    .all<
      Pick<
        ApprovalsRow,
        "id" | "draft" | "why" | "created_at" | "channel_id" | "thread_ts"
      >
    >();
  const rows = suppressed.results ?? [];

  const replies = await batched<Pick<MessagesRow, "text" | "permalink" | "ts">>(
    c.env.DB,
    rows.map((row) =>
      c.env.DB.prepare(HUMAN_REPLY_SQL).bind(
        row.channel_id,
        row.thread_ts,
        row.created_at
      )
    )
  );

  const pairs = rows.map((row, i) => {
    const reply = replies[i]?.results[0];
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
