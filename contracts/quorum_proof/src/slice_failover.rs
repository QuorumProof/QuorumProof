/// Slice Failover and Redundancy Module - Issue #1597
/// Implements failover mechanism for slices when attestors go offline
/// Ensures verification continuity through backup attestor lists and failover state management

use soroban_sdk::{contracttype, Address, Env, Vec};

/// Failover state for a slice
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum FailoverState {
    /// Slice is operating normally
    Healthy = 1,
    /// At least one attestor is unavailable
    DegradedMode = 2,
    /// Multiple attestors unavailable, failover triggered
    FailoverActive = 3,
    /// Failover is in recovery process
    Recovering = 4,
}

/// Backup attestor configuration for failover
#[contracttype]
#[derive(Clone)]
pub struct BackupAttestor {
    pub id: u64,
    /// Primary attestor this is backup for
    pub primary_attestor: Address,
    /// The backup attestor address
    pub backup_address: Address,
    /// Priority order (lower = higher priority)
    pub priority: u32,
    /// Whether this backup is active
    pub active: bool,
    /// Created timestamp
    pub created_at: u64,
}

/// Slice redundancy configuration
#[contracttype]
#[derive(Clone)]
pub struct SliceRedundancyConfig {
    pub slice_id: u64,
    /// Primary slice ID (if this is a backup slice)
    pub primary_slice_id: Option<u64>,
    /// List of backup slices
    pub backup_slice_ids: Vec<u64>,
    /// Failover threshold (number of unavailable attestors before failover)
    pub failover_threshold: u32,
    /// Current failover state
    pub state: FailoverState,
    /// Timestamp of last state change
    pub last_state_change: u64,
}

/// Failover event tracking
#[contracttype]
#[derive(Clone)]
pub struct FailoverEvent {
    pub event_id: u64,
    pub slice_id: u64,
    pub credential_id: Option<u64>,
    /// Attestors that became unavailable
    pub unavailable_attestors: Vec<Address>,
    /// State before failover
    pub previous_state: FailoverState,
    /// State after failover
    pub new_state: FailoverState,
    /// Backup attestors activated
    pub activated_backups: Vec<Address>,
    /// Timestamp of failover event
    pub triggered_at: u64,
}

/// Failover state machine tracking
#[contracttype]
#[derive(Clone)]
pub struct FailoverStateMachine {
    pub slice_id: u64,
    /// Current state
    pub current_state: FailoverState,
    /// State transition history (limited to last 10)
    pub state_history: Vec<FailoverStateTransition>,
    /// Timestamp of last health check
    pub last_health_check: u64,
    /// Number of consecutive health check failures
    pub consecutive_failures: u32,
}

/// Record of a state transition
#[contracttype]
#[derive(Clone)]
pub struct FailoverStateTransition {
    pub from_state: FailoverState,
    pub to_state: FailoverState,
    pub reason: Reason,
    pub timestamp: u64,
}

/// Reason for state transition
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum Reason {
    HealthCheckPassed = 1,
    AttestorUnavailable = 2,
    ThresholdExceeded = 3,
    ManualRecovery = 4,
    AutoRecovery = 5,
}

/// Health check result for an attestor
#[contracttype]
#[derive(Clone)]
pub struct AttestorHealthCheck {
    pub attestor: Address,
    pub slice_id: u64,
    /// Whether attestor is healthy
    pub is_healthy: bool,
    /// Response time in milliseconds
    pub response_time_ms: u64,
    /// Timestamp of check
    pub checked_at: u64,
    /// Error message if unhealthy
    pub error_message: Option<soroban_sdk::Bytes>,
}

/// Failover statistics
#[contracttype]
#[derive(Clone)]
pub struct FailoverStatistics {
    pub slice_id: u64,
    /// Total number of failover events
    pub total_failovers: u32,
    /// Average time to failover (milliseconds)
    pub avg_failover_time_ms: u64,
    /// Average recovery time (milliseconds)
    pub avg_recovery_time_ms: u64,
    /// Successfully resolved failovers
    pub successful_recoveries: u32,
    /// Last failover timestamp
    pub last_failover_at: u64,
}

/// Event data for failover triggered
#[contracttype]
#[derive(Clone)]
pub struct FailoverTriggeredEventData {
    pub slice_id: u64,
    pub credential_id: Option<u64>,
    pub unavailable_count: u32,
    pub state_change: u32,
    pub triggered_at: u64,
}

/// Event data for failover resolved
#[contracttype]
#[derive(Clone)]
pub struct FailoverResolvedEventData {
    pub slice_id: u64,
    pub recovery_state: u32,
    pub recovered_attestor_count: u32,
    pub recovery_time_ms: u64,
    pub resolved_at: u64,
}
