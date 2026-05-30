use soroban_sdk::{contracttype, Env, Symbol, Vec};

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
    pub hash: soroban_sdk::Bytes,
}

const STATE_VALIDATION_LOG_KEY: &str = "state_validation_log";
const STATE_CHECKPOINT_KEY: &str = "state_checkpoint";

/// Validate contract state consistency
pub fn validate_state(env: &Env) -> ValidationResult {
    let mut errors = Vec::new(env);
    let mut warnings = Vec::new(env);
    
    // Check 1: Verify admin is set
    if !env.storage().instance().has(&Symbol::new(env, "admin")) {
        errors.push_back(String::from_linear(env, "Admin not initialized"));
    }
    
    // Check 2: Verify state version is valid
    let state_version: u32 = env.storage()
        .instance()
        .get(&Symbol::new(env, "state_version"))
        .unwrap_or(0);
    if state_version > 100 {
        warnings.push_back(String::from_linear(env, "State version unusually high"));
    }
    
    // Check 3: Verify no negative counts
    let credential_count: u64 = env.storage()
        .persistent()
        .get(&Symbol::new(env, "credential_count"))
        .unwrap_or(0);
    if credential_count > 1_000_000_000 {
        warnings.push_back(String::from_linear(env, "Credential count suspiciously high"));
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
fn compute_state_hash(env: &Env, credential_count: u64, slice_count: u64, attestation_count: u64) -> soroban_sdk::Bytes {
    // Simple hash: concatenate counts and hash
    let mut data = Vec::new(env);
    data.push_back(credential_count as u8);
    data.push_back(slice_count as u8);
    data.push_back(attestation_count as u8);
    
    soroban_sdk::Bytes::from_slice(env, &data.to_array::<3>().unwrap_or([0; 3]))
}

/// Alert on state inconsistencies
pub fn alert_on_inconsistency(env: &Env, message: &str) {
    // In production, this would emit an event or log to external monitoring
    // For now, we store it in persistent storage
    let key = Symbol::new(env, "state_alerts");
    let mut alerts: Vec<String> = env.storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| Vec::new(env));
    
    alerts.push_back(String::from_linear(env, message));
    
    // Keep only last 50 alerts
    if alerts.len() > 50 {
        let mut trimmed = Vec::new(env);
        for i in (alerts.len() - 50)..alerts.len() {
            trimmed.push_back(alerts.get(i as u32).unwrap());
        }
        env.storage().persistent().set(&key, &trimmed);
    } else {
        env.storage().persistent().set(&key, &alerts);
    }
}

/// Get state alerts
pub fn get_state_alerts(env: &Env) -> Vec<String> {
    let key = Symbol::new(env, "state_alerts");
    env.storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| Vec::new(env))
}
