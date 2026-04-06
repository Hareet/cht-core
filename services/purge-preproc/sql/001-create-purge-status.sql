-- Purge status table: stores per-document, per-role purge decisions.
-- Consumed by PowerSync Sync Streams via SQL JOIN to exclude purged docs from sync.
--
-- Design decisions:
--   - role_hash (not role name list) as key: matches existing purging-utils hashing,
--     keeps index compact, handles multi-role combinations as a single key.
--   - Composite primary key (doc_id, role_hash): one purge decision per doc per role set.
--   - purged boolean: explicit true/false allows distinguishing "evaluated, not purged"
--     from "never evaluated". Sync Streams can LEFT JOIN and treat NULL as "not purged".
--   - evaluated_at: enables incremental re-evaluation (skip docs evaluated after last change).
--   - seq: tracks the cht-sync sequence at evaluation time for incremental processing.

CREATE TABLE IF NOT EXISTS purge_status (
  doc_id      TEXT        NOT NULL,
  role_hash   TEXT        NOT NULL,
  purged      BOOLEAN     NOT NULL DEFAULT false,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  seq         TEXT,
  PRIMARY KEY (doc_id, role_hash)
);

-- Index for Sync Streams queries: "give me all purged doc_ids for this role_hash"
CREATE INDEX IF NOT EXISTS idx_purge_status_role_purged
  ON purge_status (role_hash)
  WHERE purged = true;

-- Index for incremental evaluation: "which docs were evaluated before a given time?"
CREATE INDEX IF NOT EXISTS idx_purge_status_evaluated_at
  ON purge_status (evaluated_at);

-- Lookup table mapping role_hash to the actual role arrays, for auditability.
CREATE TABLE IF NOT EXISTS purge_roles (
  role_hash   TEXT    PRIMARY KEY,
  roles       JSONB   NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tracks purge run metadata for operational monitoring.
CREATE TABLE IF NOT EXISTS purge_run_log (
  id              SERIAL      PRIMARY KEY,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  status          TEXT        NOT NULL DEFAULT 'running', -- running, completed, failed
  contacts_processed  INTEGER DEFAULT 0,
  docs_evaluated      INTEGER DEFAULT 0,
  docs_purged         INTEGER DEFAULT 0,
  docs_unpurged       INTEGER DEFAULT 0,
  skipped_contacts    JSONB,
  error               TEXT,
  seq_start           TEXT,
  seq_end             TEXT
);
