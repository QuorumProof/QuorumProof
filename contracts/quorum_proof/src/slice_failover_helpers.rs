/// Helper functions for slice failover and redundancy implementation
/// Issue #1597: Add Slice Failover and Redundancy

use soroban_sdk::{Address, Env, Vec};
use crate::slice_failover::{FailoverState, FailoverStateMachine, FailoverStateTransition, Reason};

/// Determine if failover should be triggered based on unavailable attestors
pub fn should_trigger_failover(
    unavailable_count: u32,
    failover_threshold: u32,
) -> bool {
    unavailable_count >= failover_threshold
}

/// Transition state based on failover triggers
pub fn transition_state(
    current_state: FailoverState,
    trigger: Reason,
) -> FailoverState {
    match (current_state, trigger) {
        (FailoverState::Healthy, Reason::AttestorUnavailable) => FailoverState::DegradedMode,
        (FailoverState::DegradedMode, Reason::ThresholdExceeded) => FailoverState::FailoverActive,
        (FailoverState::FailoverActive, Reason::AutoRecovery) => FailoverState::Recovering,
        (FailoverState::Recovering, Reason::HealthCheckPassed) => FailoverState::Healthy,
        (FailoverState::FailoverActive, Reason::ManualRecovery) => FailoverState::Recovering,
        _ => current_state,
    }
}

/// Calculate failover readiness (percentage of healthy attestors)
pub fn calculate_health_score(
    healthy_attestors: u32,
    total_attestors: u32,
) -> u32 {
    if total_attestors == 0 {
        return 100;
    }
    ((healthy_attestors as u64 * 100) / total_attestors as u64) as u32
}

/// Determine recovery priority for failover
pub fn get_recovery_priority(backup_count: u32) -> u32 {
    // Higher priority number = higher recovery priority
    if backup_count == 0 {
        1
    } else if backup_count <= 2 {
        2
    } else if backup_count <= 5 {
        3
    } else {
        4
    }
}

/// Check if slice is in critical state (requires immediate action)
pub fn is_critical_failover(
    unavailable_attestors: u32,
    total_attestors: u32,
) -> bool {
    // Critical if more than 50% of attestors are unavailable
    (unavailable_attestors as u64 * 2) > total_attestors as u64
}

/// Estimate recovery time in milliseconds
pub fn estimate_recovery_time(
    unavailable_count: u32,
    backup_available_count: u32,
) -> u64 {
    // Base recovery time: 100ms per unavailable attestor
    // Reduced by 20ms per available backup
    let base_time = (unavailable_count as u64) * 100;
    let backup_reduction = (backup_available_count as u64) * 20;

    if base_time > backup_reduction {
        base_time - backup_reduction
    } else {
        50 // Minimum recovery time
    }
}

/// Create a state transition record for audit trail
pub fn create_state_transition(
    from_state: FailoverState,
    to_state: FailoverState,
    reason: Reason,
    timestamp: u64,
) -> FailoverStateTransition {
    FailoverStateTransition {
        from_state,
        to_state,
        reason,
        timestamp,
    }
}

/// Validate backup attestor configuration
pub fn validate_backup_configuration(
    primary_count: u32,
    backup_count: u32,
) -> bool {
    // At least one backup per primary attestor
    backup_count >= primary_count
}
