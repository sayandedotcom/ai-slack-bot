ALTER TABLE approvals ADD COLUMN nudged_at INTEGER;
ALTER TABLE approvals ADD COLUMN nudge_channel_id TEXT;
ALTER TABLE approvals ADD COLUMN nudge_ts TEXT;
CREATE INDEX idx_approvals_unnudged ON approvals(created_at)
  WHERE decision = 'pending' AND nudged_at IS NULL;
