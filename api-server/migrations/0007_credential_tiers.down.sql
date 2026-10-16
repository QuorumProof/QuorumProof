-- Rollback Credential Tiering System

DROP TABLE IF EXISTS tier_benefits;
DROP TABLE IF EXISTS tier_requirements;
DROP TABLE IF EXISTS tier_advancement_log;
DROP TABLE IF EXISTS credential_tiers;
DROP TYPE IF EXISTS credential_tier;
