import {
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import type { ApprovalDecision, ApprovalDelivery } from "../approval/contracts";
import type { IngestOutcome } from "../ingest/rules";
import type { RunOrigin } from "../run/keys";
import type { RunStatus } from "../run/protocol";
import type { ChannelMode, SlugSource } from "./channels";
import type { Provider } from "./identities";

/**
 * Drizzle table definitions for every D1 table, mirroring the DDL in
 * `migrations/*.sql`.
 *
 * THE MIGRATIONS REMAIN THE SOURCE OF TRUTH. `drizzle-kit` is deliberately NOT
 * installed and there is no `drizzle.config.ts`: migrations are append-only,
 * hand-written, and their comments carry design rationale that a generator
 * would discard. This file is a typed *view* of tables it did not create.
 *
 * That leaves one risk — a migration and this file drifting apart — and it is
 * not left to discipline. `test/db/tables.test.ts` introspects the migrated
 * test database with `PRAGMA table_info` and asserts, per table, that the
 * column names, SQL types, NOT NULL flags and defaults here match what the
 * migrations actually produced. A new migration that this file does not
 * describe fails that test.
 *
 * Conventions, both load-bearing:
 *
 *  - TS property names are the SNAKE_CASE column names, so
 *    `typeof runs.$inferSelect` is structurally identical to the row type
 *    `src/db/schema.ts` used to declare by hand. That is what let this land
 *    without touching the ~70 `Pick<RunsRow, ...>` call sites.
 *  - Domain unions are pinned with `.$type<...>()` from where they already
 *    live rather than re-spelled as `text({ enum: [...] })`. A second spelling
 *    of `ApprovalDecision` is a second thing to keep in step. These are
 *    `import type` and fully erased, exactly as in `schema.ts`.
 *
 * Indexes are NOT declared here. They are DDL, they live in the migrations,
 * and nothing in the query builder needs them: the one index this code reasons
 * about — `idx_approvals_one_open` — is used by letting an INSERT fail, never
 * as an `ON CONFLICT` target. Declaring them would double the drift surface
 * for no gain.
 *
 * Booleans stay INTEGER 0/1 and therefore `number`; the conversion to
 * `boolean` belongs in the repository mappers, where it already is.
 */

/** `migrations/0001_init.sql`, `migrations/0010_channel_slug_source.sql` */
export const channels = sqliteTable("channels", {
  channel_id: text("channel_id").primaryKey(),
  name: text("name").notNull(),
  customer_slug: text("customer_slug"),
  mode: text("mode").$type<ChannelMode>().notNull(),
  slug_source: text("slug_source")
    .$type<SlugSource>()
    .notNull()
    .default("derived"),
});

/** `migrations/0001_init.sql` */
export const eventsSeen = sqliteTable("events_seen", {
  event_id: text("event_id").primaryKey(),
  channel_id: text("channel_id"),
  outcome: text("outcome").$type<IngestOutcome>().notNull(),
  received_at: integer("received_at").notNull(),
});

/** `migrations/0001_init.sql` — the system of record. */
export const messages = sqliteTable("messages", {
  event_id: text("event_id").primaryKey(),
  channel_id: text("channel_id").notNull(),
  ts: text("ts").notNull(),
  thread_ts: text("thread_ts"),
  user_id: text("user_id"),
  text: text("text").notNull(),
  subtype: text("subtype"),
  permalink: text("permalink"),
  customer_slug: text("customer_slug"),
  received_at: integer("received_at").notNull(),
});

/** `migrations/0002_memory.sql` */
export const zepEpisodes = sqliteTable("zep_episodes", {
  episode_uuid: text("episode_uuid").primaryKey(),
  event_id: text("event_id").notNull(),
  graph_id: text("graph_id").notNull(),
  created_at: integer("created_at").notNull(),
});

/** `migrations/0003_triage.sql` — deliberately no type/category column. */
export const triageDecisions = sqliteTable("triage_decisions", {
  event_id: text("event_id").primaryKey(),
  wake: integer("wake").notNull(),
  why: text("why").notNull(),
  opening_prompt: text("opening_prompt").notNull(),
  model: text("model").notNull(),
  cost_usd: real("cost_usd").notNull(),
  latency_ms: integer("latency_ms").notNull(),
  created_at: integer("created_at").notNull(),
});

/**
 * `migrations/0004_runs.sql`, plus `projection_seq` from
 * `migrations/0006_agent_loop.sql`.
 */
export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  origin: text("origin").$type<RunOrigin>().notNull(),
  channel_id: text("channel_id"),
  thread_ts: text("thread_ts"),
  status: text("status").$type<RunStatus>().notNull(),
  shadow: integer("shadow").notNull().default(0),
  summary: text("summary"),
  created_at: integer("created_at").notNull(),
  updated_at: integer("updated_at").notNull(),
  projection_seq: integer("projection_seq").notNull().default(0),
});

/** `migrations/0005_codemode_effects.sql` — the at-most-once ledger. */
export const codemodeEffects = sqliteTable("codemode_effects", {
  effect_key: text("effect_key").primaryKey(),
  run_id: text("run_id").notNull(),
  turn_id: text("turn_id").notNull(),
  namespace: text("namespace").notNull(),
  method: text("method").notNull(),
  args_hash: text("args_hash").notNull(),
  state: text("state")
    .$type<"reserved" | "completed" | "failed" | "in_doubt">()
    .notNull(),
  safe_result_json: text("safe_result_json"),
  safe_error: text("safe_error"),
  created_at: integer("created_at").notNull(),
  updated_at: integer("updated_at").notNull(),
});

/** `migrations/0006_agent_loop.sql` — one billed model step. */
export const agentModelCalls = sqliteTable("agent_model_calls", {
  id: text("id").primaryKey(),
  run_id: text("run_id").notNull(),
  generation_id: text("generation_id").notNull(),
  agent_turn_id: text("agent_turn_id").notNull(),
  attempt: integer("attempt").notNull(),
  step_index: integer("step_index").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  provider_request_id: text("provider_request_id"),
  gateway_log_id: text("gateway_log_id"),
  input_tokens: integer("input_tokens").notNull(),
  no_cache_tokens: integer("no_cache_tokens").notNull(),
  cache_read_tokens: integer("cache_read_tokens").notNull(),
  cache_write_tokens: integer("cache_write_tokens").notNull(),
  output_tokens: integer("output_tokens").notNull(),
  reasoning_tokens: integer("reasoning_tokens").notNull(),
  total_tokens: integer("total_tokens").notNull(),
  cost_nano_usd: integer("cost_nano_usd").notNull(),
  latency_ms: integer("latency_ms").notNull(),
  finish_reason: text("finish_reason"),
  raw_finish_reason: text("raw_finish_reason"),
  error_code: text("error_code"),
  created_at: integer("created_at").notNull(),
});

/** `migrations/0006_agent_loop.sql` — semantic memory work waiting for Zep. */
export const agentMemoryOutbox = sqliteTable("agent_memory_outbox", {
  id: text("id").primaryKey(),
  run_id: text("run_id").notNull(),
  generation_id: text("generation_id").notNull(),
  graph_id: text("graph_id").notNull(),
  episode_json: text("episode_json").notNull(),
  source_json: text("source_json").notNull(),
  state: text("state")
    .$type<"pending" | "projecting" | "projected" | "retry" | "failed">()
    .notNull(),
  attempts: integer("attempts").notNull().default(0),
  claim_token: text("claim_token"),
  lease_expires_at: integer("lease_expires_at"),
  next_attempt_at: integer("next_attempt_at"),
  last_error: text("last_error"),
  episode_uuid: text("episode_uuid"),
  created_at: integer("created_at").notNull(),
  updated_at: integer("updated_at").notNull(),
  projected_at: integer("projected_at"),
});

/** `migrations/0006_agent_loop.sql` — exact provenance for an episode. */
export const memoryEpisodeSources = sqliteTable(
  "memory_episode_sources",
  {
    episode_uuid: text("episode_uuid").notNull(),
    source_index: integer("source_index").notNull(),
    source_kind: text("source_kind")
      .$type<"slack_message" | "run_turn" | "triage_decision" | "model_step">()
      .notNull(),
    message_event_id: text("message_event_id"),
    run_id: text("run_id"),
    turn_id: text("turn_id"),
    permalink: text("permalink"),
    created_at: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.episode_uuid, t.source_index] })]
);

/**
 * `migrations/0007_approvals.sql`, plus the nudge columns from
 * `migrations/0009_nudges.sql`.
 */
export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  run_id: text("run_id").notNull(),
  generation_id: text("generation_id").notNull(),
  kind: text("kind").$type<"slack_reply">().notNull(),
  draft: text("draft").notNull(),
  why: text("why").notNull(),
  channel_id: text("channel_id").notNull(),
  thread_ts: text("thread_ts").notNull(),
  shadow: integer("shadow").notNull().default(0),
  decision: text("decision")
    .$type<ApprovalDecision>()
    .notNull()
    .default("pending"),
  decided_by: text("decided_by"),
  decided_at: integer("decided_at"),
  edited_text: text("edited_text"),
  reject_reason: text("reject_reason"),
  delivery: text("delivery")
    .$type<ApprovalDelivery>()
    .notNull()
    .default("none"),
  delivery_error: text("delivery_error"),
  resolution_delivered_at: integer("resolution_delivered_at"),
  created_at: integer("created_at").notNull(),
  updated_at: integer("updated_at").notNull(),
  nudged_at: integer("nudged_at"),
  nudge_channel_id: text("nudge_channel_id"),
  nudge_ts: text("nudge_ts"),
});

/** `migrations/0008_identities.sql` — `token_ciphertext` is opaque here too. */
export const identities = sqliteTable(
  "identities",
  {
    email: text("email").notNull(),
    provider: text("provider").$type<Provider>().notNull(),
    external_id: text("external_id").notNull(),
    scopes: text("scopes").notNull(),
    token_ciphertext: text("token_ciphertext").notNull(),
    connected_at: integer("connected_at").notNull(),
    updated_at: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.email, t.provider] })]
);
