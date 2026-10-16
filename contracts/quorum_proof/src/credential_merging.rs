use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, Bytes, Vec};

/// Represents a merged credential combining multiple similar credentials
#[contracttype]
#[derive(Clone)]
pub struct MergedCredential {
    /// Unique identifier for the merged credential
    pub id: u64,
    /// Address of the holder
    pub subject: Address,
    /// Vector of credential IDs that were merged
    pub source_credential_ids: Vec<u64>,
    /// Combined metadata hash from all merged credentials
    pub metadata_hash: Bytes,
    /// Timestamp when merge occurred
    pub merged_at: u64,
    /// Address that performed the merge
    pub merged_by: Address,
    /// Total attestation count across all merged credentials
    pub total_attestations: u64,
}

/// Event emitted when credentials are merged
#[contracttype]
#[derive(Clone)]
pub struct CredentialMergedEventData {
    pub merged_credential_id: u64,
    pub source_credential_ids: Vec<u64>,
    pub subject: Address,
    pub merged_at: u64,
}

/// Validation result for credential merge operations
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum MergeValidationStatus {
    Valid = 0,
    InvalidCredentialType = 1,
    InvalidSubject = 2,
    CredentialRevoked = 3,
    InsufficientAttestations = 4,
    InvalidIssuer = 5,
}

/// Result of merge validation for an individual credential
#[contracttype]
#[derive(Clone)]
pub struct MergeValidationResult {
    pub credential_id: u64,
    pub status: MergeValidationStatus,
    pub message: soroban_sdk::String,
}

/// Configuration for credential merge operations
#[contracttype]
#[derive(Clone)]
pub struct MergeConfig {
    /// Minimum number of credentials that can be merged
    pub min_credentials_to_merge: u32,
    /// Maximum number of credentials that can be merged in one operation
    pub max_credentials_to_merge: u32,
    /// Whether to require same issuer for all merged credentials
    pub require_same_issuer: bool,
    /// Whether to require same credential type for all merged credentials
    pub require_same_type: bool,
    /// Minimum attestations required per credential to merge
    pub min_attestations_per_credential: u32,
}
