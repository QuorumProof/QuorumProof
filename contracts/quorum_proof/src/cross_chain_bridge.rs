use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, Bytes, Vec, String};

/// Represents a cross-chain bridge for credential portability
#[contracttype]
#[derive(Clone)]
pub struct CrossChainBridge {
    /// Unique bridge identifier
    pub id: u64,
    /// Source blockchain identifier (e.g., "stellar")
    pub source_chain: String,
    /// Target blockchain identifier
    pub target_chain: String,
    /// Address of the bridge validator set
    pub validator_set: Address,
    /// Threshold of validators required to approve cross-chain transfer
    pub approval_threshold: u32,
    /// Whether the bridge is currently active
    pub active: bool,
    /// Timestamp when bridge was created
    pub created_at: u64,
}

/// Represents a wrapped credential for cross-chain portability
#[contracttype]
#[derive(Clone)]
pub struct WrappedCredential {
    /// Unique identifier for wrapped credential
    pub id: u64,
    /// Original credential ID on source chain
    pub original_credential_id: u64,
    /// Source blockchain where credential originated
    pub source_chain: String,
    /// Target blockchain where credential is wrapped
    pub target_chain: String,
    /// Wrapped credential metadata
    pub wrapped_metadata: Bytes,
    /// Original issuer address on source chain
    pub original_issuer: Address,
    /// Address that wrapped the credential
    pub wrapped_by: Address,
    /// Timestamp when credential was wrapped
    pub wrapped_at: u64,
    /// Whether the wrapped credential is still valid
    pub valid: bool,
}

/// Bridge validator information
#[contracttype]
#[derive(Clone)]
pub struct BridgeValidator {
    /// Validator address
    pub address: Address,
    /// Whether validator is active
    pub active: bool,
    /// Number of approvals by this validator
    pub approval_count: u64,
    /// Timestamp when validator was added
    pub added_at: u64,
}

/// Cross-chain transfer approval
#[contracttype]
#[derive(Clone)]
pub struct CrossChainApproval {
    /// Unique transfer ID
    pub transfer_id: u64,
    /// Original credential ID
    pub credential_id: u64,
    /// Source blockchain
    pub source_chain: String,
    /// Target blockchain
    pub target_chain: String,
    /// Approvals from validators (Address -> bool)
    pub approvals: soroban_sdk::Map<Address, bool>,
    /// Total approvals received
    pub approval_count: u32,
    /// Timestamp when transfer was initiated
    pub initiated_at: u64,
    /// Completion timestamp (if completed)
    pub completed_at: Option<u64>,
}

/// Event emitted when credential is wrapped for cross-chain
#[contracttype]
#[derive(Clone)]
pub struct CredentialWrappedEventData {
    pub original_credential_id: u64,
    pub wrapped_credential_id: u64,
    pub source_chain: String,
    pub target_chain: String,
    pub wrapped_at: u64,
}

/// Event emitted when cross-chain transfer is approved
#[contracttype]
#[derive(Clone)]
pub struct CrossChainApprovedEventData {
    pub transfer_id: u64,
    pub credential_id: u64,
    pub source_chain: String,
    pub target_chain: String,
    pub approval_count: u32,
}

/// Bridge protocol error types
#[contracterror]
#[repr(u32)]
pub enum BridgeError {
    BridgeNotActive = 1,
    InvalidChainId = 2,
    CredentialAlreadyWrapped = 3,
    InsufficientApprovals = 4,
    ValidatorNotFound = 5,
    CredentialNotWrapped = 6,
    InvalidValidator = 7,
}
