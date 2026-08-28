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

export async function getCounters(
  db: D1Database,
  sinceMs: number
): Promise<Counters> {
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS heard,
         SUM(CASE WHEN outcome = 'ingested' THEN 1 ELSE 0 END) AS ingested
       FROM events_seen
       WHERE received_at >= ?`
    )
    .bind(sinceMs)
    .first<{ heard: number; ingested: number | null }>();

  const triagedRow = await db
    .prepare(
      `SELECT COUNT(*) AS triaged,
              SUM(CASE WHEN wake = 1 THEN 1 ELSE 0 END) AS woken
       FROM triage_decisions WHERE created_at >= ?`
    )
    .bind(sinceMs)
    .first<{ triaged: number; woken: number | null }>();

  // Every row in `approvals` IS an escalation — `escalate` mints the row, and
  // nothing else does — so counting rows created in the window counts asks,
  // regardless of what a human later decided. A plain D1 read, matching
  // invariant 7: reads never wake a DO.
  const escalatedRow = await db
    .prepare(
      "SELECT COUNT(*) AS escalated FROM approvals WHERE created_at >= ?"
    )
    .bind(sinceMs)
    .first<{ escalated: number }>();

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
