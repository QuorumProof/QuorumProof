use soroban_sdk::{contracttype, Bytes, Env, String, Symbol, Vec};

/// State validation result
#[contracttype]
#[derive(Clone, Debug)]
pub struct ValidationResult {
    pub is_valid: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub checked_at: u64,
}

/// State consistency check
#[contracttype]
#[derive(Clone, Debug)]
pub struct StateCheckpoint {
    pub timestamp: u64,
    pub credential_count: u64,
    pub slice_count: u64,
    pub attestation_count: u64,
    pub hash: Bytes,
}

/// Issue #1947: bounded ring buffer of state-consistency alerts.
///
/// The alert log is stored as a fixed-capacity ring buffer rather than an
/// unbounded `Vec<String>`. `buffer` holds at most [`MAX_STATE_ALERTS`]
/// entries; once full, new alerts overwrite the oldest entry and `head` is
/// advanced. `count` tracks how many entries are live (it stops growing once
/// it reaches the cap). `get_state_alerts` reconstructs the chronological
/// (oldest-first) view, so the on-chain list is always bounded while a contract
/// event is emitted for every alert so off-chain monitoring is notified
/// immediately.
#[contracttype]
#[derive(Clone, Debug)]
pub struct StateAlertLog {
    pub buffer: Vec<String>,
    pub head: u32,
    pub count: u32,
}

/// Maximum number of alerts retained on-chain by the ring buffer.
pub const MAX_STATE_ALERTS: u32 = 50;

const STATE_VALIDATION_LOG_KEY: &str = "state_validation_log";
const STATE_CHECKPOINT_KEY: &str = "state_checkpoint";
const STATE_ALERTS_KEY: &str = "state_alerts";

/// Validate contract state consistency
pub fn validate_state(env: &Env) -> ValidationResult {
    let mut errors = Vec::new(env);
    let mut warnings = Vec::new(env);

    // Check 1: Verify admin is set
    if !env.storage().instance().has(&Symbol::new(env, "admin")) {
        errors.push_back(String::from_str(env, "Admin not initialized"));
    }

    // Check 2: Verify state version is valid
    let state_version: u32 = env.storage()
        .instance()
        .get(&Symbol::new(env, "state_version"))
        .unwrap_or(0);
    if state_version > 100 {
        warnings.push_back(String::from_str(env, "State version unusually high"));
    }

    // Check 3: Verify no negative counts
    let credential_count: u64 = env.storage()
        .persistent()
        .get(&Symbol::new(env, "credential_count"))
        .unwrap_or(0);
    if credential_count > 1_000_000_000 {
        warnings.push_back(String::from_str(env, "Credential count suspiciously high"));
    }

    let is_valid = errors.len() == 0;

    ValidationResult {
        is_valid,
        errors,
        warnings,
        checked_at: env.ledger().timestamp(),
    }
}

/// Create a checkpoint of current state for later comparison
pub fn create_checkpoint(env: &Env, credential_count: u64, slice_count: u64, attestation_count: u64) -> StateCheckpoint {
    let hash = compute_state_hash(env, credential_count, slice_count, attestation_count);

    StateCheckpoint {
        timestamp: env.ledger().timestamp(),
        credential_count,
        slice_count,
        attestation_count,
        hash,
    }
}

/// Store validation result in history
pub fn log_validation(env: &Env, result: &ValidationResult) {
    let key = Symbol::new(env, STATE_VALIDATION_LOG_KEY);
    let mut log: Vec<ValidationResult> = env.storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| Vec::new(env));

    log.push_back(result.clone());

    // Keep only last 100 validations to avoid storage bloat
    if log.len() > 100 {
        let mut trimmed = Vec::new(env);
        for i in (log.len() - 100)..log.len() {
            trimmed.push_back(log.get(i as u32).unwrap());
        }
        env.storage().persistent().set(&key, &trimmed);
    } else {
        env.storage().persistent().set(&key, &log);
    }
}

/// Get validation history
pub fn get_validation_history(env: &Env) -> Vec<ValidationResult> {
    let key = Symbol::new(env, STATE_VALIDATION_LOG_KEY);
    env.storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| Vec::new(env))
}

/// Store state checkpoint
pub fn store_checkpoint(env: &Env, checkpoint: &StateCheckpoint) {
    let key = Symbol::new(env, STATE_CHECKPOINT_KEY);
    env.storage().persistent().set(&key, checkpoint);
}

/// Get last checkpoint
pub fn get_last_checkpoint(env: &Env) -> Option<StateCheckpoint> {
    let key = Symbol::new(env, STATE_CHECKPOINT_KEY);
    env.storage().persistent().get(&key)
}

/// Detect state corruption by comparing with checkpoint
pub fn detect_corruption(env: &Env, current_credential_count: u64, current_slice_count: u64, current_attestation_count: u64) -> bool {
    if let Some(checkpoint) = get_last_checkpoint(env) {
        // Check for impossible state transitions
        if current_credential_count < checkpoint.credential_count {
            return true; // Credentials can't decrease
        }
        if current_slice_count < checkpoint.slice_count {
            return true; // Slices can't decrease
        }
        if current_attestation_count < checkpoint.attestation_count {
            return true; // Attestations can't decrease
        }

        // Check for unrealistic jumps (more than 10x increase in single block)
        if current_credential_count > checkpoint.credential_count * 10 {
            return true;
        }
        if current_slice_count > checkpoint.slice_count * 10 {
            return true;
        }
        if current_attestation_count > checkpoint.attestation_count * 10 {
            return true;
        }
    }

    false
}

/// Compute a simple hash of state for integrity checking
fn compute_state_hash(env: &Env, credential_count: u64, slice_count: u64, attestation_count: u64) -> Bytes {
    // Simple, deterministic digest of the state counters so checkpoints can be
    // compared for tamper detection. This is intentionally not a cryptographic
    // hash; it only needs to change when any counter changes.
    let arr: [u8; 3] = [
        credential_count as u8,
        slice_count as u8,
        attestation_count as u8,
    ];
    Bytes::from_slice(env, &arr)
}

/// Issue #1947: record a state-consistency alert in a bounded ring buffer and
/// emit a contract event.
///
/// Previously each alert was appended to an unbounded persistent `Vec<String>`
/// with a broken (never-executed) trim, so storage grew without limit and no
/// contract event was emitted. The list is now a fixed-capacity ring buffer
/// (at most [`MAX_STATE_ALERTS`] entries), and a `state_alert` contract event
/// is published for every alert so off-chain monitoring is notified without
/// having to poll on-chain storage.
pub fn alert_on_inconsistency(env: &Env, message: &str) {
    let key = Symbol::new(env, STATE_ALERTS_KEY);
    let mut log: StateAlertLog = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or(StateAlertLog {
            buffer: Vec::new(env),
            head: 0,
            count: 0,
        });

    let msg = String::from_str(env, message);

    if log.count < MAX_STATE_ALERTS {
        // Buffer not yet full: append and grow toward the cap.
        log.buffer.push_back(msg.clone());
        log.count += 1;
    } else {
        // Buffer full: overwrite the oldest entry and advance the head, which
        // is an O(1) ring-buffer rotation (no full-Vec rebuild).
        let head = log.head;
        log.buffer.set(head, msg.clone());
        log.head = (head + 1) % MAX_STATE_ALERTS;
    }

    env.storage().persistent().set(&key, &log);

    // Emit a contract event so external monitoring is notified immediately,
    // independent of the bounded on-chain ring buffer.
    let mut topics: Vec<Symbol> = Vec::new(env);
    topics.push_back(Symbol::new(env, "state_alert"));
    env.events().publish(topics, msg);
}

/// Get state alerts in chronological (oldest-first) order from the ring buffer.
pub fn get_state_alerts(env: &Env) -> Vec<String> {
    let key = Symbol::new(env, STATE_ALERTS_KEY);
    let log: StateAlertLog = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or(StateAlertLog {
            buffer: Vec::new(env),
            head: 0,
            count: 0,
        });

    let mut out = Vec::new(env);
    let cap = log.buffer.len();
    if cap == 0 {
        return out;
    }
    for i in 0..log.count {
        // Once full, `head` points at the oldest live entry and we wrap around
        // `cap` (= MAX_STATE_ALERTS). Before the buffer is full, `head` is 0
        // and `cap` equals `count`, so this simply reads 0..count in order.
        let idx = (log.head + i) % cap;
        out.push_back(log.buffer.get(idx).unwrap());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{Env, String};

    /// Issue #1947: the stored alert log must be capped at MAX_STATE_ALERTS no
    /// matter how many alerts are written, and it must retain the most recent
    /// alerts (dropping the oldest).
    #[test]
    fn test_state_alerts_are_capped() {
        let env = Env::default();

        // Fill the ring buffer to capacity with "old" alerts.
        for _ in 0..MAX_STATE_ALERTS {
            alert_on_inconsistency(&env, "old");
        }
        let alerts = get_state_alerts(&env);
        assert_eq!(alerts.len(), MAX_STATE_ALERTS);

        // Overflow the cap: the 20 oldest "old" alerts are evicted and replaced
        // by "new" alerts, so the total stays at the cap.
        for _ in 0..20 {
            alert_on_inconsistency(&env, "new");
        }
        let alerts = get_state_alerts(&env);
        assert_eq!(alerts.len(), MAX_STATE_ALERTS, "alert count must be capped");

        // Chronological order: the 30 surviving "old" alerts come first,
        // followed by the 20 most recent "new" alerts.
        for i in 0..30 {
            assert_eq!(alerts.get(i).unwrap(), String::from_str(&env, "old"));
        }
        for i in 30..MAX_STATE_ALERTS {
            assert_eq!(alerts.get(i).unwrap(), String::from_str(&env, "new"));
        }
    }
}
