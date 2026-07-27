//! Scheduled contract upgrades (issue: "Upgrades require manual timing").
//!
//! Today `QuorumProofContract::upgrade` fires immediately once the admin
//! submits it, which forces upgrades to happen in a live transaction at
//! whatever moment the admin is available — there's no way to pre-announce a
//! maintenance window and let the upgrade land unattended at that time. This
//! module adds a single pending-upgrade slot: an admin schedules a target WASM
//! hash and an execution timestamp, and any caller (typically a cron-driven
//! off-chain relayer, since Soroban has no native scheduler) can trigger
//! `execute_scheduled_upgrade` once that time has passed. The relayer needs no
//! special privileges — the contract itself enforces the time gate and the
//! WASM-hash match, so triggering early or with the wrong hash is a no-op.
//!
//! Reads (`get_scheduled_upgrade`) are unauthenticated so monitoring and
//! holders can see an upgrade coming; only scheduling and cancellation are
//! admin-gated.

use soroban_sdk::{contracttype, BytesN, Env};

/// Storage keys for the scheduled-upgrade feature. A single slot: only one
/// upgrade may be pending at a time, matching how `upgrade` itself only ever
/// targets "the next" WASM hash.
#[contracttype]
#[derive(Clone)]
pub enum DataKeyUpgradeSchedule {
    Pending,
}

/// A pending scheduled upgrade.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScheduledUpgrade {
    pub new_wasm_hash: BytesN<32>,
    /// Unix timestamp (ledger time) at or after which the upgrade may execute.
    pub execution_time: u64,
    /// Ledger timestamp the schedule was created, for audit/notification purposes.
    pub scheduled_at: u64,
    /// Set true the first time a pre-upgrade notification has been emitted for
    /// this schedule, so `notify_if_imminent` only fires once per schedule.
    pub notified: bool,
}

/// How far ahead of `execution_time` a caller polling `notify_if_imminent`
/// should be told "this is imminent" — one hour, so operators / holders get at
/// least one warning cycle before downtime starts.
pub const NOTICE_WINDOW_SECONDS: u64 = 3_600;

/// Schedule an upgrade to `new_wasm_hash` at `execution_time`. Overwrites any
/// previously scheduled (not-yet-executed) upgrade — there is only ever one
/// pending slot, matching `upgrade`'s single-target semantics.
///
/// # Panics
/// - `new_wasm_hash` is all-zero (blank WASM guard, mirrors `validate_upgrade`).
/// - `execution_time` is not strictly in the future of the current ledger time.
pub fn schedule_upgrade(env: &Env, new_wasm_hash: BytesN<32>, execution_time: u64) -> ScheduledUpgrade {
    let zero = BytesN::<32>::from_array(env, &[0u8; 32]);
    assert!(new_wasm_hash != zero, "new_wasm_hash must not be blank");
    let now = env.ledger().timestamp();
    assert!(
        execution_time > now,
        "execution_time must be in the future"
    );

    let schedule = ScheduledUpgrade {
        new_wasm_hash,
        execution_time,
        scheduled_at: now,
        notified: false,
    };
    env.storage()
        .instance()
        .set(&DataKeyUpgradeSchedule::Pending, &schedule);
    schedule
}

/// Cancel the currently pending scheduled upgrade, if any. No-op if nothing is
/// scheduled.
pub fn cancel_scheduled_upgrade(env: &Env) {
    env.storage().instance().remove(&DataKeyUpgradeSchedule::Pending);
}

/// Read the currently pending scheduled upgrade, if any. Unauthenticated.
pub fn get_scheduled_upgrade(env: &Env) -> Option<ScheduledUpgrade> {
    env.storage().instance().get(&DataKeyUpgradeSchedule::Pending)
}

/// Attempt to execute the pending scheduled upgrade. Returns the WASM hash
/// that was applied, or `None` if there is nothing scheduled or the execution
/// time has not yet been reached (in which case storage is left untouched).
///
/// Callable by anyone: the admin already authorized the *target* at schedule
/// time, so no further authorization is needed to let time-gated execution
/// through — this is what allows an unattended relayer to trigger it.
pub fn execute_scheduled_upgrade(env: &Env) -> Option<BytesN<32>> {
    let schedule: ScheduledUpgrade = get_scheduled_upgrade(env)?;
    if env.ledger().timestamp() < schedule.execution_time {
        return None;
    }
    env.storage().instance().remove(&DataKeyUpgradeSchedule::Pending);
    env.deployer()
        .update_current_contract_wasm(schedule.new_wasm_hash.clone());
    Some(schedule.new_wasm_hash)
}

/// If a schedule exists, is not yet executed, and is within
/// `NOTICE_WINDOW_SECONDS` of `execution_time`, mark it notified and return
/// `true` (the caller should emit a pre-upgrade notification event). Returns
/// `false` (and leaves storage untouched) if there's nothing to notify about
/// or it was already notified.
pub fn notify_if_imminent(env: &Env) -> bool {
    let Some(mut schedule) = get_scheduled_upgrade(env) else {
        return false;
    };
    if schedule.notified {
        return false;
    }
    let now = env.ledger().timestamp();
    if schedule.execution_time.saturating_sub(now) > NOTICE_WINDOW_SECONDS {
        return false;
    }
    schedule.notified = true;
    env.storage()
        .instance()
        .set(&DataKeyUpgradeSchedule::Pending, &schedule);
    true
}
