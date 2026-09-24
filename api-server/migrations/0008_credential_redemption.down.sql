-- Rollback credential redemption and reward system
DROP INDEX IF EXISTS idx_redemption_history_created_at;
DROP INDEX IF EXISTS idx_redemption_history_credential_id;
DROP TABLE IF EXISTS redemption_history;

DROP INDEX IF EXISTS idx_reward_escrow_held_until;
DROP INDEX IF EXISTS idx_reward_escrow_status;
DROP INDEX IF EXISTS idx_reward_escrow_credential_id;
DROP TABLE IF EXISTS reward_escrow;

DROP INDEX IF EXISTS idx_credential_rewards_expires_at;
DROP INDEX IF EXISTS idx_credential_rewards_status;
DROP INDEX IF EXISTS idx_credential_rewards_credential_id;
DROP TABLE IF EXISTS credential_rewards;

DROP TABLE IF EXISTS reward_tiers;
