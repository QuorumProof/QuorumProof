-- Undo migration 0003_recovery: drop OTP and recovery-request tables.
DROP TABLE IF EXISTS recovery_otps;
DROP TABLE IF EXISTS recovery_requests;
