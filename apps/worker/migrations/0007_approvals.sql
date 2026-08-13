-- One human decision on one proposed customer Slack reply. See
-- docs/superpowers/plans/phase-11-approval.md, "Persistence design", for the
-- full state-machine rationale; this file is that section's SQL, verbatim.
--
-- D1 is the system of record for approvals, and this table is the whole of
-- it — RunDO SQLite keeps a local `approval_state` mirror for the finalize
-- latch (schema v3, a later task), but that mirror is coordination state, not
-- a second authority on what a human decided.
CREATE TABLE approvals (
  id            TEXT PRIMARY KEY,              -- apr:{uuid}, minted DO-side
  run_id        TEXT NOT NULL REFERENCES runs(id),
  generation_id TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind = 'slack_reply'),
  draft         TEXT NOT NULL,
  why           TEXT NOT NULL,
  channel_id    TEXT NOT NULL,
  thread_ts     TEXT NOT NULL,
  shadow        INTEGER NOT NULL DEFAULT 0,
  decision      TEXT NOT NULL DEFAULT 'pending'
                CHECK (decision IN ('pending','approved','edited','rejected','withdrawn')),
  decided_by    TEXT,
  decided_at    INTEGER,
  edited_text   TEXT,
  reject_reason TEXT,
  delivery      TEXT NOT NULL DEFAULT 'none'
                CHECK (delivery IN ('none','sending','sent','blocked','suppressed','in_doubt')),
  delivery_error TEXT,
  resolution_delivered_at INTEGER,             -- when appendTurn(source:approval) committed
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Invariant 4/one open approval per run, enforced as a database constraint,
-- not application logic: a second INSERT for a run that already has one
-- unsettled row fails here, and `insertApproval` maps that failure to
-- `duplicate_open` rather than ever computing it itself.
--
-- "Unsettled" is `pending`, OR decided approved/edited whose delivery has not
-- yet reached a terminal state that frees the slot. Terminal-and-freeing is
-- deliberately `sent`, `blocked`, `suppressed` — NOT `in_doubt`: an in-doubt
-- delivery still holds the slot, because nobody yet knows whether it sent, and
-- a human has to reconcile it before this run can escalate again.
CREATE UNIQUE INDEX idx_approvals_one_open ON approvals(run_id)
  WHERE decision = 'pending'
     OR (decision IN ('approved','edited') AND delivery NOT IN ('sent','blocked','suppressed'));

-- The dashboard's open queue: `GET /api/approvals?state=open`.
CREATE INDEX idx_approvals_open ON approvals(decision, created_at)
  WHERE decision = 'pending';

-- The repair key for invariant 9 ("a click is never lost to a dead DO"): a
-- decided row whose resolution never reached the DO is findable here by the
-- existing one-minute `scheduled()` sweeper, which re-invokes `resolveApproval`
-- for whatever `listUndeliveredResolutions` returns.
CREATE INDEX idx_approvals_undelivered ON approvals(resolution_delivered_at)
  WHERE decision IN ('approved','edited','rejected') AND resolution_delivered_at IS NULL;
