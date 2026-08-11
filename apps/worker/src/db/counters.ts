export type Counters = {
  /** Envelopes the consumer accepted, before drop rules. */
  heard: number;
  /** Rows committed to `messages`. `heard > ingested` is healthy. */
  ingested: number;
  /** Populated in Phase 07. */
  triaged: number;
  /** Populated in Phase 11. */
  escalated: number;
};

export async function getCounters(db: D1Database, sinceMs: number): Promise<Counters> {
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS heard,
         SUM(CASE WHEN outcome = 'ingested' THEN 1 ELSE 0 END) AS ingested
       FROM events_seen
       WHERE received_at >= ?`,
    )
    .bind(sinceMs)
    .first<{ heard: number; ingested: number | null }>();

  return {
    heard: row?.heard ?? 0,
    ingested: row?.ingested ?? 0,
    triaged: 0,
    escalated: 0,
  };
}
