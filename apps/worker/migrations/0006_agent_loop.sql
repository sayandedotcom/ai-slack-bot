-- Agent loop telemetry and memory projection.
--
-- D1 is NOT the loop's lock. The thread-scoped RunDO's private SQLite is the
-- only authority on whether a provider stream is running; replicating that here
-- would give two stores an opinion and let the wrong one win. What lives here is
-- what the dashboard and the README need to query ACROSS runs without waking a
-- single Durable Object: what each model step cost, and what still needs to
-- reach semantic memory.
--
-- Nothing in this file stores a prompt, a completion, a reasoning block, a tool
-- body or a secret. Telemetry answers "what did this cost and why did it stop",
-- never "what was said" (invariants 18 and 39).

-- One billed model step. The RunDO records it locally first and projects it
-- here; a D1 outage therefore delays a dashboard number, it never causes a
-- second billed provider request (invariant 32).
CREATE TABLE agent_model_calls (
  -- usage:{generation_id}:{attempt}:{step_index}, computed by the RunDO. A
  -- provider request id is metadata here, never an idempotency key: it changes
  -- on a retry of the same logical step.
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL,
  generation_id       TEXT NOT NULL,
  -- Also the Code Mode effect scope, so a billed step can be lined up with the
  -- external effects the same turn reserved in codemode_effects.
  agent_turn_id       TEXT NOT NULL,
  attempt             INTEGER NOT NULL CHECK (attempt >= 0),
  step_index          INTEGER NOT NULL CHECK (step_index >= 0),
  provider            TEXT NOT NULL,
  model               TEXT NOT NULL,
  provider_request_id TEXT,
  gateway_log_id      TEXT,
  -- Every token class Fable cost needs, kept separate because they are priced
  -- differently: a cache read is not a fresh input token, and summing them into
  -- one column would make the bill unreconstructable.
  input_tokens        INTEGER NOT NULL CHECK (input_tokens >= 0),
  no_cache_tokens     INTEGER NOT NULL CHECK (no_cache_tokens >= 0),
  cache_read_tokens   INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
  cache_write_tokens  INTEGER NOT NULL CHECK (cache_write_tokens >= 0),
  output_tokens       INTEGER NOT NULL CHECK (output_tokens >= 0),
  reasoning_tokens    INTEGER NOT NULL CHECK (reasoning_tokens >= 0),
  total_tokens        INTEGER NOT NULL CHECK (total_tokens >= 0),
  -- Nano-USD, never floating dollars: thousands of steps of float error do not
  -- add up to a number anyone can defend (invariant 29).
  cost_nano_usd       INTEGER NOT NULL CHECK (cost_nano_usd >= 0),
  latency_ms          INTEGER NOT NULL CHECK (latency_ms >= 0),
  -- Normalized reason plus whatever the provider actually said, because a
  -- refusal returned with HTTP 200 must stay visible (invariant 30).
  finish_reason       TEXT,
  raw_finish_reason   TEXT,
  error_code          TEXT,
  created_at          INTEGER NOT NULL,
  -- No ON DELETE clause on purpose: runs are not deleted, and an accidental
  -- cascade would erase billing history along with a row somebody removed by
  -- hand. Deleting a run with telemetry must fail loudly instead.
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

-- The idempotency key, as a constraint rather than a convention: replaying one
-- step cannot double its cost, while a different attempt is a distinct billed
-- call, because it was one.
CREATE UNIQUE INDEX idx_agent_model_step
  ON agent_model_calls (generation_id, attempt, step_index);

-- "What has this run spent, most recent first?"
CREATE INDEX idx_agent_model_run ON agent_model_calls (run_id, created_at DESC);

-- Semantic memory work waiting for Zep. An outbox rather than a direct write:
-- episode creation is not idempotent on the vendor side, so a row is claimed
-- with a token and a lease BEFORE the call and only marked projected after it,
-- which is what stops a redelivered alarm from writing the same episode twice.
CREATE TABLE agent_memory_outbox (
  -- memory:{run_id}:{generation_id}
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL,
  generation_id    TEXT NOT NULL,
  graph_id         TEXT NOT NULL,
  -- Bounded semantic summary and its source references. No deltas, no raw
  -- transcript, no trace payload, no reasoning (invariant 33).
  episode_json     TEXT NOT NULL,
  source_json      TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (
    state IN ('pending', 'projecting', 'projected', 'retry', 'failed')
  ),
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claim_token      TEXT,
  lease_expires_at INTEGER,
  next_attempt_at  INTEGER,
  last_error       TEXT,
  episode_uuid     TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  projected_at     INTEGER,
  -- One episode per generation, forever. This is the projection's idempotency
  -- key.
  UNIQUE (run_id, generation_id),
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

-- The delivery sweep: what is due, oldest first.
CREATE INDEX idx_agent_memory_outbox_due ON agent_memory_outbox (state, next_attempt_at);

-- The run index's monotonic projection cursor.
--
-- The RunDO holds a separate local revision counter and writes an immutable
-- bundled snapshot per lifecycle change. The projector applies a snapshot only
-- when this column is strictly lower, so an older status or summary write that
-- returns late cannot overwrite a newer one — including two updates that share
-- a millisecond, which a timestamp comparison would tie on and get wrong.
ALTER TABLE runs ADD COLUMN projection_seq INTEGER NOT NULL DEFAULT 0;

-- Exact provenance for a semantic memory episode: which Slack message, which
-- run and turn, which permalink. Zep answers "what do we know"; these rows are
-- how a claim is traced back to something a human can open and verify.
CREATE TABLE memory_episode_sources (
  episode_uuid     TEXT NOT NULL,
  source_index     INTEGER NOT NULL CHECK (source_index >= 0),
  source_kind      TEXT NOT NULL CHECK (
    source_kind IN ('slack_message', 'run_turn', 'triage_decision', 'model_step')
  ),
  message_event_id TEXT,
  run_id           TEXT,
  turn_id          TEXT,
  permalink        TEXT,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (episode_uuid, source_index)
);

-- "Where did this episode come from?" and its reverse, "what did this run feed
-- into memory?".
CREATE INDEX idx_memory_episode_sources_run ON memory_episode_sources (run_id, created_at);

-- One-shot repair of the Phase 08 default.
--
-- Phase 08 created every run row as 'live' because there was no loop and the
-- column had to say something. From Phase 10 on, 'live' means the agent has
-- work scheduled, and a run only becomes live inside the input transaction that
-- schedules it. Without this repair, deploying Phase 10 would leave every
-- historical run advertising a loop that does not exist.
--
-- Safe as a bulk update precisely because no pre-Phase-10 model driver exists:
-- there is no running generation anywhere that this could contradict. Doing it
-- here rather than in each Durable Object's activation path also means every
-- historical row is repaired without waking a single RunDO — and waking them is
-- the one thing that must not happen, since a wake is what starts spending
-- money on the model.
--
-- 'awaiting_approval', 'done' and 'failed' are untouched: they were true.
UPDATE runs SET status = 'idle' WHERE status = 'live';
