-- Persistent store for wallet-recovery requests and OTPs (Issue #1429).
-- Replaces the in-memory Map/array in src/routes/recovery.ts so that
-- in-flight recovery sessions survive API server restarts and work correctly
-- across multiple API server instances.

CREATE TABLE IF NOT EXISTS recovery_requests (
  id               TEXT PRIMARY KEY,
  credential_id    TEXT NOT NULL,
  lost_wallet      TEXT NOT NULL,
  new_wallet       TEXT NOT NULL,
  contact_type     TEXT NOT NULL CHECK (contact_type IN ('email', 'phone')),
  contact_value    TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending_verification'
                     CHECK (status IN (
                       'pending_verification',
                       'verified',
                       'pending_approval',
                       'approved',
                       'rejected',
                       'executed'
                     )),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at      TIMESTAMPTZ,
  resolved_at      TIMESTAMPTZ,
  resolved_by      TEXT,
  rejection_reason TEXT,
  attestors        TEXT[] NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_recovery_requests_status
  ON recovery_requests (status);

CREATE INDEX IF NOT EXISTS idx_recovery_requests_created_at
  ON recovery_requests (created_at);

-- OTP codes are short-lived (10 minutes). expires_at is used as the TTL
-- filter in queries; a periodic cleanup job (or ON CONFLICT reuse) keeps
-- the table small. Storing attempts here allows rate-limiting across
-- server restarts and instances.
CREATE TABLE IF NOT EXISTS recovery_otps (
  request_id  TEXT PRIMARY KEY REFERENCES recovery_requests (id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_recovery_otps_expires_at
  ON recovery_otps (expires_at);
