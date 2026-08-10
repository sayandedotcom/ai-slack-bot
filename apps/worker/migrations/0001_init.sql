-- Channel posting policy. Fail closed: a channel absent from this table is
-- never postable. See spec §4.4.
CREATE TABLE channels (
  channel_id    TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  customer_slug TEXT,
  mode          TEXT NOT NULL CHECK (mode IN ('observe', 'live', 'internal'))
);

-- Every envelope the queue consumer accepted, whether or not it was ingested.
-- Doubles as the dedupe key and the source of the "heard" counter. See spec §9.
CREATE TABLE events_seen (
  event_id    TEXT PRIMARY KEY,
  channel_id  TEXT,
  outcome     TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE INDEX idx_events_seen_received ON events_seen (received_at);

-- The system of record. Citations resolve through this table, never through
-- string-formatted URLs. See spec §4.2 and decision D4.
CREATE TABLE messages (
  event_id      TEXT PRIMARY KEY,
  channel_id    TEXT NOT NULL,
  ts            TEXT NOT NULL,
  thread_ts     TEXT,
  user_id       TEXT,
  text          TEXT NOT NULL,
  subtype       TEXT,
  permalink     TEXT,
  customer_slug TEXT,
  received_at   INTEGER NOT NULL
);

CREATE INDEX idx_messages_channel_ts ON messages (channel_id, ts);
CREATE INDEX idx_messages_thread ON messages (channel_id, thread_ts);
CREATE INDEX idx_messages_received ON messages (received_at);
