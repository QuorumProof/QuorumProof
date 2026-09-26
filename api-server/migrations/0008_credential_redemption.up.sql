-- Credential Redemption System (Issue #1603)
-- Support credential redemption for rewards

CREATE TYPE redemption_status AS ENUM ('pending', 'approved', 'claimed', 'expired', 'cancelled');

CREATE TABLE credential_rewards (
  id SERIAL PRIMARY KEY,
  credential_id BIGINT NOT NULL,
  reward_points BIGINT NOT NULL DEFAULT 0,
  accumulated_value DECIMAL(18, 8) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(credential_id)
);

CREATE INDEX idx_credential_rewards_accumulated_value ON credential_rewards(accumulated_value DESC);

-- Reward escrow for pending redemptions
CREATE TABLE reward_escrow (
  id SERIAL PRIMARY KEY,
  credential_id BIGINT NOT NULL,
  amount DECIMAL(18, 8) NOT NULL,
  currency VARCHAR(20) NOT NULL DEFAULT 'USDC',
  escrow_status redemption_status NOT NULL DEFAULT 'pending',
  claimed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_reward_escrow_credential_id ON reward_escrow(credential_id);
CREATE INDEX idx_reward_escrow_status ON reward_escrow(escrow_status);
CREATE INDEX idx_reward_escrow_expires_at ON reward_escrow(expires_at);

-- Redemption requests
CREATE TABLE redemption_requests (
  id SERIAL PRIMARY KEY,
  credential_id BIGINT NOT NULL,
  reward_escrow_id INTEGER REFERENCES reward_escrow(id),
  amount DECIMAL(18, 8) NOT NULL,
  destination_address VARCHAR(255) NOT NULL,
  status redemption_status NOT NULL DEFAULT 'pending',
  reason VARCHAR(500),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_redemption_requests_credential_id ON redemption_requests(credential_id);
CREATE INDEX idx_redemption_requests_status ON redemption_requests(status);
CREATE INDEX idx_redemption_requests_submitted_at ON redemption_requests(submitted_at DESC);

-- Redemption accounting ledger
CREATE TABLE redemption_ledger (
  id SERIAL PRIMARY KEY,
  credential_id BIGINT NOT NULL,
  redemption_request_id INTEGER REFERENCES redemption_requests(id),
  debit DECIMAL(18, 8),
  credit DECIMAL(18, 8),
  balance DECIMAL(18, 8) NOT NULL,
  transaction_type VARCHAR(50),
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_redemption_ledger_credential_id ON redemption_ledger(credential_id);
CREATE INDEX idx_redemption_ledger_created_at ON redemption_ledger(created_at DESC);
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
