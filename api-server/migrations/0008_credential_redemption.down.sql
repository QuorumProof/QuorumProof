-- Rollback Credential Redemption System

DROP TABLE IF EXISTS redemption_ledger;
DROP TABLE IF EXISTS redemption_requests;
DROP TABLE IF EXISTS reward_escrow;
DROP TABLE IF EXISTS credential_rewards;
DROP TYPE IF EXISTS redemption_status;
