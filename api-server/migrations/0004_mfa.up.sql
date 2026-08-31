CREATE TABLE IF NOT EXISTS mfa_enrollments (
  user_id         TEXT PRIMARY KEY,
  secret_enc      TEXT NOT NULL,
  secret_iv       TEXT NOT NULL,
  secret_tag      TEXT NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT false,
  enabled_at      TIMESTAMPTZ,
  backup_codes    TEXT[] NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
