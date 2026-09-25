-- Add credential tiering support
CREATE TABLE IF NOT EXISTS credential_tiers (
  id                TEXT PRIMARY KEY,
  credential_id     INTEGER NOT NULL UNIQUE,
  tier              TEXT NOT NULL CHECK (tier IN ('bronze', 'silver', 'gold')),
  reputation_score  INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  promoted_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_credential_tiers_credential_id ON credential_tiers (credential_id);
CREATE INDEX IF NOT EXISTS idx_credential_tiers_tier ON credential_tiers (tier);
CREATE INDEX IF NOT EXISTS idx_credential_tiers_reputation_score ON credential_tiers (reputation_score DESC);

-- Create trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_credential_tiers_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER credential_tiers_timestamp_trigger
  BEFORE UPDATE ON credential_tiers
  FOR EACH ROW
  EXECUTE PROCEDURE update_credential_tiers_timestamp();

-- Tier progression thresholds table
CREATE TABLE IF NOT EXISTS tier_progression_rules (
  id                      TEXT PRIMARY KEY,
  from_tier               TEXT NOT NULL,
  to_tier                 TEXT NOT NULL,
  min_reputation_score    INTEGER NOT NULL,
  min_age_days            INTEGER NOT NULL,
  min_validations         INTEGER NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(from_tier, to_tier)
);

INSERT INTO tier_progression_rules (id, from_tier, to_tier, min_reputation_score, min_age_days, min_validations)
VALUES
  ('rule_bronze_to_silver', 'bronze', 'silver', 50, 7, 5),
  ('rule_silver_to_gold', 'silver', 'gold', 150, 30, 15)
ON CONFLICT DO NOTHING;
