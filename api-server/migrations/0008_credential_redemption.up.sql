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
