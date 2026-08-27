/**
 * Row shapes for every D1 table, named and typed to match the DDL in
 * `migrations/*.sql` exactly.
 *
 * This file exists for one reason: before it, every call site re-declared the
 * columns it selected as an inline generic (`.first<{ event_id: string }>()`),
 * so a migration that renamed or retyped a column type-checked cleanly and
 * failed at runtime. There were four separate `MessageRow` declarations, each a
 * different projection of the same table, and nothing tied any of them to the
 * schema. Now the columns are declared once and call sites `Pick` from them, so
 * a rename lands as a compile error at every reader.
 *
 * Rules for keeping it honest:
 *
 *  - One type per table, ALL columns, in DDL order. Not "the columns somebody
 *    happens to select" — a partial table type would defeat the purpose the
 *    first time a new query needed a column that had been left out.
 *  - `Pick<...>` at the call site, so the type still states which columns that
 *    query actually selected. A row typed with columns the SELECT did not
 *    return is the same lie as an unchecked inline generic, just better dressed.
 *  - Domain unions are imported from where they already live rather than
 *    re-spelled here. These are `import type` and therefore fully erased, so
 *    the cycles they form with `channels.ts` and `identities.ts` are
 *    compile-time only and cost nothing at runtime.
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
 * Adding a migration means adding or amending a type here in the same commit.
 */

import type { ApprovalDecision, ApprovalDelivery } from "../approval/contracts";
import type { IngestOutcome } from "../ingest/rules";
import type { RunOrigin } from "../run/keys";
import type { RunStatus } from "../run/protocol";
import type { ChannelMode, SlugSource } from "./channels";
import type { Provider } from "./identities";

/** `migrations/0001_init.sql`, `migrations/0010_channel_slug_source.sql` */
export type ChannelsRow = {
  channel_id: string;
  name: string;
  customer_slug: string | null;
  mode: ChannelMode;
  slug_source: SlugSource;
};

/** `migrations/0001_init.sql` */
export type EventsSeenRow = {
  event_id: string;
  channel_id: string | null;
  outcome: IngestOutcome;
  received_at: number;
};

/** `migrations/0001_init.sql` — the system of record. */
export type MessagesRow = {
  event_id: string;
  channel_id: string;
  ts: string;
  thread_ts: string | null;
  user_id: string | null;
  text: string;
  subtype: string | null;
  permalink: string | null;
  customer_slug: string | null;
  received_at: number;
};

/** `migrations/0002_memory.sql` */
export type ZepEpisodesRow = {
  episode_uuid: string;
  event_id: string;
  graph_id: string;
  created_at: number;
};

/** `migrations/0003_triage.sql` — deliberately no type/category column. */
export type TriageDecisionsRow = {
  event_id: string;
  wake: number;
  why: string;
  opening_prompt: string;
  model: string;
  cost_usd: number;
  latency_ms: number;
  created_at: number;
};

/**
 * `migrations/0004_runs.sql`, plus `projection_seq` from
 * `migrations/0006_agent_loop.sql`.
 */
export type RunsRow = {
  id: string;
  key: string;
  origin: RunOrigin;
  channel_id: string | null;
  thread_ts: string | null;
  status: RunStatus;
  shadow: number;
  summary: string | null;
  created_at: number;
  updated_at: number;
  projection_seq: number;
};

/** `migrations/0005_codemode_effects.sql` — the at-most-once ledger. */
export type CodemodeEffectsRow = {
  effect_key: string;
  run_id: string;
  turn_id: string;
  namespace: string;
  method: string;
  args_hash: string;
  state: "reserved" | "completed" | "failed" | "in_doubt";
  safe_result_json: string | null;
  safe_error: string | null;
  created_at: number;
  updated_at: number;
};

/** `migrations/0006_agent_loop.sql` — one billed model step. */
export type AgentModelCallsRow = {
  id: string;
  run_id: string;
  generation_id: string;
  agent_turn_id: string;
  attempt: number;
  step_index: number;
  provider: string;
  model: string;
  provider_request_id: string | null;
  gateway_log_id: string | null;
  input_tokens: number;
  no_cache_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  cost_nano_usd: number;
  latency_ms: number;
  finish_reason: string | null;
  raw_finish_reason: string | null;
  error_code: string | null;
  created_at: number;
};

/** `migrations/0006_agent_loop.sql` — semantic memory work waiting for Zep. */
export type AgentMemoryOutboxRow = {
  id: string;
  run_id: string;
  generation_id: string;
  graph_id: string;
  episode_json: string;
  source_json: string;
  state: "pending" | "projecting" | "projected" | "retry" | "failed";
  attempts: number;
  claim_token: string | null;
  lease_expires_at: number | null;
  next_attempt_at: number | null;
  last_error: string | null;
  episode_uuid: string | null;
  created_at: number;
  updated_at: number;
  projected_at: number | null;
};

/** `migrations/0006_agent_loop.sql` — exact provenance for an episode. */
export type MemoryEpisodeSourcesRow = {
  episode_uuid: string;
  source_index: number;
  source_kind: "slack_message" | "run_turn" | "triage_decision" | "model_step";
  message_event_id: string | null;
  run_id: string | null;
  turn_id: string | null;
  permalink: string | null;
  created_at: number;
};

/**
 * `migrations/0007_approvals.sql`, plus the nudge columns from
 * `migrations/0009_nudges.sql`.
 */
export type ApprovalsRow = {
  id: string;
  run_id: string;
  generation_id: string;
  kind: "slack_reply";
  draft: string;
  why: string;
  channel_id: string;
  thread_ts: string;
  shadow: number;
  decision: ApprovalDecision;
  decided_by: string | null;
  decided_at: number | null;
  edited_text: string | null;
  reject_reason: string | null;
  delivery: ApprovalDelivery;
  delivery_error: string | null;
  resolution_delivered_at: number | null;
  created_at: number;
  updated_at: number;
  nudged_at: number | null;
  nudge_channel_id: string | null;
  nudge_ts: string | null;
};

/** `migrations/0008_identities.sql` — `token_ciphertext` is opaque here too. */
export type IdentitiesRow = {
  email: string;
  provider: Provider;
  external_id: string;
  scopes: string;
  token_ciphertext: string;
  connected_at: number;
  updated_at: number;
};
