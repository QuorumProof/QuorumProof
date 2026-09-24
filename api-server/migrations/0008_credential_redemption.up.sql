-- Add credential redemption and reward system
CREATE TABLE IF NOT EXISTS reward_tiers (
  id                TEXT PRIMARY KEY,
  credential_tier   TEXT NOT NULL UNIQUE CHECK (credential_tier IN ('bronze', 'silver', 'gold')),
  reward_amount     DECIMAL NOT NULL CHECK (reward_amount > 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credential_rewards (
  id                TEXT PRIMARY KEY,
  credential_id     INTEGER NOT NULL,
  tier              TEXT NOT NULL CHECK (tier IN ('bronze', 'silver', 'gold')),
  amount            DECIMAL NOT NULL CHECK (amount > 0),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'expired')),
  earned_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '90 days',
  claimed_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(credential_id, id)
);

CREATE INDEX IF NOT EXISTS idx_credential_rewards_credential_id ON credential_rewards (credential_id);
CREATE INDEX IF NOT EXISTS idx_credential_rewards_status ON credential_rewards (status);
CREATE INDEX IF NOT EXISTS idx_credential_rewards_expires_at ON credential_rewards (expires_at);

-- Reward escrow table to hold claimed rewards pending settlement
CREATE TABLE IF NOT EXISTS reward_escrow (
  id                TEXT PRIMARY KEY,
  credential_id     INTEGER NOT NULL,
  reward_id         TEXT NOT NULL REFERENCES credential_rewards (id) ON DELETE CASCADE,
  amount            DECIMAL NOT NULL CHECK (amount > 0),
  status            TEXT NOT NULL DEFAULT 'escrowed' CHECK (status IN ('escrowed', 'settled', 'refunded')),
  held_until        TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '7 days',
  settled_at        TIMESTAMPTZ,
  settlement_hash   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reward_escrow_credential_id ON reward_escrow (credential_id);
CREATE INDEX IF NOT EXISTS idx_reward_escrow_status ON reward_escrow (status);
CREATE INDEX IF NOT EXISTS idx_reward_escrow_held_until ON reward_escrow (held_until);

-- Redemption history table
CREATE TABLE IF NOT EXISTS redemption_history (
  id                TEXT PRIMARY KEY,
  credential_id     INTEGER NOT NULL,
  reward_id         TEXT NOT NULL,
  action            TEXT NOT NULL CHECK (action IN ('earned', 'claimed', 'settled', 'expired', 'refunded')),
  amount            DECIMAL NOT NULL,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_redemption_history_credential_id ON redemption_history (credential_id);
CREATE INDEX IF NOT EXISTS idx_redemption_history_created_at ON redemption_history (created_at DESC);

-- Insert default reward tiers
INSERT INTO reward_tiers (id, credential_tier, reward_amount)
VALUES
  ('tier_bronze', 'bronze', 10),
  ('tier_silver', 'silver', 25),
  ('tier_gold', 'gold', 50)
ON CONFLICT DO NOTHING;
