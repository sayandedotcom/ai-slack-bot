import type { EpisodeSourceDescriptor } from "./episode";
import type { MessagesRow } from "../db/schema";

/**
 * Turning a bounded source DESCRIPTOR into an exact D1 provenance row.
 *
 * The rule this file exists to enforce: a citation resolves to a permalink that
 * D1 actually stores, or it resolves to nothing. No permalink is ever built
 * from channel and timestamp components, and an unresolvable descriptor is
 * dropped rather than recorded with a guessed link. A missing citation says
 * "we have no exact source"; a fabricated one says "here is the proof", and
 * only one of those is survivable.
 */

export type ResolvedSource = {
  /** A `memory_episode_sources.source_kind` value the migration's CHECK allows. */
  sourceKind: "slack_message" | "run_turn";
  messageEventId: string | null;
  runId: string | null;
  turnId: string | null;
  permalink: string | null;
};

type MessageRow = Pick<MessagesRow, "event_id" | "permalink">;

/**
 * Resolve one descriptor against D1's system of record.
 *
 * `zep_episode` is the descriptor that carries the whole point of Task 9's
 * provenance rule. It is registered by `memory.recall`/`memory.cite` from the
 * episode UUIDs those reads RETURNED, so a Chat answer built on PulseFit's
 * customer memory cites that customer's message — not the Chat question that
 * happened to trigger the lookup.
 */
async function resolveOne(
  db: D1Database,
  source: EpisodeSourceDescriptor,
  runId: string
): Promise<ResolvedSource | null> {
  if (source.kind === "zep_episode") {
    const row = await db
      .prepare(
        `SELECT m.event_id, m.permalink
           FROM zep_episodes z JOIN messages m ON m.event_id = z.event_id
          WHERE z.episode_uuid = ?`
      )
      .bind(source.ref)
      .first<MessageRow>();
    if (!row) return null;
    return {
      sourceKind: "slack_message",
      messageEventId: row.event_id,
      runId,
      turnId: null,
      permalink: row.permalink,
    };
  }

  // Both remaining kinds carry a stored message event id. They differ only in
  // what the row MEANS — evidence the agent searched for, versus the turn it
  // was answering — and that distinction is worth keeping in the column.
  const row = await db
    .prepare("SELECT event_id, permalink FROM messages WHERE event_id = ?")
    .bind(source.ref)
    .first<MessageRow>();
  if (!row) return null;
  return {
    sourceKind: source.kind === "run_turn" ? "run_turn" : "slack_message",
    messageEventId: row.event_id,
    runId,
    turnId: source.turnId ?? null,
    permalink: row.permalink,
  };
}

export type PreparedSourceRow = ResolvedSource & { sourceIndex: number };

/**
 * Resolve every descriptor, keeping order and dropping every miss.
 *
 * `source_index` is assigned from the RESOLVED list rather than the descriptor
 * list, so the rows are dense and the primary key is stable under redelivery:
 * the same outbox payload always produces the same indices, because it is
 * resolved against the same D1 rows.
 */
export async function resolveSources(
  db: D1Database,
  sources: readonly EpisodeSourceDescriptor[],
  runId: string
): Promise<PreparedSourceRow[]> {
  const out: PreparedSourceRow[] = [];
  for (const source of sources) {
    const resolved = await resolveOne(db, source, runId);
    if (resolved === null) continue;
    out.push({ ...resolved, sourceIndex: out.length });
  }
  return out;
}

/** Parse the frozen `source_json` payload, tolerating nothing unexpected. */
export function parseSourceDescriptors(
  json: string
): EpisodeSourceDescriptor[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  const out: EpisodeSourceDescriptor[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const kind = record.kind;
    const ref = record.ref;
    if (typeof ref !== "string" || ref.length === 0) continue;
    if (
      kind !== "run_turn" &&
      kind !== "zep_episode" &&
      kind !== "slack_message"
    )
      continue;
    out.push(
      typeof record.turnId === "string"
        ? { kind, ref, turnId: record.turnId }
        : { kind, ref }
    );
  }
  return out;
}
