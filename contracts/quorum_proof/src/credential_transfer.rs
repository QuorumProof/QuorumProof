/// Credential Transfer with Liability Module - Issue #1595
/// Implements credential transfers with liability tracking and audit trails
/// Clarifies responsibilities during credential transfers between parties

use soroban_sdk::{contracttype, Address, Bytes, Env, Vec};

/// Liability state for a credential transfer
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum LiabilityState {
    /// Original issuer is responsible
    WithIssuer = 1,
    /// Transferred to new issuer
    TransferredToIssuer = 2,
    /// Shared responsibility between parties
    Shared = 3,
    /// Transferred to holder
    TransferredToHolder = 4,
}

/// Credential transfer record
#[contracttype]
#[derive(Clone)]
pub struct CredentialTransfer {
    pub transfer_id: u64,
    /// The credential being transferred
    pub credential_id: u64,
    /// Original owner/issuer
    pub from_party: Address,
    /// New owner/issuer
    pub to_party: Address,
    /// Transfer timestamp
    pub transferred_at: u64,
    /// Optional reason for transfer
    pub reason: Option<Bytes>,
    /// Status of transfer
    pub status: TransferStatus,
}

/// Transfer status
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum TransferStatus {
    /// Transfer is pending approval
    Pending = 1,
    /// Transfer has been approved
    Approved = 2,
    /// Transfer has been executed
    Executed = 3,
    /// Transfer was rejected
    Rejected = 4,
    /// Transfer was reverted
    Reverted = 5,
}

/// Liability record for tracking responsibility
#[contracttype]
#[derive(Clone)]
pub struct LiabilityRecord {
    pub id: u64,
    pub credential_id: u64,
    pub transfer_id: Option<u64>,
    /// Party responsible for the credential
    pub responsible_party: Address,
    /// Current liability state
    pub state: LiabilityState,
    /// Shared liability percentage (0-100) if state is Shared
    pub shared_liability_percentage: Option<u32>,
    /// Valid from timestamp
    pub valid_from: u64,
    /// Valid until timestamp
    pub valid_until: Option<u64>,
    /// Last modified timestamp
    pub modified_at: u64,
}

/// Liability proof for immutable audit trail
#[contracttype]
#[derive(Clone)]
pub struct LiabilityProof {
    pub proof_id: u64,
    pub credential_id: u64,
    /// Hash of the liability trail
    pub trail_hash: Bytes,
    /// Parties involved
    pub parties_involved: Vec<Address>,
    /// Timestamp of proof generation
    pub generated_at: u64,
}

/// Audit trail entry for liability transfers
#[contracttype]
#[derive(Clone)]
pub struct LiabilityAuditTrail {
    pub id: u64,
    pub credential_id: u64,
    /// The party whose liability changed
    pub party: Address,
    /// Previous liability state
    pub previous_state: LiabilityState,
    /// New liability state
    pub new_state: LiabilityState,
    /// Who initiated the change
    pub initiated_by: Address,
    /// Change timestamp
    pub changed_at: u64,
    /// Optional notes about the change
    pub notes: Option<Bytes>,
}

/// Transfer event data
#[contracttype]
#[derive(Clone)]
pub struct TransferInitiatedEventData {
    pub transfer_id: u64,
    pub credential_id: u64,
    pub from_party: Address,
    pub to_party: Address,
    pub initiated_at: u64,
}

/// Liability transfer event data
#[contracttype]
#[derive(Clone)]
pub struct LiabilityTransferEventData {
    pub credential_id: u64,
    pub from_party: Address,
    pub to_party: Address,
    pub liability_state: u32,
    pub transferred_at: u64,
}
