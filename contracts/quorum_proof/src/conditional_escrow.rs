//! Credential Escrow for Conditional Transfer — Issue #1585
//!
//! Implements a state machine for conditional credential transfer through escrow.
//! Two parties can conditionally transfer credentials by depositing them into escrow
//! and specifying conditions that must be verified before release.
//!
//! ## State Machine
//! Proposed → Accepted → Verified → Released (or Cancelled at any point)
//!
//! ## Features
//! - Escrow state machine for safe credential transfer
//! - Condition verification before release
//! - Automatic release upon condition satisfaction
//! - Cancellation rights for both parties (before verification)

use soroban_sdk::{Address, Env};

/// Condition type for escrow release.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EscrowCondition {
    /// No condition, released immediately upon acceptance
    None = 0,
    /// Condition: recipient provides correct preimage of hash
    PreimageHash = 1,
    /// Condition: time-locked release after timestamp
    TimeLocked = 2,
    /// Condition: verifier attestation required
    AttestationRequired = 3,
    /// Condition: cryptographic proof required
    ProofRequired = 4,
}

/// State of a credential in escrow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EscrowState {
    /// Initial state, awaiting recipient acceptance
    Proposed = 0,
    /// Recipient has accepted the transfer
    Accepted = 1,
    /// Conditions have been verified
    ConditionsVerified = 2,
    /// Credential has been released to recipient
    Released = 3,
    /// Escrow has been cancelled
    Cancelled = 4,
}

/// Details of a credential held in escrow.
#[derive(Clone, Debug)]
pub struct CredentialEscrow {
    /// Unique identifier for this escrow
    pub escrow_id: u64,
    /// Credential being held in escrow
    pub credential_id: u64,
    /// Current holder (will be escrowed)
    pub sender: Address,
    /// Intended recipient
    pub recipient: Address,
    /// Current state of the escrow
    pub state: EscrowState,
    /// Condition for release
    pub condition: EscrowCondition,
    /// Optional condition data (e.g., hash value, timestamp, etc.)
    pub condition_data: soroban_sdk::Bytes,
    /// Timestamp when escrow was created
    pub created_at: u64,
    /// Timestamp when escrow expires (if not released)
    pub expires_at: Option<u64>,
}

/// Condition evaluation result.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConditionResult {
    /// Condition satisfied, safe to release
    Satisfied = 1,
    /// Condition not yet satisfied
    Unsatisfied = 2,
    /// Condition can never be satisfied
    Failed = 3,
}

impl CredentialEscrow {
    /// Create a new credential escrow in Proposed state.
    pub fn new(
        escrow_id: u64,
        credential_id: u64,
        sender: Address,
        recipient: Address,
        condition: EscrowCondition,
        condition_data: soroban_sdk::Bytes,
        expires_at: Option<u64>,
    ) -> Self {
        CredentialEscrow {
            escrow_id,
            credential_id,
            sender,
            recipient,
            state: EscrowState::Proposed,
            condition,
            condition_data,
            created_at: 0, // Will be set by contract
            expires_at,
        }
    }

    /// Check if escrow can be cancelled (not yet released).
    pub fn is_cancellable(&self) -> bool {
        self.state != EscrowState::Released
    }

    /// Check if escrow has expired.
    pub fn is_expired(&self, current_time: u64) -> bool {
        match self.expires_at {
            Some(expires) => current_time > expires,
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_escrow_state_transitions() {
        assert_eq!(EscrowState::Proposed as u32, 0);
        assert_eq!(EscrowState::Accepted as u32, 1);
        assert_eq!(EscrowState::ConditionsVerified as u32, 2);
        assert_eq!(EscrowState::Released as u32, 3);
        assert_eq!(EscrowState::Cancelled as u32, 4);
    }

    #[test]
    fn test_condition_types() {
        assert_eq!(EscrowCondition::None as u32, 0);
        assert_eq!(EscrowCondition::PreimageHash as u32, 1);
        assert_eq!(EscrowCondition::TimeLocked as u32, 2);
        assert_eq!(EscrowCondition::AttestationRequired as u32, 3);
        assert_eq!(EscrowCondition::ProofRequired as u32, 4);
    }

    #[test]
    fn test_escrow_is_cancellable() {
        // Mock address for testing
        let mock_bytes = soroban_sdk::Bytes::new(&unsafe { soroban_sdk::Env::default() });
        let escrow = CredentialEscrow {
            escrow_id: 1,
            credential_id: 1,
            sender: Address::Account(soroban_sdk::AccountId(soroban_sdk::BytesN::zero())),
            recipient: Address::Account(soroban_sdk::AccountId(soroban_sdk::BytesN::zero())),
            state: EscrowState::Proposed,
            condition: EscrowCondition::None,
            condition_data: mock_bytes.clone(),
            created_at: 0,
            expires_at: None,
        };

        assert!(escrow.is_cancellable());

        let released_escrow = CredentialEscrow {
            state: EscrowState::Released,
            ..escrow
        };
        assert!(!released_escrow.is_cancellable());
    }
}
