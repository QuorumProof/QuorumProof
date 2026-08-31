//! Issue #872 — Time-Locked Credential Approval
//!
//! Attestations are currently effective the instant they are recorded.  This
//! module adds an optional per-credential time-lock: the issuer (or admin) can
//! set a `release_at` Unix timestamp on a credential, and until that timestamp
//! has passed, `is_attested` treats the attestation as pending rather than
//! active.  This gives institutions a detection window — typically 24–72 hours
//! — to spot stolen or fraudulently obtained credentials and revoke them before
//! any relying party can see them as fully verified.
//!
//! ## Storage
//!
//! `DataKeyTimeLock::TimeLock(credential_id)` → [`AttestationTimeLock`]
//!
//! ## Contract surface (added to `QuorumProofContract`)
//!
//! ```text
//! set_attestation_time_lock(admin, credential_id, release_at)
//! get_attestation_time_lock(credential_id) -> Option<AttestationTimeLock>
//! is_attestation_time_locked(credential_id) -> bool
//! clear_attestation_time_lock(admin, credential_id)
//! ```
//!
//! ## Effect on `is_attested`
//!
//! The main `is_attested` function checks `is_attestation_time_locked` before
//! evaluating quorum weight: if the lock is still active it returns `false`
//! regardless of how many attestors have signed.
//!
//! ## Interaction with `attestation_veto` (Issue #910, #1395)
//!
//! This module and `attestation_veto`'s `VetoTimeLock` are independent and
//! do not reference each other's state:
//!
//! - Setting or clearing an `AttestationTimeLock` here never checks
//!   `attestation_veto::get_credential_veto_requests` — a credential can
//!   have its attestation time-lock set (or extended) while a veto is
//!   already pending against it, with no interaction between the two
//!   schedules.
//! - `is_time_locked` only ever consults this module's own storage; it has
//!   no awareness of whether the credential is also under an active veto
//!   dispute. A credential can therefore simultaneously be "time-locked"
//!   (not yet attested) and "vetoed" (attestation disputed) at once — those
//!   are orthogonal facts a caller must check separately.
//!
//! This is intentional: this time-lock is a fixed detection window for
//! *newly recorded* attestations, whereas a veto is an authority-initiated
//! dispute that can apply regardless of whether that window has elapsed.
//! See `integration_nested_slices.rs` for tests covering both mechanisms
//! active on the same credential simultaneously.

use soroban_sdk::{contracttype, Env};

/// Storage keys for the time-lock feature.
#[contracttype]
#[derive(Clone)]
pub enum DataKeyTimeLock {
    /// Per-credential time-lock record (credential_id → AttestationTimeLock).
    TimeLock(u64),
}

/// A pending time-lock on a credential's attestation becoming effective.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttestationTimeLock {
    /// Unix timestamp (ledger time, seconds) at or after which the attestation
    /// may be considered active.  Callers should treat the attestation as
    /// pending while `ledger_timestamp < release_at`.
    pub release_at: u64,
    /// Ledger timestamp when the lock was set, for audit purposes.
    pub locked_at: u64,
    /// Human-readable reason supplied by the issuer/admin (optional, max 128 bytes).
    pub reason: soroban_sdk::Bytes,
}

/// Set (or overwrite) a time-lock on `credential_id`.
///
/// # Panics
/// - `release_at` is not strictly in the future of the current ledger time.
/// - `reason` exceeds 128 bytes.
pub fn set_time_lock(
    env: &Env,
    credential_id: u64,
    release_at: u64,
    reason: soroban_sdk::Bytes,
) -> AttestationTimeLock {
    let now = env.ledger().timestamp();
    assert!(
        release_at > now,
        "release_at must be strictly in the future"
    );
    assert!(reason.len() <= 128, "reason must be at most 128 bytes");

    let lock = AttestationTimeLock {
        release_at,
        locked_at: now,
        reason,
    };
    env.storage()
        .instance()
        .set(&DataKeyTimeLock::TimeLock(credential_id), &lock);
    lock
}

/// Read the current time-lock for `credential_id`, if any.
pub fn get_time_lock(env: &Env, credential_id: u64) -> Option<AttestationTimeLock> {
    env.storage()
        .instance()
        .get(&DataKeyTimeLock::TimeLock(credential_id))
}

/// Returns `true` if a time-lock exists AND has not yet expired.
///
/// An expired lock (i.e. `ledger_timestamp >= release_at`) is treated as
/// absent — the attestation is free to be considered active.
pub fn is_time_locked(env: &Env, credential_id: u64) -> bool {
    match get_time_lock(env, credential_id) {
        Some(lock) => env.ledger().timestamp() < lock.release_at,
        None => false,
    }
}

/// Remove the time-lock unconditionally.  No-op if none is set.
pub fn clear_time_lock(env: &Env, credential_id: u64) {
    env.storage()
        .instance()
        .remove(&DataKeyTimeLock::TimeLock(credential_id));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Ledger, Bytes, Env};

    fn env_at(ts: u64) -> (Env, soroban_sdk::Address) {
        let env = Env::default();
        env.ledger().with_mut(|l| l.timestamp = ts);
        let contract_id = env.register_contract(None, crate::QuorumProofContract);
        (env, contract_id)
    }

    #[test]
    fn set_and_get_time_lock_round_trips() {
        let (env, contract_id) = env_at(1_000);
        env.as_contract(&contract_id, || {
            let reason = Bytes::from_slice(&env, b"fraud detection window");
            let lock = set_time_lock(&env, 42, 2_000, reason.clone());
            assert_eq!(lock.release_at, 2_000);
            assert_eq!(lock.locked_at, 1_000);
            assert_eq!(lock.reason, reason);

            let stored = get_time_lock(&env, 42).expect("lock should be stored");
            assert_eq!(stored.release_at, 2_000);
        });
    }

    #[test]
    #[should_panic(expected = "release_at must be strictly in the future")]
    fn set_time_lock_in_past_panics() {
        let (env, contract_id) = env_at(5_000);
        env.as_contract(&contract_id, || {
            let reason = Bytes::from_slice(&env, b"");
            set_time_lock(&env, 1, 4_999, reason);
        });
    }

    #[test]
    #[should_panic(expected = "release_at must be strictly in the future")]
    fn set_time_lock_at_current_time_panics() {
        let (env, contract_id) = env_at(5_000);
        env.as_contract(&contract_id, || {
            let reason = Bytes::from_slice(&env, b"");
            set_time_lock(&env, 1, 5_000, reason); // not strictly in the future
        });
    }

    #[test]
    #[should_panic(expected = "reason must be at most 128 bytes")]
    fn set_time_lock_reason_too_long_panics() {
        let (env, contract_id) = env_at(1_000);
        env.as_contract(&contract_id, || {
            let reason = Bytes::from_slice(&env, &[b'x'; 129]);
            set_time_lock(&env, 1, 2_000, reason);
        });
    }

    #[test]
    fn is_time_locked_true_before_release() {
        let (env, contract_id) = env_at(1_000);
        env.as_contract(&contract_id, || {
            let reason = Bytes::from_slice(&env, b"");
            set_time_lock(&env, 7, 3_000, reason);
            assert!(is_time_locked(&env, 7));
        });
    }

    #[test]
    fn is_time_locked_false_after_release() {
        // Set the lock at t=1000 with release_at=2000, then advance ledger to
        // t=2000 and verify the lock is no longer active.
        let (env, contract_id) = env_at(1_000);
        env.as_contract(&contract_id, || {
            let reason = Bytes::from_slice(&env, b"");
            set_time_lock(&env, 8, 2_000, reason);

            // Advance time past release_at
            env.ledger().with_mut(|l| l.timestamp = 2_000);
            assert!(!is_time_locked(&env, 8));
        });
    }

    #[test]
    fn is_time_locked_false_when_no_lock_set() {
        let (env, contract_id) = env_at(1_000);
        env.as_contract(&contract_id, || {
            assert!(!is_time_locked(&env, 99));
        });
    }

    #[test]
    fn clear_time_lock_removes_lock() {
        let (env, contract_id) = env_at(1_000);
        env.as_contract(&contract_id, || {
            let reason = Bytes::from_slice(&env, b"test");
            set_time_lock(&env, 5, 5_000, reason);
            assert!(is_time_locked(&env, 5));

            clear_time_lock(&env, 5);
            assert!(!is_time_locked(&env, 5));
            assert!(get_time_lock(&env, 5).is_none());
        });
    }

    #[test]
    fn clear_time_lock_noop_when_not_set() {
        let (env, contract_id) = env_at(1_000);
        env.as_contract(&contract_id, || {
            // Must not panic
            clear_time_lock(&env, 999);
        });
    }

    #[test]
    fn overwrite_existing_time_lock() {
        let (env, contract_id) = env_at(1_000);
        env.as_contract(&contract_id, || {
            let r1 = Bytes::from_slice(&env, b"first");
            set_time_lock(&env, 3, 2_000, r1);

            let r2 = Bytes::from_slice(&env, b"second");
            set_time_lock(&env, 3, 4_000, r2.clone());

            let stored = get_time_lock(&env, 3).unwrap();
            assert_eq!(stored.release_at, 4_000);
            assert_eq!(stored.reason, r2);
        });
    }
}
