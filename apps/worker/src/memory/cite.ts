import type { MemoryFact } from "./store";

export type Citation = {
  factId: string;
  fact: string;
  permalink: string;
  channel_id: string;
  ts: string;
};

/**
 * Facts are probabilistic; citations must be exact. Resolution goes
 * episode UUID -> zep_episodes -> messages.permalink, and a miss anywhere in
 * that chain yields no citation rather than a constructed URL. Decision D4.
 */
export async function cite(db: D1Database, facts: MemoryFact[]): Promise<Citation[]> {
  const citations: Citation[] = [];
  for (const fact of facts) {
    for (const episodeUuid of fact.episodeUuids) {
      const row = await db
        .prepare(
          `SELECT m.permalink, m.channel_id, m.ts
           FROM zep_episodes z JOIN messages m ON m.event_id = z.event_id
           WHERE z.episode_uuid = ?`,
        )
        .bind(episodeUuid)
        .first<{ permalink: string | null; channel_id: string; ts: string }>();
      if (!row?.permalink) continue;
      citations.push({
        factId: fact.factId,
        fact: fact.fact,
        permalink: row.permalink,
        channel_id: row.channel_id,
        ts: row.ts,
      });
      break; // One citation per fact — the first resolvable episode wins.
    }
  }
  return citations;
}
