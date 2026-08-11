-- The effect ledger. Model-authored code can be retried after a transport
-- error, so every capability that changes the outside world reserves a row here
-- BEFORE the external call and records the outcome after it. D1 is the
-- coordination authority on purpose: an in-memory Set is empty after a Worker
-- restart, which is precisely the moment a retry arrives.
--
-- Read-only capabilities never touch this table. Their lifecycle goes to the
-- RunDO tool-event audit sink instead.
CREATE TABLE codemode_effects (
  -- SHA-256 hex over a canonical versioned envelope of
  -- (version, runId, turnId, namespace, method, normalizedArgs) -- never string
  -- concatenation, which collides the moment an argument contains the separator.
  effect_key       TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL,
  -- The model turn, not a per-provider random id. This is what makes a retry of
  -- one turn replay, while a LATER turn may deliberately repeat the same text.
  turn_id          TEXT NOT NULL,
  namespace        TEXT NOT NULL,
  method           TEXT NOT NULL,
  args_hash        TEXT NOT NULL,
  -- 'in_doubt' is a first-class state, not an error path. It is the gap between
  -- "we called upstream" and "we recorded what happened", and the only honest
  -- answer for a call that may or may not have sent a customer message.
  state            TEXT NOT NULL CHECK (
    state IN ('reserved', 'completed', 'failed', 'in_doubt')
  ),
  safe_result_json TEXT,
  safe_error       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  -- The semantic identity of the effect, independent of how the key is hashed.
  -- Keeping both this and the PRIMARY KEY means a hashing change cannot silently
  -- start permitting duplicates.
  UNIQUE (run_id, turn_id, namespace, method, args_hash)
);

-- Per-run effect history, newest first: what did this run actually do?
CREATE INDEX idx_codemode_effects_run ON codemode_effects (run_id, created_at DESC);

-- The reconciliation sweep: find everything stuck in 'reserved' or 'in_doubt'.
CREATE INDEX idx_codemode_effects_state ON codemode_effects (state, updated_at);
