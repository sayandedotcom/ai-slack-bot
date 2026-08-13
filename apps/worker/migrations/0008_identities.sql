-- One connected provider account per (roster email, provider). Phase 12 gives
-- the hardcoded roster in `src/access/roster.ts` real credentials: a
-- fire-fighter connects Slack and GitHub once, and every later action taken on
-- their behalf reads the sealed token from here.
--
-- `token_ciphertext` is exactly that — ciphertext. Nothing in this schema, and
-- nothing in `src/db/identities.ts`, ever looks inside it; sealing and opening
-- live in the crypto module, so this table (and any dump of it) is opaque.
--
-- The roster, not this table, is the list of people. A row here only means
-- "this person has connected this provider", which is why the connect-status
-- read starts from the roster and merely decorates it with what D1 knows.
CREATE TABLE identities (
  email            TEXT    NOT NULL,
  provider         TEXT    NOT NULL CHECK (provider IN ('slack','github')),
  external_id      TEXT    NOT NULL,
  scopes           TEXT    NOT NULL,
  token_ciphertext TEXT    NOT NULL,
  connected_at     INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (email, provider)
);
