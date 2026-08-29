import { gte, sql } from "drizzle-orm";
import { orm } from "./client";
import { approvals, eventsSeen, triageDecisions } from "./tables";

export type Counters = {
  /** Envelopes the consumer accepted, before drop rules. */
  heard: number;
  /** Rows committed to `messages`. `heard > ingested` is healthy. */
  ingested: number;
  /** Triage decisions stored in the window — wakes and non-wakes alike. */
  triaged: number;
  /** Triage decisions that said `wake = 1`: threads the main model worked on. */
  woken: number;
  /** `triaged - woken`, computed here so no client ever derives it from a missing field. */
  dropped: number;
  /** `approvals` rows opened in the window — every escalation, any decision. */
  escalated: number;
};

/**
 * The aggregates stay `sql` fragments rather than becoming modelled columns,
 * which is the same rule `src/db/schema.ts` states: `COUNT(*) AS heard` is a
 * computed value, not a column, and typing it as one would assert a
 * correspondence that does not exist. Drizzle types the fragment through
 * `sql<T>` at the point of use, which is exactly where the claim belongs.
 */
export async function getCounters(
  db: D1Database,
  sinceMs: number
): Promise<Counters> {
  const d = orm(db);

  const row = await d
    .select({
      heard: sql<number>`count(*)`,
      ingested: sql<
        number | null
      >`sum(case when ${eventsSeen.outcome} = 'ingested' then 1 else 0 end)`,
    })
    .from(eventsSeen)
    .where(gte(eventsSeen.received_at, sinceMs))
    .get();

  const triagedRow = await d
    .select({
      triaged: sql<number>`count(*)`,
      woken: sql<
        number | null
      >`sum(case when ${triageDecisions.wake} = 1 then 1 else 0 end)`,
    })
    .from(triageDecisions)
    .where(gte(triageDecisions.created_at, sinceMs))
    .get();

  // Every row in `approvals` IS an escalation — `escalate` mints the row, and
  // nothing else does — so counting rows created in the window counts asks,
  // regardless of what a human later decided. A plain D1 read, matching
  // invariant 7: reads never wake a DO.
  const escalatedRow = await d
    .select({ escalated: sql<number>`count(*)` })
    .from(approvals)
    .where(gte(approvals.created_at, sinceMs))
    .get();

  const triaged = triagedRow?.triaged ?? 0;
  const woken = triagedRow?.woken ?? 0;
  return {
    heard: row?.heard ?? 0,
    ingested: row?.ingested ?? 0,
    triaged,
    woken,
    dropped: Math.max(0, triaged - woken),
    escalated: escalatedRow?.escalated ?? 0,
  };
}
