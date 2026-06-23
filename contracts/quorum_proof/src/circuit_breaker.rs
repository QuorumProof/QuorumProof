use soroban_sdk::{contracterror, contracttype, panic_with_error, Address, Env, String, Vec};

use crate::{ContractError, DataKey, DataKey4, EXTENDED_TTL, STANDARD_TTL};

/// The operational state of the circuit breaker.
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum CircuitBreakerState {
    Normal = 0,
    Degraded = 1,
    Paused = 2,
}

/// Configuration for the circuit breaker behaviour.
#[contracttype]
#[derive(Clone, Debug)]
pub struct CircuitBreakerConfig {
    /// How many seconds before auto-recovery from Degraded or Paused.
    pub ttl_seconds: u64,
    /// Maximum number of writes allowed per ledger in Degraded mode.
    pub degraded_write_limit: u32,
    /// Whether automatic recovery is enabled.
    pub auto_recover: bool,
}

/// Details of an active circuit breaker activation.
#[contracttype]
#[derive(Clone, Debug)]
pub struct CircuitBreakerActivation {
    pub state: CircuitBreakerState,
    pub activated_at: u64,
    pub activated_by: Address,
    pub reason: String,
    pub auto_recover_at: u64,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct CircuitBreakerEvent {
    pub previous_state: CircuitBreakerState,
    pub new_state: CircuitBreakerState,
    pub activated_by: Address,
    pub reason: String,
    pub degraded_write_count: u32,
}

// ── Storage helpers ──────────────────────────────────────────────────────────

pub fn set_state(env: &Env, state: CircuitBreakerState) {
    env.storage().instance().set(&DataKey4::CircuitBreakerState, &state);
    env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
}

pub fn get_state(env: &Env) -> CircuitBreakerState {
    env.storage()
        .instance()
        .get(&DataKey4::CircuitBreakerState)
        .unwrap_or(CircuitBreakerState::Normal)
}

pub fn set_config(env: &Env, config: &CircuitBreakerConfig) {
    env.storage().instance().set(&DataKey4::CircuitBreakerConfig, config);
    env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
}

pub fn get_config(env: &Env) -> CircuitBreakerConfig {
    env.storage()
        .instance()
        .get(&DataKey4::CircuitBreakerConfig)
        .unwrap_or(CircuitBreakerConfig {
            ttl_seconds: 86_400,   // 24 hours
            degraded_write_limit: 10,
            auto_recover: true,
        })
}

pub fn set_activation(env: &Env, activation: &CircuitBreakerActivation) {
    env.storage().instance().set(&DataKey4::CircuitBreakerActivation, activation);
    env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
}

pub fn get_activation(env: &Env) -> Option<CircuitBreakerActivation> {
    env.storage().instance().get(&DataKey4::CircuitBreakerActivation)
}

pub fn clear_activation(env: &Env) {
    env.storage().instance().remove(&DataKey4::CircuitBreakerActivation);
    env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
}

pub fn get_and_increment_degraded_write_count(env: &Env) -> u32 {
    let count: u32 = env
        .storage()
        .instance()
        .get(&DataKey4::CircuitBreakerDegradedWriteCount)
        .unwrap_or(0);
    let next = count.saturating_add(1);
    env.storage()
        .instance()
        .set(&DataKey4::CircuitBreakerDegradedWriteCount, &next);
    env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    next
}

pub fn reset_degraded_write_count(env: &Env) {
    env.storage()
        .instance()
        .set(&DataKey4::CircuitBreakerDegradedWriteCount, &0u32);
    env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);
}

fn publish_event(
    env: &Env,
    previous_state: CircuitBreakerState,
    new_state: CircuitBreakerState,
    activated_by: Address,
    reason: String,
    degraded_write_count: u32,
) {
    let topic = String::from_str(env, "CircuitBreaker");
    let mut topics: Vec<String> = Vec::new(env);
    topics.push_back(topic);
    env.events().publish(
        topics,
        CircuitBreakerEvent {
            previous_state,
            new_state,
            activated_by,
            reason,
            degraded_write_count,
        },
    );
}

// ── Core logic ───────────────────────────────────────────────────────────────

pub fn emergency_pause(env: &Env, admin: &Address, reason: String) {
    let previous = get_state(env);
    let config = get_config(env);
    let now = env.ledger().timestamp();

    let activation = CircuitBreakerActivation {
        state: CircuitBreakerState::Paused,
        activated_at: now,
        activated_by: admin.clone(),
        reason: reason.clone(),
        auto_recover_at: now.saturating_add(config.ttl_seconds),
    };
    set_activation(env, &activation);
    set_state(env, CircuitBreakerState::Paused);
    env.storage().instance().set(&DataKey::Paused, &true);
    env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);

    publish_event(env, previous, CircuitBreakerState::Paused, admin.clone(), reason, 0);
}

pub fn emergency_degrade(env: &Env, admin: &Address, reason: String) {
    let previous = get_state(env);
    let config = get_config(env);
    let now = env.ledger().timestamp();

    let activation = CircuitBreakerActivation {
        state: CircuitBreakerState::Degraded,
        activated_at: now,
        activated_by: admin.clone(),
        reason: reason.clone(),
        auto_recover_at: now.saturating_add(config.ttl_seconds),
    };
    set_activation(env, &activation);
    set_state(env, CircuitBreakerState::Degraded);
    reset_degraded_write_count(env);

    publish_event(env, previous, CircuitBreakerState::Degraded, admin.clone(), reason, 0);
}

pub fn resume(env: &Env, admin: &Address) {
    let previous = get_state(env);
    clear_activation(env);
    set_state(env, CircuitBreakerState::Normal);
    reset_degraded_write_count(env);
    env.storage().instance().set(&DataKey::Paused, &false);
    env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);

    publish_event(
        env,
        previous,
        CircuitBreakerState::Normal,
        admin.clone(),
        String::from_str(env, "manual resume"),
        0,
    );
}

/// Check if the circuit breaker should auto-recover based on TTL.
/// Call this at the start of every mutating public function.
pub fn check_and_recover(env: &Env) {
    let config = get_config(env);
    if !config.auto_recover {
        return;
    }

    let current_state = get_state(env);
    if current_state == CircuitBreakerState::Normal {
        return;
    }

    let activation = get_activation(env);
    let Some(act) = activation else {
        return;
    };

    let now = env.ledger().timestamp();
    if now >= act.auto_recover_at {
        clear_activation(env);
        set_state(env, CircuitBreakerState::Normal);
        reset_degraded_write_count(env);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);

        publish_event(
            env,
            current_state,
            CircuitBreakerState::Normal,
            act.activated_by,
            String::from_str(env, "auto-recovery after TTL"),
            0,
        );
    }
}

/// Enforce write limits in Degraded mode. Returns an error if the limit is exceeded.
/// Call this from any mutating operation.
pub fn enforce_degraded_write_limit(env: &Env) -> Result<(), ContractError> {
    let state = get_state(env);
    if state != CircuitBreakerState::Degraded {
        return Ok(());
    }
    let config = get_config(env);
    let current_count = get_and_increment_degraded_write_count(env);
    if current_count > config.degraded_write_limit {
        Err(ContractError::CircuitBreakerDegradedLimitReached)
    } else {
        Ok(())
    }
}

/// Return the current state, performing a TTL check first.
pub fn get_state_with_recovery(env: &Env) -> CircuitBreakerState {
    check_and_recover(env);
    get_state(env)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::QuorumProofContract;
    use soroban_sdk::testutils::{Address as _, Ledger};

    struct CircuitBreakerTest {
        env: Env,
        admin: Address,
    }

    fn setup() -> CircuitBreakerTest {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register_contract(None, QuorumProofContract);
        let qp = crate::QuorumProofContractClient::new(&env, &contract_id);
        qp.initialize(&admin);
        env.budget().reset_unlimited();
        CircuitBreakerTest { env, admin }
    }

    #[test]
    fn starts_in_normal_state() {
        let test = setup();
        assert_eq!(get_state(&test.env), CircuitBreakerState::Normal);
        assert!(get_activation(&test.env).is_none());
    }

    #[test]
    fn emergency_pause_transitions_to_paused() {
        let test = setup();
        let reason = String::from_str(&test.env, "security incident");

        emergency_pause(&test.env, &test.admin, reason.clone());

        assert_eq!(get_state(&test.env), CircuitBreakerState::Paused);
        let act = get_activation(&test.env).unwrap();
        assert_eq!(act.state, CircuitBreakerState::Paused);
        assert_eq!(act.reason, reason);
        assert_eq!(act.activated_by, test.admin);
        assert!(act.auto_recover_at > act.activated_at);
    }

    #[test]
    fn emergency_pause_sets_storage_paused_flag() {
        let test = setup();
        let reason = String::from_str(&test.env, "test");

        emergency_pause(&test.env, &test.admin, reason);

        let paused: bool = test.env.storage().instance().get(&DataKey::Paused).unwrap_or(false);
        assert!(paused);
    }

    #[test]
    fn resume_clears_paused_and_returns_to_normal() {
        let test = setup();
        let reason = String::from_str(&test.env, "test");

        emergency_pause(&test.env, &test.admin, reason);
        assert_eq!(get_state(&test.env), CircuitBreakerState::Paused);

        resume(&test.env, &test.admin);

        assert_eq!(get_state(&test.env), CircuitBreakerState::Normal);
        assert!(get_activation(&test.env).is_none());
        let paused: bool = test.env.storage().instance().get(&DataKey::Paused).unwrap_or(false);
        assert!(!paused);
    }

    #[test]
    fn emergency_degrade_transitions_to_degraded() {
        let test = setup();
        let reason = String::from_str(&test.env, "load spike");

        emergency_degrade(&test.env, &test.admin, reason.clone());

        assert_eq!(get_state(&test.env), CircuitBreakerState::Degraded);
        let act = get_activation(&test.env).unwrap();
        assert_eq!(act.state, CircuitBreakerState::Degraded);
    }

    #[test]
    fn degraded_mode_does_not_set_paused_flag() {
        let test = setup();
        let reason = String::from_str(&test.env, "test");

        emergency_degrade(&test.env, &test.admin, reason);

        let paused: bool = test.env.storage().instance().get(&DataKey::Paused).unwrap_or(false);
        assert!(!paused);
    }

    #[test]
    fn enforce_degraded_write_limit_allows_within_limit() {
        let test = setup();
        let reason = String::from_str(&test.env, "test");
        emergency_degrade(&test.env, &test.admin, reason);

        let config = get_config(&test.env);
        for _ in 0..config.degraded_write_limit {
            assert!(enforce_degraded_write_limit(&test.env).is_ok());
        }
    }

    #[test]
    fn enforce_degraded_write_limit_rejects_over_limit() {
        let test = setup();
        let reason = String::from_str(&test.env, "test");
        emergency_degrade(&test.env, &test.admin, reason);

        let config = get_config(&test.env);
        let limit = config.degraded_write_limit;

        // First limit writes should be allowed (1-indexed comparison in the function)
        for _ in 0..limit {
            let _ = enforce_degraded_write_limit(&test.env);
        }
        // The next one exceeds the limit
        let result = enforce_degraded_write_limit(&test.env);
        assert_eq!(result, Err(ContractError::CircuitBreakerDegradedLimitReached));

        // Verify counter was incremented
        let count: u32 = test.env.storage().instance().get(&DataKey4::CircuitBreakerDegradedWriteCount).unwrap_or(0);
        assert_eq!(count, limit + 1);
    }

    #[test]
    fn auto_recover_after_ttl_expiry() {
        let test = setup();
        let reason = String::from_str(&test.env, "test");

        // Set a short TTL
        let mut config = get_config(&test.env);
        config.ttl_seconds = 100;
        set_config(&test.env, &config);

        emergency_pause(&test.env, &test.admin, reason);
        assert_eq!(get_state(&test.env), CircuitBreakerState::Paused);

        // Jump ledger time past the TTL
        let act = get_activation(&test.env).unwrap();
        test.env.ledger().set_timestamp(act.auto_recover_at + 1);

        // check_and_recover should transition back to Normal
        check_and_recover(&test.env);
        assert_eq!(get_state(&test.env), CircuitBreakerState::Normal);
        let paused: bool = test.env.storage().instance().get(&DataKey::Paused).unwrap_or(false);
        assert!(!paused);
    }

    #[test]
    fn auto_recover_does_not_fire_before_ttl() {
        let test = setup();
        let reason = String::from_str(&test.env, "test");

        emergency_pause(&test.env, &test.admin, reason);
        assert_eq!(get_state(&test.env), CircuitBreakerState::Paused);

        let act = get_activation(&test.env).unwrap();
        test.env.ledger().set_timestamp(act.auto_recover_at - 1);

        check_and_recover(&test.env);
        assert_eq!(get_state(&test.env), CircuitBreakerState::Paused);
    }

    #[test]
    fn auto_recover_disabled_when_config_says_no() {
        let test = setup();
        let mut config = get_config(&test.env);
        config.auto_recover = false;
        config.ttl_seconds = 100;
        set_config(&test.env, &config);

        let reason = String::from_str(&test.env, "test");
        emergency_pause(&test.env, &test.admin, reason);

        let act = get_activation(&test.env).unwrap();
        test.env.ledger().set_timestamp(act.auto_recover_at + 1);

        check_and_recover(&test.env);
        assert_eq!(
            get_state(&test.env),
            CircuitBreakerState::Paused,
            "should remain paused when auto_recover is false"
        );
    }

    #[test]
    fn config_persists_and_round_trips() {
        let test = setup();
        let config = CircuitBreakerConfig {
            ttl_seconds: 9999,
            degraded_write_limit: 5,
            auto_recover: false,
        };
        set_config(&test.env, &config);
        let retrieved = get_config(&test.env);
        assert_eq!(retrieved.ttl_seconds, 9999);
        assert_eq!(retrieved.degraded_write_limit, 5);
        assert_eq!(retrieved.auto_recover, false);
    }

    #[test]
    fn default_config_returned_when_none_set() {
        let default = CircuitBreakerConfig {
            ttl_seconds: 86_400,
            degraded_write_limit: 10,
            auto_recover: true,
        };
        // Use a fresh env without setting config
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register_contract(None, QuorumProofContract);
        let qp = crate::QuorumProofContractClient::new(&env, &contract_id);
        qp.initialize(&admin);

        assert_eq!(get_config(&env).ttl_seconds, default.ttl_seconds);
        assert_eq!(get_config(&env).degraded_write_limit, default.degraded_write_limit);
        assert_eq!(get_config(&env).auto_recover, default.auto_recover);
    }

    #[test]
    fn resume_from_degraded_works() {
        let test = setup();
        let reason = String::from_str(&test.env, "load spike");

        emergency_degrade(&test.env, &test.admin, reason);
        assert_eq!(get_state(&test.env), CircuitBreakerState::Degraded);

        resume(&test.env, &test.admin);
        assert_eq!(get_state(&test.env), CircuitBreakerState::Normal);
    }

    #[test]
    fn write_count_resets_after_resume() {
        let test = setup();
        let reason = String::from_str(&test.env, "test");

        emergency_degrade(&test.env, &test.admin, reason);
        let config = get_config(&test.env);

        // Use up the limit
        for _ in 0..config.degraded_write_limit {
            let _ = enforce_degraded_write_limit(&test.env);
        }

        resume(&test.env, &test.admin);

        // After resume, counter should be reset and writes should be allowed
        let count: u32 = test.env.storage().instance().get(&DataKey4::CircuitBreakerDegradedWriteCount).unwrap_or(99);
        assert_eq!(count, 0, "write count should reset after resume");
    }

    #[test]
    fn get_state_with_recovery_triggers_recovery() {
        let test = setup();
        let reason = String::from_str(&test.env, "test");

        let mut config = get_config(&test.env);
        config.ttl_seconds = 100;
        set_config(&test.env, &config);

        emergency_pause(&test.env, &test.admin, reason);

        let act = get_activation(&test.env).unwrap();
        test.env.ledger().set_timestamp(act.auto_recover_at + 1);

        let state = get_state_with_recovery(&test.env);
        assert_eq!(state, CircuitBreakerState::Normal);
    }

    #[test]
    fn degraded_write_limit_check_is_noop_in_normal() {
        let test = setup();
        // No circuit breaker activation — state is Normal
        assert!(enforce_degraded_write_limit(&test.env).is_ok());
    }

    #[test]
    fn degraded_write_limit_check_is_noop_in_paused() {
        let test = setup();
        let reason = String::from_str(&test.env, "test");

        emergency_pause(&test.env, &test.admin, reason);
        // In Paused mode, the degraded write limit should not apply
        // (separate pause mechanism blocks operations entirely)
        assert!(enforce_degraded_write_limit(&test.env).is_ok());
    }
}
