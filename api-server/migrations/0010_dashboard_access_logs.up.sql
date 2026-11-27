-- Durable credential access history for the holder dashboard
-- Issue #1960

CREATE TABLE IF NOT EXISTS dashboard_access_logs (
  id BIGSERIAL PRIMARY KEY,
  credential_id VARCHAR(255) NOT NULL,
  accessed_by VARCHAR(255) NOT NULL,
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0)
);

CREATE INDEX IF NOT EXISTS idx_dashboard_access_logs_credential_id
  ON dashboard_access_logs (credential_id);
CREATE INDEX IF NOT EXISTS idx_dashboard_access_logs_accessed_at
  ON dashboard_access_logs (accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_dashboard_access_logs_credential_accessed_at
  ON dashboard_access_logs (credential_id, accessed_at DESC);
