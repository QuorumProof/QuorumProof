-- Persistent store for v2 BBS+ credentials (Issue #1957).
-- Replaces the in-memory Map in src/routes/v2/bbsCredentials.ts so that
-- credentials survive API server restarts and are shared across all instances.

CREATE TABLE IF NOT EXISTS bbs_credentials (
  id               TEXT PRIMARY KEY,
  stellar_address  TEXT NOT NULL,
  claim_type       TEXT NOT NULL,
  metadata_hash    TEXT NOT NULL,
  issued_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  issuer_key       TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  signature        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bbs_credentials_stellar_address
  ON bbs_credentials (stellar_address);

CREATE INDEX IF NOT EXISTS idx_bbs_credentials_issued_at
  ON bbs_credentials (issued_at DESC);
