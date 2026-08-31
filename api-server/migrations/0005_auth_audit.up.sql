CREATE TABLE IF NOT EXISTS auth_audit_log (
  id           TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL,
  user_id      TEXT,
  ip_address   TEXT NOT NULL DEFAULT 'unknown',
  user_agent   TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL,
  metadata     JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_audit_user_id ON auth_audit_log (user_id);
CREATE INDEX IF NOT EXISTS idx_auth_audit_event_type ON auth_audit_log (event_type);
CREATE INDEX IF NOT EXISTS idx_auth_audit_ip ON auth_audit_log (ip_address);
CREATE INDEX IF NOT EXISTS idx_auth_audit_created_at ON auth_audit_log (created_at);
