-- Persistent store for verification-service registry and attestations (Issue #1959 / #1413).
-- Replaces the in-memory Map / array in src/routes/verification.ts so that
-- registrations survive API server restarts and are shared across all instances.

CREATE TABLE IF NOT EXISTS verification_services (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  webhook_url     TEXT NOT NULL DEFAULT '',
  service_type    TEXT NOT NULL,
  registered_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_verification_services_service_type
  ON verification_services (service_type);

CREATE TABLE IF NOT EXISTS third_party_attestations (
  id              BIGSERIAL PRIMARY KEY,
  service_id      TEXT NOT NULL REFERENCES verification_services (id) ON DELETE CASCADE,
  credential_id   INTEGER NOT NULL,
  result          TEXT NOT NULL CHECK (result IN ('pass', 'fail', 'pending')),
  notes           TEXT,
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attestations_service_id
  ON third_party_attestations (service_id);

CREATE INDEX IF NOT EXISTS idx_attestations_credential_id
  ON third_party_attestations (credential_id);
