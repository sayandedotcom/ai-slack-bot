-- One row per triage decision. Storing every decision (not just wakes) is what
-- makes the Phase 21 eval set possible and the `triaged` counter exact.
-- Deliberately NO type/category column — see the global constraint.
CREATE TABLE triage_decisions (
  event_id       TEXT PRIMARY KEY,
  wake           INTEGER NOT NULL CHECK (wake IN (0, 1)),
  why            TEXT NOT NULL,
  opening_prompt TEXT NOT NULL,
  model          TEXT NOT NULL,
  cost_usd       REAL NOT NULL,
  latency_ms     INTEGER NOT NULL,
  created_at     INTEGER NOT NULL
);

CREATE INDEX idx_triage_created ON triage_decisions (created_at);
