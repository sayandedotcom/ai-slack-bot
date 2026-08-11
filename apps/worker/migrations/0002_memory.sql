-- Maps Zep episode UUIDs back to the D1 message that produced them. This is
-- what makes citations exact: fact -> episode -> event_id -> stored permalink,
-- never a formatted URL. See decision D4.
CREATE TABLE zep_episodes (
  episode_uuid TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL,
  graph_id     TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_zep_episodes_event ON zep_episodes (event_id);
