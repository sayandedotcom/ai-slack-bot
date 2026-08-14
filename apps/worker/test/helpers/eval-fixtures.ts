import { env } from "cloudflare:test";

/**
 * Seed data for the eval API (`src/api/eval.ts`).
 *
 * WHY A SHARED HELPER. Tasks 1 and 2 of this phase are pure functions and
 * rightly built no fixtures, so today this file has exactly one consumer:
 * `test/api-eval.test.ts`. It lives in `test/helpers/` anyway because the next
 * suite that needs a scored triage scenario should import this builder rather
 * than reinvent the four confusion cells — and reinventing them is how the
 * `ingested_self` filter quietly stops being exercised.
 *
 * DISCIPLINE THIS POOL FORCES. There is no `isolatedStorage` here: D1 is shared
 * across cases AND across files. Nothing in this file deletes a table. Every row
 * carries a caller-supplied `tag` inside its primary key, `cleanupEvalFixtures`
 * removes exactly those rows, and no assertion built on top of it may depend on
 * a global count or on "the first row".
 */

export const DAY_MS = 86_400_000;

/* --------------------------------------------------------------- rows ---- */

export type SeedMessage = {
  eventId: string;
  channelId: string;
  ts: string;
  threadTs: string | null;
  userId: string | null;
  text: string;
  permalink?: string | null;
  receivedAt: number;
  /**
   * `ingested` is a real person. `ingested_self` is the agent's own reply,
   * ingested since 2026-08-14 under the on-duty engineer's `user_id` — the
   * `events_seen.outcome` column is the ONLY thing that tells them apart.
   */
  outcome?: "ingested" | "ingested_self";
};

/** One `messages` row and the `events_seen` row that classifies it. */
export async function seedMessage(row: SeedMessage): Promise<void> {
  const outcome = row.outcome ?? "ingested";
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR REPLACE INTO events_seen (event_id, channel_id, outcome, received_at) VALUES (?, ?, ?, ?)",
    ).bind(row.eventId, row.channelId, outcome, row.receivedAt),
    env.DB.prepare(
      `INSERT OR REPLACE INTO messages
         (event_id, channel_id, ts, thread_ts, user_id, text, subtype, permalink, customer_slug, received_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'pulsefit', ?)`,
    ).bind(
      row.eventId,
      row.channelId,
      row.ts,
      row.threadTs,
      row.userId,
      row.text,
      row.permalink ?? null,
      row.receivedAt,
    ),
  ]);
}

/** One `triage_decisions` row. Only `wake`, `why` and `created_at` matter here. */
export async function seedDecision(row: {
  eventId: string;
  wake: boolean;
  why: string;
  createdAt: number;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO triage_decisions
       (event_id, wake, why, opening_prompt, model, cost_usd, latency_ms, created_at)
     VALUES (?, ?, ?, 'opening', 'test-model', 0.0, 1, ?)`,
  )
    .bind(row.eventId, row.wake ? 1 : 0, row.why, row.createdAt)
    .run();
}

/**
 * One `runs` row plus one `approvals` row. `approvals.run_id` is a real foreign
 * key, so the run cannot be skipped.
 */
export async function seedApproval(row: {
  id: string;
  runId: string;
  runKey: string;
  channelId: string;
  threadTs: string;
  draft: string;
  why: string;
  decision?: "pending" | "approved" | "rejected";
  delivery?: "none" | "sent" | "suppressed";
  createdAt: number;
}): Promise<void> {
  const decision = row.decision ?? "approved";
  const delivery = row.delivery ?? "suppressed";
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR REPLACE INTO runs (id, "key", origin, channel_id, thread_ts, status, shadow, summary, created_at, updated_at)
       VALUES (?, ?, 'slack', ?, ?, 'idle', 1, NULL, ?, ?)`,
    ).bind(row.runId, row.runKey, row.channelId, row.threadTs, row.createdAt, row.createdAt),
    env.DB.prepare(
      `INSERT OR REPLACE INTO approvals
         (id, run_id, generation_id, kind, draft, why, channel_id, thread_ts, shadow,
          decision, delivery, created_at, updated_at)
       VALUES (?, ?, 'gen-1', 'slack_reply', ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    ).bind(
      row.id,
      row.runId,
      row.draft,
      row.why,
      row.channelId,
      row.threadTs,
      decision,
      delivery,
      row.createdAt,
      row.createdAt,
    ),
  ]);
}

/* ----------------------------------------------------------- scenario ---- */

export type TriageScenario = {
  tag: string;
  channelId: string;
  /** The person whose message triggered every decision below. */
  triggerUserId: string;
  /** eventId of the woken message a real human replied to, within 24h. */
  truePositive: string;
  /** eventId of the woken message nobody answered. */
  falsePositive: string;
  /** eventId of the message we let lie that a human then answered. */
  falseNegative: string;
  /** eventId of the message we let lie that nobody answered either. */
  trueNegative: string;
  /** When every trigger message in the scenario was received. */
  triggeredAt: number;
};

/**
 * THE builder: one scored scenario covering all four cells of the confusion
 * matrix, in one channel, all inside a one-day window.
 *
 * Woken/not-woken is `triage_decisions.wake`; engaged/silent is a later message
 * from a DIFFERENT user, ingested as `ingested`. Nothing here seeds an
 * `ingested_self` reply — that belongs to the case that proves it does not
 * count, and putting it in the shared scenario would make the invariant look
 * asserted when it was only assumed.
 */
export async function seedFourCellScenario(options: {
  tag: string;
  now?: number;
}): Promise<TriageScenario> {
  const { tag } = options;
  const now = options.now ?? Date.now();
  const triggeredAt = now - 2 * 60 * 60_000;
  const channelId = `C-${tag}`;
  const triggerUserId = `U-cust-${tag}`;
  const humanUserId = `U-eng-${tag}`;

  const cells = [
    { name: "tp", wake: true, engaged: true },
    { name: "fp", wake: true, engaged: false },
    { name: "fn", wake: false, engaged: true },
    { name: "tn", wake: false, engaged: false },
  ] as const;

  for (const cell of cells) {
    const eventId = `ev:${tag}:${cell.name}`;
    const threadTs = `${tag}.${cell.name}`;
    await seedMessage({
      eventId,
      channelId,
      ts: threadTs,
      threadTs,
      userId: triggerUserId,
      text: `is the ${cell.name} deploy stuck?`,
      permalink: `https://slack.example/${tag}/${cell.name}`,
      receivedAt: triggeredAt,
      outcome: "ingested",
    });
    await seedDecision({
      eventId,
      wake: cell.wake,
      why: `${cell.name}: seeded by seedFourCellScenario`,
      createdAt: triggeredAt,
    });
    if (cell.engaged) {
      await seedMessage({
        eventId: `ev:${tag}:${cell.name}-reply`,
        channelId,
        ts: `${tag}.${cell.name}r`,
        threadTs,
        userId: humanUserId,
        text: "on it — looking now",
        receivedAt: triggeredAt + 60 * 60_000,
        outcome: "ingested",
      });
    }
  }

  return {
    tag,
    channelId,
    triggerUserId,
    truePositive: `ev:${tag}:tp`,
    falsePositive: `ev:${tag}:fp`,
    falseNegative: `ev:${tag}:fn`,
    trueNegative: `ev:${tag}:tn`,
    triggeredAt,
  };
}

/* ------------------------------------------------------------ cleanup ---- */

/**
 * Remove exactly the rows this tag seeded. No `DELETE FROM <table>` anywhere:
 * the pool shares D1 with every other suite, and a bare delete here is how a
 * neighbouring file loses its fixtures.
 */
export async function cleanupEvalFixtures(tag: string): Promise<void> {
  const eventLike = `ev:${tag}:%`;
  const idLike = `%${tag}%`;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM triage_decisions WHERE event_id LIKE ?").bind(eventLike),
    env.DB.prepare("DELETE FROM messages WHERE event_id LIKE ?").bind(eventLike),
    env.DB.prepare("DELETE FROM events_seen WHERE event_id LIKE ?").bind(eventLike),
    env.DB.prepare("DELETE FROM approvals WHERE id LIKE ?").bind(idLike),
    env.DB.prepare("DELETE FROM runs WHERE id LIKE ?").bind(idLike),
  ]);
}
