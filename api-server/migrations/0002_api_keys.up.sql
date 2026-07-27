-- Persistent counterpart of api-server/src/services/apiKeyManager.ts's
-- in-memory/DurableLog-backed store. Shape mirrors the ApiKey /
-- ApiKeyUsageRecord interfaces in that file.
CREATE TABLE IF NOT EXISTS api_keys (
  id            TEXT PRIMARY KEY,
  key_hash      TEXT NOT NULL UNIQUE,
  issuer        TEXT NOT NULL,
  name          TEXT NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_issuer ON api_keys (issuer);

CREATE TABLE IF NOT EXISTS api_key_usage (
  id        BIGSERIAL PRIMARY KEY,
  key_id    TEXT NOT NULL REFERENCES api_keys (id) ON DELETE CASCADE,
  issuer    TEXT NOT NULL,
  endpoint  TEXT NOT NULL,
  used_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_key_usage_key_id ON api_key_usage (key_id);
