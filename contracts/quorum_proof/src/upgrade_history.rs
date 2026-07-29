//! Issue #874 — Smart Contract Upgrade History
//!
//! Contract upgrades are currently fire-and-forget: the WASM hash is applied,
//! the scheduled-upgrade record is removed, and no permanent record is kept of
//! what was deployed, when, and why.  This module adds an append-only
//! `upgrade_history` log that governance tools and auditors can query.
//!
//! ## Storage
//!
//! `DataKeyUpgradeHistory::UpgradeHistory` → `Vec<UpgradeRecord>` (instance storage)
//! `DataKeyUpgradeHistory::UpgradeCount`   → `u32`
//!
//! ## Contract surface (added to `QuorumProofContract`)
//!
//! ```text
//! get_upgrade_history()              -> Vec<UpgradeRecord>
//! get_upgrade_history_count()        -> u32
//! ```
//!
//! History is appended automatically inside `upgrade()` and
//! `execute_scheduled_upgrade()` — callers do not need to do anything extra.
//!
//! ## Design notes
//!
//! * The log is capped at `MAX_HISTORY_ENTRIES` (64) to bound instance storage
//!   growth.  When the cap is reached the oldest entry is dropped (FIFO ring
//!   buffer).  Governance tooling should export entries off-chain before the
//!   buffer wraps if a full audit trail is needed.
//! * `changes` is a free-text `Bytes` field (max 256 bytes) the admin fills in
//!   at upgrade time.  It is optional — passing zero-length bytes is allowed.

use soroban_sdk::{contracttype, BytesN, Env, Vec};

/// Maximum number of upgrade records to keep in instance storage.
pub const MAX_HISTORY_ENTRIES: u32 = 64;

/// Storage keys for the upgrade history feature.
#[contracttype]
#[derive(Clone)]
pub enum DataKeyUpgradeHistory {
    /// The ordered list of upgrade records (oldest first).
    UpgradeHistory,
    /// Total number of upgrades ever recorded (monotonically increasing, not
    /// reset when old entries are pruned).
    UpgradeCount,
}

/// A single entry in the contract upgrade audit log.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpgradeRecord {
    /// Sequential upgrade number (1-based, never reset).
    pub version: u32,
    /// The new WASM hash that was applied.
    pub new_wasm_hash: BytesN<32>,
    /// Ledger timestamp when the upgrade was executed.
    pub upgraded_at: u64,
    /// Free-text description of changes in this version (max 256 bytes).
    pub changes: soroban_sdk::Bytes,
    /// Whether the upgrade was triggered via the scheduled-upgrade path
    /// (`true`) or via the immediate `upgrade()` call (`false`).
    pub was_scheduled: bool,
}

/// Append a new upgrade record to the history log.
///
/// If the log would exceed `MAX_HISTORY_ENTRIES`, the oldest entry is evicted
/// first (ring buffer).
///
/// # Panics
/// - `changes` exceeds 256 bytes.
pub fn record_upgrade(
    env: &Env,
    new_wasm_hash: BytesN<32>,
    changes: soroban_sdk::Bytes,
    was_scheduled: bool,
) -> UpgradeRecord {
    assert!(changes.len() <= 256, "changes must be at most 256 bytes");

    // Increment the lifetime counter.
    let count: u32 = env
        .storage()
        .instance()
        .get(&DataKeyUpgradeHistory::UpgradeCount)
        .unwrap_or(0u32);
    let new_count = count.saturating_add(1);
    env.storage()
        .instance()
        .set(&DataKeyUpgradeHistory::UpgradeCount, &new_count);

    let record = UpgradeRecord {
        version: new_count,
        new_wasm_hash,
        upgraded_at: env.ledger().timestamp(),
        changes,
        was_scheduled,
    };

    // Load current log, evict oldest if at cap, append new entry.
    let mut history: Vec<UpgradeRecord> = env
        .storage()
        .instance()
        .get(&DataKeyUpgradeHistory::UpgradeHistory)
        .unwrap_or_else(|| Vec::new(env));

    if history.len() >= MAX_HISTORY_ENTRIES {
        // Shift all entries left by one (drop index 0, the oldest).
        let mut trimmed: Vec<UpgradeRecord> = Vec::new(env);
        for i in 1..history.len() {
            trimmed.push_back(history.get(i).unwrap());
        }
        history = trimmed;
    }
    history.push_back(record.clone());

    env.storage()
        .instance()
        .set(&DataKeyUpgradeHistory::UpgradeHistory, &history);

    record
}

/// Return the full upgrade history log (oldest first).
pub fn get_upgrade_history(env: &Env) -> Vec<UpgradeRecord> {
    env.storage()
        .instance()
        .get(&DataKeyUpgradeHistory::UpgradeHistory)
        .unwrap_or_else(|| Vec::new(env))
}

/// Return the total number of upgrades ever recorded (not reset on eviction).
pub fn get_upgrade_count(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKeyUpgradeHistory::UpgradeCount)
        .unwrap_or(0u32)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Ledger, Bytes, BytesN, Env};

    fn env_at(ts: u64) -> Env {
        let env = Env::default();
        env.ledger().with_mut(|l| l.timestamp = ts);
        env
    }

    fn dummy_hash(env: &Env, byte: u8) -> BytesN<32> {
        let mut arr = [0u8; 32];
        arr[0] = byte;
        BytesN::from_array(env, &arr)
    }

    #[test]
    fn record_first_upgrade_sets_version_1() {
        let env = env_at(1_000);
        let hash = dummy_hash(&env, 1);
        let changes = Bytes::from_slice(&env, b"initial release");
        let rec = record_upgrade(&env, hash.clone(), changes.clone(), false);

        assert_eq!(rec.version, 1);
        assert_eq!(rec.new_wasm_hash, hash);
        assert_eq!(rec.upgraded_at, 1_000);
        assert_eq!(rec.changes, changes);
        assert!(!rec.was_scheduled);
    }

    #[test]
    fn multiple_upgrades_increment_version() {
        let env = env_at(1_000);
        for i in 1u8..=5 {
            let hash = dummy_hash(&env, i);
            let changes = Bytes::from_slice(&env, b"");
            let rec = record_upgrade(&env, hash, changes, false);
            assert_eq!(rec.version, i as u32);
        }
        assert_eq!(get_upgrade_count(&env), 5);
    }

    #[test]
    fn get_upgrade_history_returns_all_entries_oldest_first() {
        let env = env_at(1_000);
        record_upgrade(&env, dummy_hash(&env, 1), Bytes::from_slice(&env, b"v1"), false);
        record_upgrade(&env, dummy_hash(&env, 2), Bytes::from_slice(&env, b"v2"), true);

        let history = get_upgrade_history(&env);
        assert_eq!(history.len(), 2);
        assert_eq!(history.get(0).unwrap().version, 1);
        assert_eq!(history.get(1).unwrap().version, 2);
        assert!(history.get(1).unwrap().was_scheduled);
    }

    #[test]
    fn empty_changes_are_allowed() {
        let env = env_at(1_000);
        let rec = record_upgrade(&env, dummy_hash(&env, 1), Bytes::from_slice(&env, b""), false);
        assert_eq!(rec.changes.len(), 0);
    }

    #[test]
    #[should_panic(expected = "changes must be at most 256 bytes")]
    fn changes_too_long_panics() {
        let env = env_at(1_000);
        let changes = Bytes::from_slice(&env, &[b'x'; 257]);
        record_upgrade(&env, dummy_hash(&env, 1), changes, false);
    }

    #[test]
    fn history_capped_at_max_evicts_oldest() {
        let env = env_at(1_000);

        // Fill to max
        for i in 0..MAX_HISTORY_ENTRIES {
            let hash = dummy_hash(&env, (i % 256) as u8);
            record_upgrade(&env, hash, Bytes::from_slice(&env, b""), false);
        }

        // Add one more — should evict version 1
        let new_hash = dummy_hash(&env, 99);
        let rec = record_upgrade(&env, new_hash, Bytes::from_slice(&env, b"overflow"), false);

        let history = get_upgrade_history(&env);
        assert_eq!(history.len(), MAX_HISTORY_ENTRIES);

        // Oldest entry in ring buffer is now version 2
        assert_eq!(history.get(0).unwrap().version, 2);
        // Newest is the one we just inserted
        assert_eq!(history.get(MAX_HISTORY_ENTRIES - 1).unwrap().version, rec.version);

        // Lifetime counter keeps increasing past MAX_HISTORY_ENTRIES
        assert_eq!(get_upgrade_count(&env), MAX_HISTORY_ENTRIES + 1);
    }

    #[test]
    fn get_upgrade_history_empty_before_any_upgrade() {
        let env = env_at(1_000);
        assert_eq!(get_upgrade_history(&env).len(), 0);
        assert_eq!(get_upgrade_count(&env), 0);
    }
}
