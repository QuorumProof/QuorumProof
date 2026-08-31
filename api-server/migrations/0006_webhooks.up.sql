CREATE TABLE IF NOT EXISTS webhook_registrations (
  id          TEXT PRIMARY KEY,
  url         TEXT NOT NULL,
  events      TEXT[] NOT NULL DEFAULT '{}',
  secret      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id               TEXT PRIMARY KEY,
  webhook_id       TEXT NOT NULL REFERENCES webhook_registrations (id) ON DELETE CASCADE,
  credential_id    INTEGER NOT NULL,
  event            TEXT NOT NULL,
  payload          JSONB NOT NULL,
  order_key        TEXT NOT NULL,
  sequence         INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_attempt_at  TIMESTAMPTZ,
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_id ON webhook_deliveries (webhook_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status ON webhook_deliveries (status);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_order_key ON webhook_deliveries (order_key, sequence);
