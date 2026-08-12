import type { MemoryFact } from "./store";

export type Citation = {
  factId: string;
  fact: string;
  permalink: string;
  channel_id: string;
  ts: string;
};

type CitationRow = {
  permalink: string | null;
  channel_id: string;
  ts: string;
};

/**
 * Facts are probabilistic; citations must be exact.
 *
 * There are now TWO kinds of episode behind a fact, because memory has two
 * halves, and an episode uuid is resolved against both:
 *
 *  1. a customer MESSAGE episode → `zep_episodes` → `messages`;
 *  2. an AGENT episode → `memory_episode_sources` → `messages`.
 *
 * A miss anywhere in either chain yields NO citation rather than a constructed
 * URL. Decision D4, and the reason `channel_id`/`ts` are read from the message
 * row rather than assembled: this system never builds a Slack URL out of a
 * channel and a timestamp, because a URL that looks right and points nowhere is
 * worse than an honest absence.
 */
export async function cite(db: D1Database, facts: MemoryFact[]): Promise<Citation[]> {
  const citations: Citation[] = [];
  for (const fact of facts) {
    for (const episodeUuid of fact.episodeUuids) {
      const row = await resolveEpisode(db, episodeUuid);
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

/**
 * One episode uuid, resolved to the message it came from.
 *
 * The message chain is tried FIRST and the agent chain second, which is the
 * plan's "prefer the original `messages` row over a copied permalink when both
 * exist". `zep_episodes` maps an episode to the message it was BUILT from, so
 * it is the stronger claim; `memory_episode_sources` records what an agent
 * episode was built ON, which can be several messages, and its own permalink
 * column is a convenience copy taken at projection time.
 */
async function resolveEpisode(
  db: D1Database,
  episodeUuid: string,
): Promise<CitationRow | null> {
  const message = await db
    .prepare(
      `SELECT m.permalink, m.channel_id, m.ts
         FROM zep_episodes z JOIN messages m ON m.event_id = z.event_id
        WHERE z.episode_uuid = ?`,
    )
    .bind(episodeUuid)
    .first<CitationRow>();
  if (message?.permalink) return message;

  // An agent episode. The JOIN is what makes this exact: a source row whose
  // `message_event_id` no longer resolves to a stored message produces no
  // citation, even though the row itself holds a permalink copy. The live
  // message is the system of record; the copy is not evidence of anything.
  const source = await db
    .prepare(
      `SELECT m.permalink, m.channel_id, m.ts
         FROM memory_episode_sources s JOIN messages m ON m.event_id = s.message_event_id
        WHERE s.episode_uuid = ? AND s.message_event_id IS NOT NULL
        ORDER BY s.source_index ASC
        LIMIT 1`,
    )
    .bind(episodeUuid)
    .first<CitationRow>();
  return source ?? null;
}
