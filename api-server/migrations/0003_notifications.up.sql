CREATE TABLE IF NOT EXISTS notification_preferences (
  address               TEXT PRIMARY KEY,
  email                 TEXT,
  phone                 TEXT,
  channels              TEXT[] NOT NULL DEFAULT '{}',
  events                TEXT[] NOT NULL DEFAULT '{}',
  credential_type_filters INTEGER[] NOT NULL DEFAULT '{}',
  enabled               BOOLEAN NOT NULL DEFAULT true,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_history (
  id                    BIGSERIAL PRIMARY KEY,
  address               TEXT NOT NULL,
  event                 TEXT NOT NULL,
  channel               TEXT NOT NULL,
  credential_id         INTEGER NOT NULL,
  batched_credential_ids INTEGER[],
  issuer                TEXT,
  message               TEXT NOT NULL,
  sent_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  success               BOOLEAN NOT NULL DEFAULT false,
  error                 TEXT
);

CREATE INDEX IF NOT EXISTS idx_notification_history_address ON notification_history (address);
