CREATE TABLE IF NOT EXISTS attestor_availability (
  attestor_id TEXT PRIMARY KEY,
  record      JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
