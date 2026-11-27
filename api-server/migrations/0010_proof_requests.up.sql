-- Persistent store for v2 proof requests (Issue #1958).
-- Replaces the in-memory Map in src/routes/v2/proofRequests.ts so that
-- proof requests survive API server restarts and are shared across all instances.

CREATE TABLE IF NOT EXISTS proof_requests (
  id             TEXT PRIMARY KEY,
  credential_id  INTEGER NOT NULL,
  claim_type     TEXT NOT NULL,
  requester      TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'fulfilled', 'expired', 'cancelled')),
  proof          TEXT
);

CREATE INDEX IF NOT EXISTS idx_proof_requests_status
  ON proof_requests (status);

CREATE INDEX IF NOT EXISTS idx_proof_requests_created_at
  ON proof_requests (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_proof_requests_requester
  ON proof_requests (requester);
