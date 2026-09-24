-- Rollback credential tiering support
DROP TRIGGER IF EXISTS credential_tiers_timestamp_trigger ON credential_tiers;
DROP FUNCTION IF EXISTS update_credential_tiers_timestamp();

DROP TABLE IF EXISTS tier_progression_rules;
DROP INDEX IF EXISTS idx_credential_tiers_reputation_score;
DROP INDEX IF EXISTS idx_credential_tiers_tier;
DROP INDEX IF EXISTS idx_credential_tiers_credential_id;
DROP TABLE IF EXISTS credential_tiers;
