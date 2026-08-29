/**
 * Row shapes for every D1 table.
 *
 * This file exists for one reason: before it, every call site re-declared the
 * columns it selected as an inline generic (`.first<{ event_id: string }>()`),
 * so a migration that renamed or retyped a column type-checked cleanly and
 * failed at runtime. There were four separate `MessageRow` declarations, each a
 * different projection of the same table, and nothing tied any of them to the
 * schema. Now the columns are declared once and call sites `Pick` from them, so
 * a rename lands as a compile error at every reader.
 *
 * WHAT CHANGED WITH DRIZZLE: these types are no longer hand-written. Each one
 * is `typeof <table>.$inferSelect` over the Drizzle definitions in
 * `./tables.ts`, which are themselves checked against the migrations by
 * `test/db/tables.test.ts`. The rule "one type per table, ALL columns, in DDL
 * order" is now structural rather than a convention someone has to honour, and
 * the columns are described in exactly one place instead of two.
 *
 * The names and shapes are deliberately unchanged, so every existing
 * `Pick<RunsRow, ...>` call site still means what it meant. The remaining
 * rules for keeping it honest:
 *
 *  - `Pick<...>` at the call site, so the type still states which columns that
 *    query actually selected. A row typed with columns the SELECT did not
 *    return is the same lie as an unchecked inline generic, just better dressed.
 *  - Domain unions are pinned on the column with `.$type<...>()` in
 *    `tables.ts`, imported from where they already live rather than re-spelled.
 *  - Aggregates (`COUNT(*) AS heard`, `COALESCE(SUM(...)) AS cost_nano_usd`)
 *    are deliberately NOT modelled here. Those aliases are computed values, not
 *    columns; giving them a column type would assert a correspondence that does
 *    not exist. They stay inline at their call sites.
 *  - Nullability follows the DDL, NOT the query. A `LEFT JOIN` can return NULL
 *    for a NOT NULL column, so a join's row type widens at the call site (see
 *    `listRuns` in `src/run/repository.ts`) rather than being weakened here.
 *
 * D1 maps TEXT to string, INTEGER and REAL to number, and any nullable column
 * to `| null`. Booleans are INTEGER 0/1 and stay `number` — the conversion to
 * `boolean` belongs in the repository's mapper, where it already is.
 *
 * Adding a migration means adding or amending the table in `tables.ts` in the
 * same commit; `test/db/tables.test.ts` fails until it is done.
 */

import type {
  agentMemoryOutbox,
  agentModelCalls,
  approvals,
  channels,
  codemodeEffects,
  eventsSeen,
  identities,
  memoryEpisodeSources,
  messages,
  runs,
  triageDecisions,
  zepEpisodes,
} from "./tables";

/** `migrations/0001_init.sql`, `migrations/0010_channel_slug_source.sql` */
export type ChannelsRow = typeof channels.$inferSelect;

/** `migrations/0001_init.sql` */
export type EventsSeenRow = typeof eventsSeen.$inferSelect;

/** `migrations/0001_init.sql` — the system of record. */
export type MessagesRow = typeof messages.$inferSelect;

/** `migrations/0002_memory.sql` */
export type ZepEpisodesRow = typeof zepEpisodes.$inferSelect;

/** `migrations/0003_triage.sql` — deliberately no type/category column. */
export type TriageDecisionsRow = typeof triageDecisions.$inferSelect;

/**
 * `migrations/0004_runs.sql`, plus `projection_seq` from
 * `migrations/0006_agent_loop.sql`.
 */
export type RunsRow = typeof runs.$inferSelect;

/** `migrations/0005_codemode_effects.sql` — the at-most-once ledger. */
export type CodemodeEffectsRow = typeof codemodeEffects.$inferSelect;

/** `migrations/0006_agent_loop.sql` — one billed model step. */
export type AgentModelCallsRow = typeof agentModelCalls.$inferSelect;

/** `migrations/0006_agent_loop.sql` — semantic memory work waiting for Zep. */
export type AgentMemoryOutboxRow = typeof agentMemoryOutbox.$inferSelect;

/** `migrations/0006_agent_loop.sql` — exact provenance for an episode. */
export type MemoryEpisodeSourcesRow = typeof memoryEpisodeSources.$inferSelect;

/**
 * `migrations/0007_approvals.sql`, plus the nudge columns from
 * `migrations/0009_nudges.sql`.
 */
export type ApprovalsRow = typeof approvals.$inferSelect;

/** `migrations/0008_identities.sql` — `token_ciphertext` is opaque here too. */
export type IdentitiesRow = typeof identities.$inferSelect;
