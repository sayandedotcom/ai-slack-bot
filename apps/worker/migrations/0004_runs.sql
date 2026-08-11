-- The run index. D1 is the index, NOT a session mirror: this table holds run
-- identity, status and a one-line summary so the dashboard can list runs
-- without waking every Durable Object. Turns and tool deltas live only in the
-- RunDO's private SQLite. See spec §5 and the Phase 08 plan.
--
-- Deliberately NO type/category column, same as triage_decisions.
CREATE TABLE runs (
  id         TEXT PRIMARY KEY,
  -- The origin key: slack:{channel_id}:{thread_ts} or chat:{uuid}. UNIQUE is
  -- what makes one Slack thread resolve to exactly one run. Quoted everywhere
  -- because an unquoted keyword-shaped identifier is an avoidable portability
  -- trap.
  "key"      TEXT NOT NULL UNIQUE,
  origin     TEXT NOT NULL CHECK (origin IN ('slack', 'chat')),
  channel_id TEXT,
  thread_ts  TEXT,
  status     TEXT NOT NULL CHECK (
    status IN ('live', 'awaiting_approval', 'idle', 'done', 'failed')
  ),
  shadow     INTEGER NOT NULL DEFAULT 0 CHECK (shadow IN (0, 1)),
  summary    TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- Row shape follows origin. A slack run without a thread could not be
  -- reopened by a later message; a chat run with one would imply a thread that
  -- does not exist.
  CHECK (
    (origin = 'slack' AND channel_id IS NOT NULL AND thread_ts IS NOT NULL)
    OR
    (origin = 'chat' AND channel_id IS NULL AND thread_ts IS NULL)
  )
);

-- The run list sorts by recency and filters by status.
CREATE INDEX idx_runs_status_updated ON runs (status, updated_at DESC);

-- findOwnedSlackRun's lookup: does this thread already have a run?
CREATE INDEX idx_runs_slack_thread ON runs (channel_id, thread_ts);
