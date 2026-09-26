-- Credential Tiering System (Issue #1602)
-- Support Bronze, Silver, and Gold tiers for credentials

CREATE TYPE credential_tier AS ENUM ('bronze', 'silver', 'gold');

CREATE TABLE credential_tiers (
  id SERIAL PRIMARY KEY,
  credential_id BIGINT NOT NULL,
  tier credential_tier NOT NULL DEFAULT 'bronze',
  tier_points BIGINT NOT NULL DEFAULT 0,
  tier_acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  tier_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(credential_id)
);

CREATE INDEX idx_credential_tiers_tier ON credential_tiers(tier);
CREATE INDEX idx_credential_tiers_tier_points ON credential_tiers(tier_points DESC);
CREATE INDEX idx_credential_tiers_tier_acquired_at ON credential_tiers(tier_acquired_at DESC);

-- Tier advancement log for audit trail
CREATE TABLE tier_advancement_log (
  id SERIAL PRIMARY KEY,
  credential_id BIGINT NOT NULL,
  from_tier credential_tier NOT NULL,
  to_tier credential_tier NOT NULL,
  reason VARCHAR(255),
  advanced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tier_advancement_credential_id ON tier_advancement_log(credential_id);
CREATE INDEX idx_tier_advancement_advanced_at ON tier_advancement_log(advanced_at DESC);

-- Tier requirements configuration
CREATE TABLE tier_requirements (
  tier credential_tier PRIMARY KEY,
  min_points BIGINT NOT NULL,
  min_attestations INTEGER NOT NULL,
  min_age_days INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Initialize default tier requirements
INSERT INTO tier_requirements (tier, min_points, min_attestations, min_age_days) VALUES
  ('bronze', 0, 1, 0),
  ('silver', 1000, 5, 30),
  ('gold', 5000, 20, 90);

-- Tier-based benefits configuration
CREATE TABLE tier_benefits (
  id SERIAL PRIMARY KEY,
  tier credential_tier NOT NULL,
  benefit_name VARCHAR(100) NOT NULL,
  benefit_value VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tier, benefit_name)
);

-- Initialize default tier benefits
INSERT INTO tier_benefits (tier, benefit_name, benefit_value) VALUES
  ('bronze', 'max_uses', '10'),
  ('bronze', 'priority_verification', 'false'),
  ('silver', 'max_uses', '50'),
  ('silver', 'priority_verification', 'true'),
  ('silver', 'reward_multiplier', '1.5'),
  ('gold', 'max_uses', 'unlimited'),
  ('gold', 'priority_verification', 'true'),
  ('gold', 'reward_multiplier', '3.0'),
  ('gold', 'vip_support', 'true');
