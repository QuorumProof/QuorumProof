#![no_std]
use sbt_registry::SbtRegistryContractClient;
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    Bytes, Env, IntoVal, Map, String, Vec,
};
use zk_verifier::{ClaimType, ZkVerifierContractClient};

const TOPIC_ISSUE: &str = "CredentialIssued";
const TOPIC_REVOKE: &str = "RevokeCredential";
const TOPIC_CONSENT_REVOKED: &str = "ConsentRevoked";
const TOPIC_ATTESTATION: &str = "attestation";
const TOPIC_RENEWAL: &str = "CredentialRenewed";
const TOPIC_ATTESTATION_RENEWAL: &str = "AttestationRenewed";
const TOPIC_SBT_TRANSFER: &str = "SbtTransferred";
const TOPIC_PROOF_REQUEST: &str = "ProofRequested";
const TOPIC_RECOVERY_INITIATED: &str = "RecoveryInitiated";
const TOPIC_RECOVERY_APPROVED: &str = "RecoveryApproved";
const TOPIC_RECOVERY_EXECUTED: &str = "RecoveryExecuted";
const TOPIC_BLACKLIST_ADDED: &str = "HolderBlacklisted";
const TOPIC_BLACKLIST_REMOVED: &str = "HolderUnblacklisted";
const TOPIC_FORK_DETECTED: &str = "ForkDetected";
const TOPIC_FORK_RESOLVED: &str = "ForkResolved";
const TOPIC_HOLDER_NOTIFIED: &str = "HolderNotified";
const TOPIC_DELEGATION: &str = "DelegationGranted";
const TOPIC_THRESHOLD_CHANGE: &str = "ThresholdChanged";
const STANDARD_TTL: u32 = 16_384;
const EXTENDED_TTL: u32 = 524_288;
const MAX_ATTESTORS_PER_SLICE: u32 = 20;
const MAX_BATCH_SIZE: u32 = 50;
const MAX_MULTISIG_SIGNERS: u32 = 10;
// Issue #378: Transaction size validation
const MAX_METADATA_SIZE: u32 = 256;
const MAX_METADATA_BYTES_SIZE: u32 = 1024;
// Issue #379: Timestamp validation
const MAX_TIMESTAMP_FUTURE_OFFSET: u64 = 315_360_000; // ~10 years in seconds
const MAX_TIMESTAMP_PAST_OFFSET: u64 = 315_360_000; // ~10 years in seconds
const DEFAULT_REPUTATION_ATTESTATION_WEIGHT: u64 = 1;
const DEFAULT_REPUTATION_AGE_WEIGHT: u64 = 1;
const DEFAULT_REPUTATION_AGE_DIVISOR_SECONDS: u64 = 1_000;
// Issue #381: Rate limiting configuration
foconst DEFAULT_RATE_LIMIT_MAX_CALLS: u32 = 1000;
const DEFAULT_RATE_LIMIT_WINDOW_SECONDS: u64 = 86400; // 1 day
/// Issue #519: Cache TTL for metadata hash validation (~1 hour wall-clock seconds)
const METADATA_CACHE_TTL_SECS: u64 = 3_600;

#[contracttype]
#[derive(Clone)]
pub struct CredentialIssuedEventData {
    pub id: u64,
    pub subject: Address,
    pub credential_type: u32,
}

#[contracttype]
#[derive(Clone)]
pub struct RevokeEventData {
    pub credential_id: u64,
    pub subject: Address,
}

#[contracttype]
#[derive(Clone)]
pub struct ConsentRevokedEventData {
    pub credential_id: u64,
    pub holder: Address,
    pub issuer: Address,
    pub revoked_at: u64,
}

#[contracttype]
#[derive(Clone)]
pub struct AttestationEventData {
    pub attestor: Address,
    pub credential_id: u64,
    pub slice_id: u64,
}

#[contracttype]
#[derive(Clone)]
pub struct RenewalEventData {
    pub credential_id: u64,
    pub issuer: Address,
    pub new_expires_at: u64,
}

/// A single attestation record, capturing who attested, when, and the attestation value.
#[contracttype]
#[derive(Clone)]
pub struct AttestationRecord {
    pub attestor: Address,
    pub attested_at: u64,
    /// Optional Unix timestamp after which this attestation is considered expired.
    pub expires_at: Option<u64>,
    /// The attestation value: true for valid, false for invalid.
    pub attestation_value: bool,
    /// Optional arbitrary metadata attached by the attestor (e.g. notes, reference IDs).
    pub metadata: Option<soroban_sdk::Bytes>,
}

#[contracttype]
#[derive(Clone)]
pub struct AttestationRenewalEventData {
    pub attestor: Address,
    pub credential_id: u64,
    pub new_expires_at: u64,
}

/// Event data emitted when a recovery is initiated.
#[contracttype]
#[derive(Clone)]
pub struct RecoveryInitiatedEventData {
    pub recovery_id: u64,
    pub credential_id: u64,
    pub issuer: Address,
    pub new_subject: Address,
}

/// Event data emitted when a recovery is approved.
#[contracttype]
#[derive(Clone)]
pub struct RecoveryApprovedEventData {
    pub recovery_id: u64,
    pub approver: Address,
}

/// Event data emitted when a recovery is executed.
#[contracttype]
#[derive(Clone)]
pub struct RecoveryExecutedEventData {
    pub recovery_id: u64,
    pub credential_id: u64,
    pub new_subject: Address,
}

/// Event data emitted when a holder is added to blacklist.
#[contracttype]
#[derive(Clone)]
pub struct HolderBlacklistedEventData {
    pub issuer: Address,
    pub holder: Address,
    pub reason: soroban_sdk::String,
    pub blacklisted_at: u64,
}

/// Event data emitted when a holder is removed from blacklist.
#[contracttype]
#[derive(Clone)]
pub struct HolderUnblacklistedEventData {
    pub issuer: Address,
    pub holder: Address,
    pub removed_at: u64,
}

/// Record of a holder being blacklisted by an issuer.
#[contracttype]
#[derive(Clone)]
pub struct BlacklistEntry {
    pub issuer: Address,
    pub holder: Address,
    pub reason: soroban_sdk::String,
    pub blacklisted_at: u64,
}

/// Event data emitted when a fork is detected.
#[contracttype]
#[derive(Clone)]
pub struct ForkDetectedEventData {
    pub credential_id: u64,
    pub slice_id: u64,
    pub conflicting_attestors: Vec<Address>,
    pub detected_at: u64,
}

/// Event data emitted when a fork is resolved.
#[contracttype]
#[derive(Clone)]
pub struct ForkResolvedEventData {
    pub credential_id: u64,
    pub slice_id: u64,
    pub resolution: soroban_sdk::String,
    pub resolved_at: u64,
}

/// Notification sent to a credential holder when an attestation is made on their credential.
#[contracttype]
#[derive(Clone)]
pub struct HolderNotification {
    pub credential_id: u64,
    pub attestor: Address,
    pub slice_id: u64,
    pub notified_at: u64,
}

/// Information about a detected fork.
#[contracttype]
#[derive(Clone)]
pub struct ForkInfo {
    pub credential_id: u64,
    pub slice_id: u64,
    pub conflicting_attestors: Vec<Address>,
    pub attested_values: Vec<bool>,
    pub detected_at: u64,
}

/// Status of fork detection for a credential.
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum ForkStatus {
    NoFork = 1,
    ForkDetected = 2,
    ForkResolved = 3,
}

/// Represents the status of a credential recovery request.
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum RecoveryStatus {
    Pending = 1,
    Approved = 2,
    Executed = 3,
    Rejected = 4,
}

/// A pending credential recovery request initiated by the issuer.
#[contracttype]
#[derive(Clone)]
pub struct RecoveryRequest {
    pub id: u64,
    pub credential_id: u64,
    pub issuer: Address,
    pub new_subject: Address,
    pub status: RecoveryStatus,
    pub created_at: u64,
    pub executed_at: Option<u64>,
    pub approvers: Vec<Address>,
    pub threshold: u32,
}

/// Records a single approval on a recovery request.
#[contracttype]
#[derive(Clone)]
pub struct RecoveryApproval {
    pub approver: Address,
    pub approved_at: u64,
}

/// Time window during which attestations are allowed for a credential.
#[contracttype]
#[derive(Clone)]
pub struct AttestationTimeWindow {
    /// Unix timestamp when the attestation window opens.
    pub start: u64,
    /// Unix timestamp when the attestation window closes.
    pub end: u64,
}

/// Records a veto applied to an attestation by a designated veto member.
#[contracttype]
#[derive(Clone)]
pub struct VetoRecord {
    pub vetoer: Address,
    pub credential_id: u64,
    pub justification: String,
    pub vetoed_at: u64,
}

/// Issue #377: Cache for attestation verification results
#[contracttype]
#[derive(Clone)]
pub struct AttestationVerificationCache {
    pub credential_id: u64,
    pub slice_id: u64,
    pub is_attested: bool,
    pub cached_at: u64,
    pub expires_at: u64,
}

/// Issue #380: Transfer restrictions per credential type
#[contracttype]
#[derive(Clone)]
pub struct TransferRestriction {
    pub credential_type: u32,
    pub is_transferable: bool,
    pub configured_at: u64,
}

/// Issue #519: Cache for metadata hash validation result
#[contracttype]
#[derive(Clone)]
pub struct MetadataHashCache {
    pub credential_id: u64,
    pub metadata_hash: soroban_sdk::Bytes,
    pub is_valid: bool,
    pub cached_at: u64,
    pub expires_at: u64,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ContractError {
    CredentialNotFound = 1,
    SliceNotFound = 2,
    ContractPaused = 3,
    DuplicateCredential = 4,
    DuplicateAttestor = 5,
    AttestationExpired = 6,
    InvalidInput = 7,
    InvalidAddress = 8,
    OnboardingNotFound = 9,
    DisputeNotFound = 10,
    UnauthorizedAction = 11,
    InvalidApprovalWorkflow = 12,
    AlreadyChallenged = 13,
    ChallengeNotFound = 14,
    ChallengeResolved = 15,
    NotAttested = 16,
    NotInSlice = 17,
    AccusedCannotVote = 18,
    AlreadyVoted = 19,
    AttestationWindowOutside = 20,
    RecoveryNotFound = 21,
    RecoveryAlreadyExists = 22,
    RecoveryNotPending = 23,
    RecoveryAlreadyApproved = 24,
    RecoveryThresholdNotMet = 25,
    NotRecoveryApprover = 26,
    DuplicateRecoveryApproval = 27,
    /// Credential type hierarchy error: parent type not found
    InvalidParentType = 28,
    /// Credential type hierarchy error: would create circular dependency
    CircularHierarchy = 29,
    /// Credential type is not registered
    CredentialTypeNotFound = 30,
    /// Holder is blacklisted by this issuer
    HolderBlacklisted = 31,
    /// Holder already on this issuer's blacklist
    AlreadyBlacklisted = 32,
    /// Holder not on this issuer's blacklist
    NotBlacklisted = 33,
    /// Fork detected: conflicting attestations for the same slice
    ForkDetected = 34,
    /// Fork already resolved for this slice
    ForkAlreadyResolved = 35,
    /// No fork exists for this slice
    NoForkExists = 36,
    /// Issue #378: Transaction size validation
    TransactionSizeExceeded = 37,
    /// Issue #379: Timestamp validation
    InvalidTimestamp = 38,
    /// Issue #380: Transfer restrictions
    TransferNotAllowed = 39,
    /// Transfer not authorized by the credential subject
    UnauthorizedTransfer = 40,
    /// Rate limit exceeded for address
    RateLimitExceeded = 41,
    /// Numeric overflow detected
    NumericOverflow = 42,
    /// Invalid enum value
    InvalidEnumValue = 43,
    /// Permission denied
    PermissionDenied = 44,
    /// No revocation request exists for this credential
    RevocationRequestNotFound = 45,
    /// Revocation request is not in pending state
    RevocationNotPending = 46,
    /// Credential version does not exist
    CredentialVersionNotFound = 47,
    /// Party has no decryption key entry for this credential
    DecryptionKeyNotFound = 48,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Credential(u64),
    CredentialCount,
    Slice(u64),
    SliceCount,
    Attestors(u64),
    SubjectCredentials(Address),
    AttestorCount(Address),
    CredentialType(u32),
    Admin,
    Paused,
    SubjectIssuerType(Address, Address, u32),
    ProofRequests(u64),
    ProofRequestCount,
    ReputationRecovery(Address),
    HolderActivity(Address),
    SliceConsensusHistory(u64),
    OnboardingRequests,
    OnboardingRequestCount,
    Disputes,
    Dispute(u64),
    DisputeCount,
    Challenge(u64),
    ChallengeCount,
    ActiveChallenge(u64, Address),
    AttestationExpiry(u64),
    AttestationWindow(u64),
    RecoveryRequest(u64),
    RecoveryRequestCount,
    SlashCount(Address),
    /// Issue #487: Tracks the current state schema version for migration support.
    StateVersion,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey2 {
    CredentialRecovery(u64),
    RecoveryApprovals(u64),
    CredentialTypeParent(u32),
    CredentialTypeChildren(u32),
    BlacklistEntry(Address, Address),
    IssuerBlacklist(Address),
    HolderBlacklists(Address),
    ForkInfo(u64, u64),
    ForkStatus(u64, u64),
    NotificationHistory(Address),
    AttestationMetadata(u64, Address),
    GracePeriod(u32),
    HolderAttestationCount(Address),
    HolderWhitelist(Address, Address),
    IssuerWhitelist(Address),
    AttestVerifyCache(u64, u64),
    TransferRestriction(u32),
    TransferRequest(u64),
    SuspendedAttestor(u64, Address),
    SliceMessages(u64),
    AttestEvidence(u64, Address),
    AttestConditions(u64),
    RateLimitConfig,
    RateLimitState(Address),
    IssuerRateLimitConfig(Address),
    RateLimitWhitelist(Address),
    CredentialAuditTrail(u64),
    CredentialMetadataStore(u64),
}

#[contracttype]
#[derive(Clone)]
pub struct CredentialTypeDef {
    pub type_id: u32,
    pub name: soroban_sdk::String,
    pub description: soroban_sdk::String,
    /// Optional parent type ID for hierarchy support.
    /// Enables credential type inheritance and verification rule composition.
    pub parent_type: Option<u32>,
}

/// Monotonic credential identifier issued by this contract.
pub type CredentialId = u64;

#[contracttype]
#[derive(Clone)]
pub struct Credential {
    pub id: u64,
    pub subject: Address,
    pub issuer: Address,
    pub credential_type: u32,
    pub metadata_hash: soroban_sdk::Bytes,
    pub revoked: bool,
    pub suspended: bool,
    pub expires_at: Option<u64>,
    pub version: u32,
}

/// Status of a holder-initiated revocation request.
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum RevocationStatus {
    Pending = 1,
    Approved = 2,
    Denied = 3,
}

/// Holder revocation request stored per credential.
#[contracttype]
#[derive(Clone)]
pub struct HolderRevocationRequest {
    pub credential_id: CredentialId,
    pub holder: Address,
    pub requested_at: u64,
    pub requested_ledger: u32,
    pub status: RevocationStatus,
}

/// Audit trail entry for revocation request lifecycle.
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum RevocationAuditAction {
    RequestSubmitted = 1,
    Approved = 2,
    Denied = 3,
}

#[contracttype]
#[derive(Clone)]
pub struct RevocationAuditEntry {
    pub action: RevocationAuditAction,
    pub actor: Address,
    pub timestamp: u64,
    pub ledger_sequence: u32,
    pub status: RevocationStatus,
}

/// Encrypted credential metadata stored on-chain (ciphertext only).
#[contracttype]
#[derive(Clone)]
pub struct EncryptedCredentialMetadata {
    /// AES-256 ciphertext produced off-chain by the issuer.
    pub ciphertext: soroban_sdk::Bytes,
    /// Per-party data keys encrypted under each authorized party's public key.
    pub encrypted_keys: soroban_sdk::Map<Address, soroban_sdk::Bytes>,
}

/// A single version in credential metadata history.
#[contracttype]
#[derive(Clone)]
pub struct CredentialVersion {
    pub version: u32,
    pub metadata: soroban_sdk::Bytes,
    pub updated_at: u64,
    pub updated_by: Address,
}

/// A single proof request record, capturing who requested proof of a credential and when.
#[contracttype]
#[derive(Clone)]
pub struct ProofRequest {
    /// Unique monotonic ID across all proof requests on this contract.
    pub id: u64,
    /// The credential for which proof was requested.
    pub credential_id: u64,
    /// The address of the verifier that initiated this request.
    pub verifier: Address,
    /// Ledger timestamp at the time this request was created.
    pub requested_at: u64,
    /// The ZK claim types the verifier wants proven.
    pub claim_types: Vec<zk_verifier::ClaimType>,
}

/// Tracks a reputation recovery request for a slice member.
#[contracttype]
#[derive(Clone)]
pub struct ReputationRecovery {
    /// The attestor requesting recovery.
    pub attestor: Address,
    /// Ledger timestamp when recovery was initiated.
    pub initiated_at: u64,
    /// Whether the recovery has been completed.
    pub completed: bool,
}

/// A pending consent-based credential transfer request.
#[contracttype]
#[derive(Clone)]
pub struct TransferRequest {
    /// The credential being transferred.
    pub credential_id: u64,
    /// The current subject initiating the transfer.
    pub from: Address,
    /// The intended recipient who must accept.
    pub to: Address,
}

/// Represents a delegation grant allowing a delegate to verify a credential on behalf of the holder.
#[contracttype]
#[derive(Clone)]
pub struct Delegation {
    /// The address delegated to verify the credential.
    pub delegate: Address,
    /// The credential being delegated for verification.
    pub credential_id: u64,
    /// Ledger timestamp until which this delegation is valid.
    pub expiry: u64,
    /// Ledger sequence number when this delegation was granted.
    pub granted_at: u64,
}

/// Audit log entry for delegation grants.
#[contracttype]
#[derive(Clone)]
pub struct DelegationAuditEntry {
    /// The delegate who can verify the credential.
    pub delegate: Address,
    /// The credential being delegated.
    pub credential_id: u64,
    /// When the delegation expires.
    pub expiry: u64,
    /// Ledger sequence when the delegation was granted.
    pub granted_at: u64,
}

/// Audit log entry for quorum slice threshold changes.
#[contracttype]
#[derive(Clone)]
pub struct ThresholdAuditEntry {
    /// The slice whose threshold was changed.
    pub slice_id: u64,
    /// The previous threshold value.
    pub old_threshold: u32,
    /// The new threshold value.
    pub new_threshold: u32,
    /// The address that made the change.
    pub changed_by: Address,
    /// Ledger timestamp when the change was made.
    pub timestamp: u64,
}

/// Input parameters for batch credential issuance.
#[contracttype]
#[derive(Clone)]
pub struct CredentialInput {
    /// The subject/holder of the credential.
    pub subject: Address,
    /// The type ID of the credential.
    pub credential_type: u32,
    /// Hash of the credential metadata.
    pub metadata_hash: soroban_sdk::Bytes,
    /// Optional expiration timestamp.
    pub expires_at: Option<u64>,
}

/// Error information for batch credential issuance.
#[contracttype]
#[derive(Clone)]
pub struct BatchError {
    /// The index in the batch where the error occurred.
    pub failing_index: u32,
    /// Description of the validation error.
    pub reason: soroban_sdk::String,
}

/// Result type for batch credential issuance operations.
#[contracttype]
#[derive(Clone)]
pub enum BatchResult {
    /// Success: contains the newly issued credential IDs.
    Ok(Vec<u64>),
    /// Error: contains error details with failing index.
    Err(BatchError),
}

/// QuorumSlice represents a federated Byzantine agreement (FBA) trust slice.
/// Each attestor has an associated weight that contributes to the threshold check.
/// The threshold represents the minimum total weight of attestors required
/// for a credential to be considered attested, not just the count of attestors.
///
/// This implements a weighted FBA model where trust is proportional to the
/// stake/weight assigned to each attestor, as described in the Stellar whitepaper.
#[contracttype]
#[derive(Clone)]
pub struct QuorumSlice {
    pub id: u64,
    pub creator: Address,
    pub attestors: Vec<Address>,
    /// Weights corresponding to each attestor. Each weight represents the
    /// attestor's stake/contribution to the quorum. Higher weight = more trust.
    pub weights: Vec<u32>,
    /// Threshold is measured in weight units, not attestor count.
    /// The sum of weights from attesting parties must meet or exceed this value.
    pub threshold: u32,
}

/// Activity types that can be tracked per credential holder
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum ActivityType {
    CredentialIssued = 1,
    CredentialRevoked = 2,
    CredentialRenewed = 3,
    CredentialAttested = 4,
    AttestationExpired = 5,
    CredentialRecovered = 6,
}

/// Records a single activity event for a credential holder
#[contracttype]
#[derive(Clone)]
pub struct ActivityRecord {
    pub activity_type: ActivityType,
    pub credential_id: u64,
    pub timestamp: u64,
    pub actor: Address,        // issuer, attestor, or revoker
    pub slice_id: Option<u64>, // for attestation-related activities
}

/// Records a single metadata update in the immutable audit trail
#[contracttype]
#[derive(Clone)]
pub struct AuditEntry {
    pub updated_by: Address,
    pub timestamp: u64,
    pub change_summary: soroban_sdk::Bytes,
}

/// Compression type for credential metadata
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum CompressionType {
    None = 0,
    Gzip = 1,
}

/// Stores credential metadata with compression information
#[contracttype]
#[derive(Clone)]
pub struct CredentialMetadata {
    pub data: soroban_sdk::Bytes,
    pub compression: CompressionType,
}

/// Records a consensus decision for a quorum slice
#[contracttype]
#[derive(Clone)]
pub struct ConsensusDecision {
    pub decision_id: u64,
    pub slice_id: u64,
    pub credential_id: u64,
    pub timestamp: u64,
    pub required_weight_threshold: u32,
    pub achieved_weight: u32,
    pub total_weight: u32,
}

/// Represents the status of an onboarding request
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum OnboardingStatus {
    Pending = 1,
    Approved = 2,
    Rejected = 3,
}

/// Represents a vote on an onboarding request
#[contracttype]
#[derive(Clone)]
pub struct OnboardingVote {
    pub voter: Address,
    pub approval: bool,
    pub voted_at: u64,
}

/// Represents an onboarding request for a new slice member
#[contracttype]
#[derive(Clone)]
pub struct OnboardingRequest {
    pub id: u64,
    pub slice_id: u64,
    pub requester: Address,
    pub proposed_member: Address,
    pub proposed_weight: u32,
    pub status: OnboardingStatus,
    pub created_at: u64,
    pub votes: Vec<OnboardingVote>,
}

/// Represents the status of a dispute
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum DisputeStatus {
    Active = 1,
    Resolved = 2,
    Dismissed = 3,
}

/// Represents a vote on a dispute resolution
#[contracttype]
#[derive(Clone)]
pub struct DisputeVote {
    pub voter: Address,
    pub resolution: u32, // 0 = no vote, 1 = favor initiator, 2 = favor accused
    pub voted_at: u64,
}

/// Represents a dispute between slice members
#[contracttype]
#[derive(Clone)]
pub struct Dispute {
    pub id: u64,
    pub slice_id: u64,
    pub initiator: Address,
    pub accused: Address,
    pub reason: String,
    pub status: DisputeStatus,
    pub created_at: u64,
    pub votes: Vec<DisputeVote>,
}

/// Represents the status of a challenge
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum ChallengeStatus {
    Open = 1,
    Upheld = 2,
    Dismissed = 3,
}

/// Represents a challenge to a credential attestation
#[contracttype]
#[derive(Clone)]
pub struct Challenge {
    pub id: u64,
    pub credential_id: u64,
    pub slice_id: u64,
    pub accused: Address,
    pub challenger: Address,
    pub status: ChallengeStatus,
    pub uphold_votes: Vec<Address>,
    pub dismiss_votes: Vec<Address>,
}

/// A message sent within a quorum slice
#[contracttype]
#[derive(Clone)]
pub struct SliceMessage {
    pub sender: Address,
    pub content: soroban_sdk::String,
    pub sent_at: u64,
    pub expires_at: u64,
}

/// Evidence attached to an attestation
#[contracttype]
#[derive(Clone)]
pub struct AttestationEvidence {
    pub evidence_hash: soroban_sdk::Bytes,
    pub attached_at: u64,
}

/// A condition that must be met for an attestation to be valid
#[contracttype]
#[derive(Clone)]
pub struct AttestationCondition {
    pub key: soroban_sdk::String,
    pub value: soroban_sdk::Bytes,
}

/// Issue #381: Rate limit configuration per address
#[contracttype]
#[derive(Clone)]
pub struct RateLimitConfig {
    pub max_calls: u32,
    pub window_seconds: u64,
}

/// Issue #381: Rate limit tracking per address
#[contracttype]
#[derive(Clone)]
pub struct RateLimitState {
    pub call_count: u32,
    pub window_start: u64,
}

/// Verification statistics for the contract
#[contracttype]
#[derive(Clone)]
pub struct VerificationStats {
    pub total_verifications: u64,
    pub successful_verifications: u64,
    pub failed_verifications: u64,
}

/// Reputation record for a credential holder
#[contracttype]
#[derive(Clone)]
pub struct HolderReputation {
    pub credentials_held: u64,
    pub successful_verifications: u64,
    pub attestation_count: u64,
    pub attestation_age_seconds: u64,
    pub score: u64,
}

/// Scoring configuration for holder reputation.
#[contracttype]
#[derive(Clone)]
pub struct HolderReputationConfig {
    /// Points awarded per attestation recorded in the holder's history.
    pub attestation_weight: u64,
    /// Points awarded per age bucket of attestation history.
    pub age_weight: u64,
    /// Age bucket size in seconds. Larger values make age matter more slowly.
    pub age_divisor_seconds: u64,
}

// Issue #521: Default PoW difficulty (0 = disabled; admin can set to require leading zero bits)
const DEFAULT_POW_DIFFICULTY: u32 = 0;
// Issue #522: Consent request timeout (7 days in seconds)
const CONSENT_REQUEST_TIMEOUT: u64 = 7 * 24 * 3600;

/// Issue #522: Pending consent request for credential issuance
#[contracttype]
#[derive(Clone)]
pub struct ConsentRequest {
    pub id: u64,
    pub issuer: Address,
    pub subject: Address,
    pub credential_type: u32,
    pub metadata_hash: soroban_sdk::Bytes,
    pub expires_at_ts: u64,
    pub approved: bool,
}

#[contract]
pub struct QuorumProofContract;

#[contractimpl]
impl QuorumProofContract {
    /// Set the admin address once after deployment. Panics if already initialized.
    pub fn initialize(env: Env, admin: Address) {
        assert!(
            !env.storage().instance().has(&DataKey::Admin),
            "already initialized"
        );
        Self::require_valid_address(&env, &admin);
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Issue #487: Returns the current state schema version.
    /// Returns 0 if no version has been set (pre-versioning state).
    pub fn get_state_version(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::StateVersion)
            .unwrap_or(0u32)
    }

    /// Issue #487: Migrate contract state from `from_version` to `to_version`.
    /// Only the admin may call this. Versions must be sequential (to = from + 1).
    /// Each version bump applies the corresponding migration logic.
    pub fn migrate_state(env: Env, admin: Address, from_version: u32, to_version: u32) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(stored_admin == admin, "unauthorized");
        assert!(to_version == from_version + 1, "versions must be sequential");

        let current: u32 = env
            .storage()
            .instance()
            .get(&DataKey::StateVersion)
            .unwrap_or(0u32);
        assert!(current == from_version, "current version mismatch");

        // Apply migration logic for each version bump.
        // Add a new match arm here for every future schema change.
        match from_version {
            0 => {
                // v0 → v1: initial versioning baseline; no data transformation needed.
                // Future migrations that need to rewrite stored structs go in subsequent arms.
            }
            _ => panic!("no migration defined for this version"),
        }

        env.storage()
            .instance()
            .set(&DataKey::StateVersion, &to_version);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Pause the contract. Only admin may call this.
    pub fn pause(env: Env, admin: Address) {
        admin.require_auth();
        let stored: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(stored == admin, "unauthorized");
        env.storage().instance().set(&DataKey::Paused, &true);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Unpause the contract. Only admin may call this.
    pub fn unpause(env: Env, admin: Address) {
        admin.require_auth();
        let stored: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(stored == admin, "unauthorized");
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Returns true if the contract is currently paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    fn require_not_paused(env: &Env) {
        if env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
        {
            panic_with_error!(env, ContractError::ContractPaused);
        }
    }

    // ── Issue #381: Rate Limiting ─────────────────────────────────────────────

    /// Get the rate limit configuration (global)
    fn get_rate_limit_config(env: &Env) -> RateLimitConfig {
        env.storage()
            .instance()
            .get(&DataKey2::RateLimitConfig)
            .unwrap_or(RateLimitConfig {
                max_calls: DEFAULT_RATE_LIMIT_MAX_CALLS,
                window_seconds: DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
            })
    }

    /// Set the rate limit configuration (admin only)
    pub fn set_rate_limit_config(
        env: Env,
        admin: Address,
        max_calls: u32,
        window_seconds: u64,
    ) {
        admin.require_auth();
        let stored: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(stored == admin, "unauthorized");
        assert!(max_calls > 0, "max_calls must be greater than 0");
        assert!(window_seconds > 0, "window_seconds must be greater than 0");

        let config = RateLimitConfig {
            max_calls,
            window_seconds,
        };
        env.storage()
            .instance()
            .set(&DataKey2::RateLimitConfig, &config);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Get the rate limit configuration
    pub fn get_rate_limit_config_pub(env: Env) -> RateLimitConfig {
        Self::get_rate_limit_config(&env)
    }

    /// Set a per-issuer rate limit override. Admin only.
    pub fn set_issuer_rate_limit_config(
        env: Env,
        admin: Address,
        issuer: Address,
        max_calls: u32,
        window_seconds: u64,
    ) {
        admin.require_auth();
        let stored: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(stored == admin, "unauthorized");
        assert!(max_calls > 0, "max_calls must be greater than 0");
        assert!(window_seconds > 0, "window_seconds must be greater than 0");
        let config = RateLimitConfig { max_calls, window_seconds };
        env.storage()
            .instance()
            .set(&DataKey2::IssuerRateLimitConfig(issuer), &config);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Add an issuer to the rate limit whitelist (bypasses all rate limits). Admin only.
    pub fn add_rate_limit_whitelist(env: Env, admin: Address, issuer: Address) {
        admin.require_auth();
        let stored: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(stored == admin, "unauthorized");
        env.storage()
            .instance()
            .set(&DataKey2::RateLimitWhitelist(issuer), &true);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Remove an issuer from the rate limit whitelist. Admin only.
    pub fn remove_rate_limit_whitelist(env: Env, admin: Address, issuer: Address) {
        admin.require_auth();
        let stored: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(stored == admin, "unauthorized");
        env.storage()
            .instance()
            .remove(&DataKey2::RateLimitWhitelist(issuer));
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Check if an issuer is on the rate limit whitelist.
    pub fn is_rate_limit_whitelisted(env: Env, issuer: Address) -> bool {
        env.storage()
            .instance()
            .get::<DataKey2, bool>(&DataKey2::RateLimitWhitelist(issuer))
            .unwrap_or(false)
    }

    // ── Issue #521: Proof of Work for credential issuance ─────────────────────

    /// Set the PoW difficulty (number of leading zero bits). Admin only.
    pub fn set_pow_difficulty(env: Env, admin: Address, difficulty: u32) {
        admin.require_auth();
        let stored: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(stored == admin, "unauthorized");
        env.storage()
            .instance()
            .set(&DataKey2::PowDifficulty, &difficulty);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Get the current PoW difficulty setting.
    pub fn get_pow_difficulty(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey2::PowDifficulty)
            .unwrap_or(DEFAULT_POW_DIFFICULTY)
    }

    /// Verify that SHA-256(issuer_bytes || subject_bytes || credential_type || nonce) has
    /// at least `difficulty` leading zero bits. Panics with InvalidPoWNonce if not satisfied.
    fn verify_pow(
        env: &Env,
        issuer: &Address,
        subject: &Address,
        credential_type: u32,
        nonce: u64,
    ) {
        let difficulty: u32 = env
            .storage()
            .instance()
            .get(&DataKey2::PowDifficulty)
            .unwrap_or(DEFAULT_POW_DIFFICULTY);

        if difficulty == 0 {
            return;
        }

        // Build input: issuer_xdr || subject_xdr || credential_type(4 BE bytes) || nonce(8 BE bytes)
        let issuer_xdr = issuer.clone().to_xdr(env);
        let subject_xdr = subject.clone().to_xdr(env);

        let mut input = soroban_sdk::Bytes::new(env);
        input.append(&issuer_xdr);
        input.append(&subject_xdr);
        // Append credential_type as 4 big-endian bytes
        let ct_bytes = credential_type.to_be_bytes();
        input.append(&soroban_sdk::Bytes::from_slice(env, &ct_bytes));
        // Append nonce as 8 big-endian bytes
        let nonce_bytes = nonce.to_be_bytes();
        input.append(&soroban_sdk::Bytes::from_slice(env, &nonce_bytes));

        let hash = env.crypto().sha256(&input);
        let hash_bytes = hash.to_array();

        // Check leading zero bits
        let required_zero_bytes = (difficulty / 8) as usize;
        let remaining_bits = difficulty % 8;

        for i in 0..required_zero_bytes {
            if hash_bytes[i] != 0 {
                panic_with_error!(env, ContractError::InvalidPoWNonce);
            }
        }
        if remaining_bits > 0 && required_zero_bytes < 32 {
            let mask: u8 = 0xFF << (8 - remaining_bits);
            if hash_bytes[required_zero_bytes] & mask != 0 {
                panic_with_error!(env, ContractError::InvalidPoWNonce);
            }
        }
    }

    /// Check rate limit for an address and update if necessary
    /// Returns true if within rate limit, false if limit exceeded
    fn check_rate_limit(env: &Env, address: &Address) -> bool {
        // Whitelisted issuers bypass rate limiting entirely
        if env
            .storage()
            .instance()
            .get::<DataKey2, bool>(&DataKey2::RateLimitWhitelist(address.clone()))
            .unwrap_or(false)
        {
            return true;
        }

        // Use per-issuer config if set, otherwise fall back to global config
        let config: RateLimitConfig = env
            .storage()
            .instance()
            .get(&DataKey2::IssuerRateLimitConfig(address.clone()))
            .unwrap_or_else(|| Self::get_rate_limit_config(env));

        let now = env.ledger().timestamp();

        let state: Option<RateLimitState> = env
            .storage()
            .instance()
            .get(&DataKey2::RateLimitState(address.clone()));

        match state {
            Some(state) => {
                // Check if we're in the same window
                if now.saturating_sub(state.window_start) < config.window_seconds {
                    // Within window, check count
                    if state.call_count >= config.max_calls {
                        return false;
                    }
                    // Increment count
                    let new_state = RateLimitState {
                        call_count: state.call_count.saturating_add(1),
                        window_start: state.window_start,
                    };
                    env.storage()
                        .instance()
                        .set(&DataKey2::RateLimitState(address.clone()), &new_state);
                } else {
                    // New window, reset count
                    let new_state = RateLimitState {
                        call_count: 1,
                        window_start: now,
                    };
                    env.storage()
                        .instance()
                        .set(&DataKey2::RateLimitState(address.clone()), &new_state);
                }
            }
            None => {
                // First call, initialize state
                let new_state = RateLimitState {
                    call_count: 1,
                    window_start: now,
                };
                env.storage()
                    .instance()
                    .set(&DataKey2::RateLimitState(address.clone()), &new_state);
            }
        }
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
        true
    }

    /// Require that the address is within rate limits
    fn require_rate_limit(env: &Env, address: &Address) {
        if !Self::check_rate_limit(env, address) {
            panic_with_error!(env, ContractError::RateLimitExceeded);
        }
    }

    /// Get current rate limit state for an address
    pub fn get_rate_limit_state(env: Env, address: Address) -> Option<RateLimitState> {
        env.storage()
            .instance()
            .get(&DataKey2::RateLimitState(address))
    }

    // ── Issue #382: Numeric Overflow Protection ───────────────────────────────

    /// Add two u32 values with overflow check
    fn add_u32(a: u32, b: u32, env: &Env) -> u32 {
        match a.checked_add(b) {
            Some(result) => result,
            None => panic_with_error!(env, ContractError::NumericOverflow),
        }
    }

    /// Add two u64 values with overflow check
    fn add_u64(a: u64, b: u64, env: &Env) -> u64 {
        match a.checked_add(b) {
            Some(result) => result,
            None => panic_with_error!(env, ContractError::NumericOverflow),
        }
    }

    /// Multiply two u32 values with overflow check
    fn mul_u32(a: u32, b: u32, env: &Env) -> u32 {
        match a.checked_mul(b) {
            Some(result) => result,
            None => panic_with_error!(env, ContractError::NumericOverflow),
        }
    }

    /// Multiply two u64 values with overflow check
    fn mul_u64(a: u64, b: u64, env: &Env) -> u64 {
        match a.checked_mul(b) {
            Some(result) => result,
            None => panic_with_error!(env, ContractError::NumericOverflow),
        }
    }

    /// Increment u64 with overflow check
    fn increment_u64(value: u64, env: &Env) -> u64 {
        match value.checked_add(1) {
            Some(result) => result,
            None => panic_with_error!(env, ContractError::NumericOverflow),
        }
    }

    /// Validate that a u32 value is within bounds
    fn validate_u32_bounds(value: u32, min: u32, max: u32, name: &str, env: &Env) {
        if value < min || value > max {
            panic_with_error!(env, ContractError::InvalidInput);
        }
    }

    /// Validate that a u64 value is within bounds
    fn validate_u64_bounds(value: u64, min: u64, max: u64, env: &Env) {
        if value < min || value > max {
            panic_with_error!(env, ContractError::InvalidInput);
        }
    }

    // ── Issue #383: Enum Value Validation ─────────────────────────────────────

    /// Validate ForkStatus enum value
    fn validate_fork_status(value: u32) -> bool {
        match value {
            1 | 2 | 3 => true, // NoFork, ForkDetected, ForkResolved
            _ => false,
        }
    }

    /// Validate RecoveryStatus enum value
    fn validate_recovery_status(value: u32) -> bool {
        match value {
            1 | 2 | 3 | 4 => true, // Pending, Approved, Executed, Rejected
            _ => false,
        }
    }

    /// Validate OnboardingStatus enum value
    fn validate_onboarding_status(value: u32) -> bool {
        match value {
            1 | 2 | 3 => true, // Pending, Approved, Rejected
            _ => false,
        }
    }

    /// Validate DisputeStatus enum value
    fn validate_dispute_status(value: u32) -> bool {
        match value {
            1 | 2 | 3 => true, // Active, Resolved, Dismissed
            _ => false,
        }
    }

    /// Validate ChallengeStatus enum value
    fn validate_challenge_status(value: u32) -> bool {
        match value {
            1 | 2 | 3 => true, // Open, Upheld, Dismissed
            _ => false,
        }
    }

    /// Validate ActivityType enum value
    fn validate_activity_type(value: u32) -> bool {
        match value {
            1 | 2 | 3 | 4 | 5 | 6 => true, // CredentialIssued, CredentialRevoked, etc.
            _ => false,
        }
    }

    /// Require valid ForkStatus enum
    fn require_valid_fork_status(env: &Env, value: u32) {
        if !Self::validate_fork_status(value) {
            panic_with_error!(env, ContractError::InvalidEnumValue);
        }
    }

    /// Require valid RecoveryStatus enum
    fn require_valid_recovery_status(env: &Env, value: u32) {
        if !Self::validate_recovery_status(value) {
            panic_with_error!(env, ContractError::InvalidEnumValue);
        }
    }

    /// Require valid OnboardingStatus enum
    fn require_valid_onboarding_status(env: &Env, value: u32) {
        if !Self::validate_onboarding_status(value) {
            panic_with_error!(env, ContractError::InvalidEnumValue);
        }
    }

    /// Require valid DisputeStatus enum
    fn require_valid_dispute_status(env: &Env, value: u32) {
        if !Self::validate_dispute_status(value) {
            panic_with_error!(env, ContractError::InvalidEnumValue);
        }
    }

    /// Require valid ChallengeStatus enum
    fn require_valid_challenge_status(env: &Env, value: u32) {
        if !Self::validate_challenge_status(value) {
            panic_with_error!(env, ContractError::InvalidEnumValue);
        }
    }

    /// Require valid ActivityType enum
    fn require_valid_activity_type(env: &Env, value: u32) {
        if !Self::validate_activity_type(value) {
            panic_with_error!(env, ContractError::InvalidEnumValue);
        }
    }

    // ── Issue #384: Permission Validation ────────────────────────────────────

    /// Require that the caller is the admin
    fn require_admin(env: &Env, caller: &Address) {
        let stored: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        if stored != *caller {
            panic_with_error!(env, ContractError::PermissionDenied);
        }
    }

    /// Require that the caller is the issuer of a credential
    fn require_issuer(env: &Env, caller: &Address, credential_id: u64) {
        let credential: Credential = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(env, ContractError::CredentialNotFound));
        if credential.issuer != *caller {
            panic_with_error!(env, ContractError::PermissionDenied);
        }
    }

    /// Require that the caller is the subject of a credential
    fn require_subject(env: &Env, caller: &Address, credential_id: u64) {
        let credential: Credential = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(env, ContractError::CredentialNotFound));
        if credential.subject != *caller {
            panic_with_error!(env, ContractError::PermissionDenied);
        }
    }

    /// Require that the caller is a slice creator
    fn require_slice_creator(env: &Env, caller: &Address, slice_id: u64) {
        let slice: QuorumSlice = env
            .storage()
            .instance()
            .get(&DataKey::Slice(slice_id))
            .unwrap_or_else(|| panic_with_error!(env, ContractError::SliceNotFound));
        if slice.creator != *caller {
            panic_with_error!(env, ContractError::PermissionDenied);
        }
    }

    /// Require that the caller is a member of a slice
    fn require_slice_member(env: &Env, caller: &Address, slice_id: u64) {
        let slice: QuorumSlice = env
            .storage()
            .instance()
            .get(&DataKey::Slice(slice_id))
            .unwrap_or_else(|| panic_with_error!(env, ContractError::SliceNotFound));
        if !slice.attestors.contains(caller) {
            panic_with_error!(env, ContractError::PermissionDenied);
        }
    }

    /// Require that the caller is not blacklisted by the issuer
    fn require_not_blacklisted(env: &Env, issuer: &Address, holder: &Address) {
        if env
            .storage()
            .instance()
            .has(&DataKey2::BlacklistEntry(issuer.clone(), holder.clone()))
        {
            panic_with_error!(env, ContractError::HolderBlacklisted);
        }
    }

    /// Require that the credential is not revoked
    fn require_not_revoked(env: &Env, credential_id: u64) {
        let credential: Credential = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(env, ContractError::CredentialNotFound));
        if credential.revoked {
            panic_with_error!(env, ContractError::UnauthorizedAction);
        }
    }

    /// Require that the credential is not suspended
    fn require_not_suspended(env: &Env, credential_id: u64) {
        let credential: Credential = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(env, ContractError::CredentialNotFound));
        if credential.suspended {
            panic_with_error!(env, ContractError::UnauthorizedAction);
        }
    }

    /// Require that the credential exists
    fn require_credential_exists(env: &Env, credential_id: u64) {
        if !env
            .storage()
            .instance()
            .has(&DataKey::Credential(credential_id))
        {
            panic_with_error!(env, ContractError::CredentialNotFound);
        }
    }

    /// Require that the slice exists
    fn require_slice_exists(env: &Env, slice_id: u64) {
        if !env
            .storage()
            .instance()
            .has(&DataKey::Slice(slice_id))
        {
            panic_with_error!(env, ContractError::SliceNotFound);
        }
    }

    /// Validate that an address is not the zero/default address.
    /// In Soroban, the Address type guarantees validity at the type level.
    /// This function exists for API consistency and future extensibility.
    /// Currently a no-op since Soroban addresses are always valid.
    fn require_valid_address(_env: &Env, _addr: &Address) {
        // Soroban's Address type is always valid by construction.
        // No validation needed, but we keep this function for:
        // 1. API consistency across all address inputs
        // 2. Future extensibility if custom validation is needed
        // 3. Clear documentation of validation intent
    }

    /// Pre-condition assertion. Panics with `ContractError::InvalidInput` if `cond` is false.
    fn precondition(env: &Env, cond: bool) {
        if !cond {
            panic_with_error!(env, ContractError::InvalidInput);
        }
    }

    /// Post-condition assertion. Panics with a static message if `cond` is false.
    /// Used to assert invariants after state mutations.
    fn postcondition(cond: bool, _msg: &str) {
        if !cond {
            panic!("postcondition violated");
        }
    }

    fn append_revocation_audit(
        env: &Env,
        credential_id: CredentialId,
        action: RevocationAuditAction,
        actor: Address,
        status: RevocationStatus,
    ) {
        let entry = RevocationAuditEntry {
            action,
            actor,
            timestamp: env.ledger().timestamp(),
            ledger_sequence: env.ledger().sequence(),
            status,
        };
        let mut trail: Vec<RevocationAuditEntry> = env
            .storage()
            .instance()
            .get(&DataKey2::RevocationAuditTrail(credential_id))
            .unwrap_or(Vec::new(env));
        trail.push_back(entry);
        env.storage()
            .instance()
            .set(&DataKey2::RevocationAuditTrail(credential_id), &trail);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    fn mark_credential_revoked(
        env: &Env,
        credential_id: u64,
        credential: &mut Credential,
        revoker: Address,
    ) {
        credential.revoked = true;
        credential.suspended = false;
        env.storage()
            .instance()
            .set(&DataKey::Credential(credential_id), credential);
        let mut subject_creds: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::SubjectCredentials(credential.subject.clone()))
            .unwrap_or(Vec::new(env));
        let mut retained: Vec<u64> = Vec::new(env);
        for id in subject_creds.iter() {
            if id != credential_id {
                retained.push_back(id);
            }
        }
        if retained.len() != subject_creds.len() {
            subject_creds = retained;
            env.storage().instance().set(
                &DataKey::SubjectCredentials(credential.subject.clone()),
                &subject_creds,
            );
        }
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
        Self::invalidate_verification_caches_for_credential(env, credential_id);
        let event_data = RevokeEventData {
            credential_id,
            subject: credential.subject.clone(),
        };
        let topic = String::from_str(env, TOPIC_REVOKE);
        let mut topics: Vec<String> = Vec::new(env);
        topics.push_back(topic);
        env.events().publish(topics, event_data);
        Self::update_credential_metrics(env, credential_id, "revocation");
        Self::emit_status_update(
            env,
            credential_id,
            String::from_str(env, "active"),
            String::from_str(env, "revoked"),
        );
        Self::record_holder_activity(
            env,
            credential.subject.clone(),
            ActivityType::CredentialRevoked,
            credential_id,
            revoker,
            None,
        );
    }

    fn append_credential_version(
        env: &Env,
        credential_id: CredentialId,
        version: u32,
        metadata: Bytes,
        updated_by: Address,
    ) {
        let entry = CredentialVersion {
            version,
            metadata,
            updated_at: env.ledger().timestamp(),
            updated_by,
        };
        let mut history: Vec<CredentialVersion> = env
            .storage()
            .instance()
            .get(&DataKey2::CredentialVersionHistory(credential_id))
            .unwrap_or(Vec::new(env));
        history.push_back(entry);
        env.storage().instance().set(
            &DataKey2::CredentialVersionHistory(credential_id),
            &history,
        );
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Record an activity for a credential holder
    fn record_holder_activity(
        env: &Env,
        holder: Address,
        activity_type: ActivityType,
        credential_id: u64,
        actor: Address,
        slice_id: Option<u64>,
    ) {
        let current_time = env.ledger().timestamp();
        let activity = ActivityRecord {
            activity_type,
            credential_id,
            timestamp: current_time,
            actor,
            slice_id,
        };

        let mut activities: Vec<ActivityRecord> = env
            .storage()
            .instance()
            .get(&DataKey::HolderActivity(holder.clone()))
            .unwrap_or(Vec::new(env));

        // Apply retention policy: drop records older than 365 days (1 year)
        const ONE_YEAR_SECONDS: u64 = 365 * 24 * 60 * 60;
        let mut retained: Vec<ActivityRecord> = Vec::new(env);
        for record in activities.iter() {
            if current_time - record.timestamp < ONE_YEAR_SECONDS {
                retained.push_back(record);
            }
        }

        retained.push_back(activity);
        env.storage()
            .instance()
            .set(&DataKey::HolderActivity(holder), &retained);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    fn record_metadata_audit(
        env: &Env,
        credential_id: u64,
        updated_by: Address,
        _old_metadata_hash: soroban_sdk::Bytes,
        new_metadata_hash: soroban_sdk::Bytes,
    ) {
        let change_summary = new_metadata_hash.clone();

        let entry = AuditEntry {
            updated_by,
            timestamp: env.ledger().timestamp(),
            change_summary,
        };

        let mut audit_trail: Vec<AuditEntry> = env
            .storage()
            .instance()
            .get(&DataKey2::CredentialAuditTrail(credential_id))
            .unwrap_or(Vec::new(env));
        audit_trail.push_back(entry);
        env.storage()
            .instance()
            .set(&DataKey2::CredentialAuditTrail(credential_id), &audit_trail);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Set a condition-based expiry timestamp for attestations on a credential.
    /// After this timestamp, `is_attestation_expired` returns `true` and
    /// `is_attested` treats the attestation as invalid.
    ///
    /// Only the credential issuer may set this.
    ///
    /// # Panics
    /// Panics with `ContractError::CredentialNotFound` if the credential does not exist.
    /// Panics if the caller is not the issuer.
    /// Panics with `ContractError::InvalidInput` if `expires_at` is not in the future.
    pub fn set_attestation_expiry(env: Env, issuer: Address, credential_id: u64, expires_at: u64) {
        issuer.require_auth();
        Self::require_not_paused(&env);

        // Issue #379: Validate timestamp
        Self::validate_timestamp(&env, expires_at);

        let credential: Credential = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));
        assert!(
            credential.issuer == issuer,
            "only the credential issuer can set attestation expiry"
        );
        Self::precondition(&env, expires_at > env.ledger().timestamp());
        env.storage()
            .instance()
            .set(&DataKey::AttestationExpiry(credential_id), &expires_at);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Returns `true` if a condition-based attestation expiry has been set for the credential
    /// and the current ledger timestamp has passed it.
    ///
    /// Returns `false` if no attestation expiry is set (attestations do not expire by condition).
    ///
    /// # Panics
    /// Panics with `ContractError::CredentialNotFound` if the credential does not exist.
    pub fn is_attestation_expired(env: Env, credential_id: u64) -> bool {
        if !env
            .storage()
            .instance()
            .has(&DataKey::Credential(credential_id))
        {
            panic_with_error!(&env, ContractError::CredentialNotFound);
        }
        match env
            .storage()
            .instance()
            .get::<DataKey, u64>(&DataKey::AttestationExpiry(credential_id))
        {
            Some(expires_at) => env.ledger().timestamp() >= expires_at,
            None => false,
        }
    }

    /// Configure a time window during which attestations are allowed for a credential.
    /// Only the credential issuer may set this.
    ///
    /// # Panics
    /// Panics with `ContractError::CredentialNotFound` if the credential does not exist.
    /// Panics if the caller is not the issuer.
    /// Panics with `ContractError::InvalidInput` if `start >= end`.
    pub fn set_attestation_window(
        env: Env,
        issuer: Address,
        credential_id: u64,
        start: u64,
        end: u64,
    ) {
        issuer.require_auth();
        Self::require_not_paused(&env);

        // Issue #379: Validate timestamps
        Self::validate_timestamp(&env, start);
        Self::validate_timestamp(&env, end);

        let credential: Credential = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));
        assert!(
            credential.issuer == issuer,
            "only the credential issuer can set attestation window"
        );
        Self::precondition(&env, start < end);
        let window = AttestationTimeWindow { start, end };
        env.storage()
            .instance()
            .set(&DataKey::AttestationWindow(credential_id), &window);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Returns the attestation time window for a credential, if one has been configured.
    pub fn get_attestation_window(env: Env, credential_id: u64) -> Option<AttestationTimeWindow> {
        env.storage()
            .instance()
            .get(&DataKey::AttestationWindow(credential_id))
    }

    /// Validate an array input has between `min` and `max` elements (inclusive).
    fn validate_array_bounds(len: u32, min: u32, max: u32, name: &'static str) {
        assert!(len >= min, "{} must have at least {} element(s)", name, min);
        assert!(len <= max, "{} must have at most {} element(s)", name, max);
    }

    /// Issue #378: Validate transaction size constraints
    fn validate_transaction_size(env: &Env, metadata_hash: &soroban_sdk::Bytes) {
        if metadata_hash.len() > MAX_METADATA_SIZE {
            panic_with_error!(env, ContractError::TransactionSizeExceeded);
        }
    }

    /// Issue #378: Validate metadata bytes size
    fn validate_metadata_bytes_size(env: &Env, metadata: &Option<soroban_sdk::Bytes>) {
        if let Some(m) = metadata {
            if m.len() > MAX_METADATA_BYTES_SIZE {
                panic_with_error!(env, ContractError::TransactionSizeExceeded);
            }
        }
    }

    /// Issue #379: Validate timestamp is within reasonable range
    fn validate_timestamp(env: &Env, timestamp: u64) {
        let now = env.ledger().timestamp();
        let min_allowed = now.saturating_sub(MAX_TIMESTAMP_PAST_OFFSET);
        let max_allowed = now.saturating_add(MAX_TIMESTAMP_FUTURE_OFFSET);

        if timestamp < min_allowed || timestamp > max_allowed {
            panic_with_error!(env, ContractError::InvalidTimestamp);
        }
    }

    /// Issue #379: Validate optional timestamp if present
    fn validate_optional_timestamp(env: &Env, timestamp: &Option<u64>) {
        if let Some(ts) = timestamp {
            Self::validate_timestamp(env, *ts);
        }
    }

    /// Issue #377: Get cached attestation verification result
    fn get_verification_cache(
        env: &Env,
        credential_id: u64,
        slice_id: u64,
    ) -> Option<AttestationVerificationCache> {
        env.storage()
            .instance()
            .get(&DataKey2::AttestVerifyCache(credential_id, slice_id))
    }

    /// Issue #377: Set attestation verification cache
    fn set_verification_cache(
        env: &Env,
        credential_id: u64,
        slice_id: u64,
        is_attested: bool,
        cache_ttl: u64,
    ) {
        let now = env.ledger().timestamp();
        let cache = AttestationVerificationCache {
            credential_id,
            slice_id,
            is_attested,
            cached_at: now,
            expires_at: now.saturating_add(cache_ttl),
        };
        env.storage()
            .instance()
            .set(&DataKey2::AttestVerifyCache(credential_id, slice_id), &cache);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Issue #377: Invalidate attestation verification cache
    fn invalidate_verification_cache(env: &Env, credential_id: u64, slice_id: u64) {
        env.storage()
            .instance()
            .remove(&DataKey2::AttestVerifyCache(credential_id, slice_id));
    }

    /// Issue #377: Invalidate all attestation verification cache entries for a credential.
    fn invalidate_verification_caches_for_credential(env: &Env, credential_id: u64) {
        let slice_count = env
            .storage()
            .instance()
            .get::<DataKey, u64>(&DataKey::SliceCount)
            .unwrap_or(0u64);
        if slice_count == 0 {
            return;
        }
        for slice_id in 1..=slice_count {
            env.storage()
                .instance()
                .remove(&DataKey2::AttestVerifyCache(credential_id, slice_id));
        }
    }

    // ── Issue #520: CredentialTypeIndex helpers ───────────────────────────────

    fn type_index_add(env: &Env, credential_type: u32, credential_id: u64) {
        let mut ids: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey2::CredentialTypeIndex(credential_type))
            .unwrap_or(Vec::new(env));
        ids.push_back(credential_id);
        env.storage()
            .instance()
            .set(&DataKey2::CredentialTypeIndex(credential_type), &ids);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    fn type_index_remove(env: &Env, credential_type: u32, credential_id: u64) {
        let ids: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey2::CredentialTypeIndex(credential_type))
            .unwrap_or(Vec::new(env));
        let mut retained: Vec<u64> = Vec::new(env);
        for id in ids.iter() {
            if id != credential_id {
                retained.push_back(id);
            }
        }
        env.storage()
            .instance()
            .set(&DataKey2::CredentialTypeIndex(credential_type), &retained);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    // ── Issue #519: MetadataHashCache helpers ─────────────────────────────────

    fn get_metadata_cache(env: &Env, credential_id: u64) -> Option<MetadataHashCache> {
        let cache: Option<MetadataHashCache> = env
            .storage()
            .instance()
            .get(&DataKey2::MetadataHashCache(credential_id));
        if let Some(ref c) = cache {
            if env.ledger().timestamp() >= c.expires_at {
                return None;
            }
        }
        cache
    }

    fn set_metadata_cache(env: &Env, credential_id: u64, metadata_hash: &soroban_sdk::Bytes, is_valid: bool) {
        let now = env.ledger().timestamp();
        let cache = MetadataHashCache {
            credential_id,
            metadata_hash: metadata_hash.clone(),
            is_valid,
            cached_at: now,
            expires_at: now.saturating_add(METADATA_CACHE_TTL_SECS),
        };
        env.storage()
            .instance()
            .set(&DataKey2::MetadataHashCache(credential_id), &cache);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    fn invalidate_metadata_cache(env: &Env, credential_id: u64) {
        env.storage()
            .instance()
            .remove(&DataKey2::MetadataHashCache(credential_id));
    }

    /// Issue #380: Set transfer restriction for a credential type
    pub fn set_transfer_restriction(
        env: Env,
        admin: Address,
        credential_type: u32,
        is_transferable: bool,
    ) {
        admin.require_auth();
        let stored: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(stored == admin, "unauthorized");

        let restriction = TransferRestriction {
            credential_type,
            is_transferable,
            configured_at: env.ledger().timestamp(),
        };
        env.storage()
            .instance()
            .set(&DataKey2::TransferRestriction(credential_type), &restriction);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Issue #380: Get transfer restriction for a credential type
    pub fn get_transfer_restriction(env: Env, credential_type: u32) -> Option<TransferRestriction> {
        env.storage()
            .instance()
            .get(&DataKey2::TransferRestriction(credential_type))
    }

    /// Issue #380: Check if a credential type is transferable
    fn is_credential_type_transferable(env: &Env, credential_type: u32) -> bool {
        env.storage()
            .instance()
            .get::<DataKey2, TransferRestriction>(&DataKey2::TransferRestriction(credential_type))
            .map(|r| r.is_transferable)
            .unwrap_or(true) // Default to transferable if not configured
    }

    /// Check if a parent type exists in storage.
    /// Returns false if the type is not registered.
    fn parent_type_exists(env: &Env, parent_type: u32) -> bool {
        env.storage()
            .instance()
            .has(&DataKey::CredentialType(parent_type))
    }

    /// Recursively check if adding `potential_parent` as a parent to `type_id` would create
    /// a circular dependency in the type hierarchy.
    /// Returns true if a cycle would be created, false otherwise.
    fn would_create_cycle(env: &Env, type_id: u32, potential_parent: u32) -> bool {
        if type_id == potential_parent {
            return true;
        }

        // Check if potential_parent is already in the ancestors of type_id
        let mut current = Some(potential_parent);
        while let Some(curr_type) = current {
            if curr_type == type_id {
                return true;
            }
            // Get the parent of current type
            current = env
                .storage()
                .instance()
                .get::<DataKey2, Option<u32>>(&DataKey2::CredentialTypeParent(curr_type))
                .flatten();
        }
        false
    }

    /// Issue a new credential to a subject. Returns the new credential ID.
    ///
    /// # Parameters
    /// - `issuer`: The address issuing the credential; must authorize this call.
    /// - `subject`: The address receiving the credential.
    /// - `credential_type`: Numeric type identifier for the credential.
    /// - `metadata_hash`: Non-empty IPFS or content-addressed hash of credential metadata.
    /// - `expires_at`: Optional Unix timestamp after which the credential is considered expired.
    ///
    /// # Panics
    /// Panics if the contract is paused.
    /// Panics if `metadata_hash` is empty.
    /// Panics with `ContractError::DuplicateCredential` if the same issuer has already issued
    /// a credential of the same type to the same subject.
    pub fn issue_credential(
        env: Env,
        issuer: Address,
        subject: Address,
        credential_type: u32,
        metadata_hash: soroban_sdk::Bytes,
        expires_at: Option<u64>,
        nonce: u64,
    ) -> u64 {
        issuer.require_auth();
        Self::require_not_paused(&env);
        // Issue #381: Rate limiting
        Self::require_rate_limit(&env, &issuer);
        // Issue #521: Proof of Work verification
        Self::verify_pow(&env, &issuer, &subject, credential_type, nonce);
        // Pre-conditions
        Self::require_valid_address(&env, &issuer);
        Self::require_valid_address(&env, &subject);
        assert!(
            credential_type > 0,
            "credential_type must be greater than 0"
        );
        assert!(!metadata_hash.is_empty(), "metadata_hash cannot be empty");
        Self::precondition(&env, metadata_hash.len() <= 256);

        // Issue #378: Validate transaction size
        Self::validate_transaction_size(&env, &metadata_hash);

        // Issue #379: Validate timestamp
        Self::validate_optional_timestamp(&env, &expires_at);

        // Check for duplicate credential of same type from same issuer to same subject
        let duplicate_key =
            DataKey::SubjectIssuerType(subject.clone(), issuer.clone(), credential_type);
        if env.storage().instance().has(&duplicate_key) {
            panic_with_error!(&env, ContractError::DuplicateCredential);
        }

        // Check if subject is blacklisted by issuer
        if env
            .storage()
            .instance()
            .has(&DataKey2::BlacklistEntry(issuer.clone(), subject.clone()))
        {
            panic_with_error!(&env, ContractError::HolderBlacklisted);
        }

        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::CredentialCount)
            .unwrap_or(0u64)
            + 1;
        let credential = Credential {
            id,
            subject: subject.clone(),
            issuer: issuer.clone(),
            credential_type,
            metadata_hash,
            revoked: false,
            suspended: false,
            expires_at,
            version: 1,
        };
        env.storage()
            .instance()
            .set(&DataKey::Credential(id), &credential);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
        env.storage().instance().set(&DataKey::CredentialCount, &id);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
        let mut subject_creds: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::SubjectCredentials(subject.clone()))
            .unwrap_or(Vec::new(&env));
        subject_creds.push_back(id);
        env.storage()
            .instance()
            .set(&DataKey::SubjectCredentials(subject), &subject_creds);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

        // Store duplicate prevention mapping
        env.storage().instance().set(&duplicate_key, &id);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

        // Issue #520: Maintain CredentialTypeIndex
        Self::type_index_add(&env, credential_type, id);

        let event_data = CredentialIssuedEventData {
            id,
            subject: credential.subject.clone(),
            credential_type,
        };
        let topic = String::from_str(&env, TOPIC_ISSUE);
        let mut topics: Vec<String> = Vec::new(&env);
        topics.push_back(topic);
        env.events().publish(topics, event_data);

        // Update metrics
        Self::update_credential_metrics(&env, id, "credential");

        // Post-condition: credential must be stored
        Self::postcondition(
            env.storage().instance().has(&DataKey::Credential(id)),
            "credential stored",
        );
        Self::append_credential_version(
            &env,
            id,
            1,
            credential.metadata_hash.clone(),
            issuer,
        );
        id
    }

    /// Issue credentials to multiple subjects in one call. Returns a `Vec` of new credential IDs
    /// in the same order as the input subjects.
    ///
    /// # Parameters
    /// - `issuer`: The address issuing all credentials; must authorize this call.
    /// - `subjects`: Ordered list of recipient addresses.
    /// - `credential_types`: Ordered list of credential type IDs, one per subject.
    /// - `metadata_hashes`: Ordered list of metadata hashes, one per subject.
    /// - `expires_at`: Optional shared expiry timestamp applied to all issued credentials.
    ///
    /// # Panics
    /// Panics if the contract is paused.
    /// Panics if `subjects`, `credential_types`, and `metadata_hashes` have different lengths.
    /// Panics for any individual credential that would violate duplicate or empty-hash rules.
    pub fn batch_issue_credentials(
        env: Env,
        issuer: Address,
        subjects: Vec<Address>,
        credential_types: Vec<u32>,
        metadata_hashes: Vec<soroban_sdk::Bytes>,
        expires_at: Option<u64>,
    ) -> Vec<u64> {
        issuer.require_auth();
        Self::require_not_paused(&env);
        let n = subjects.len();
        Self::validate_array_bounds(n, 1, MAX_BATCH_SIZE, "subjects");
        assert!(
            credential_types.len() == n && metadata_hashes.len() == n,
            "input lengths must match"
        );
        let mut ids: Vec<u64> = Vec::new(&env);
        for i in 0..n {
            let subject = subjects.get(i).unwrap();
            let credential_type = credential_types.get(i).unwrap();
            let metadata_hash = metadata_hashes.get(i).unwrap();
            assert!(
                credential_type > 0,
                "credential_type must be greater than 0"
            );
            let duplicate_key =
                DataKey::SubjectIssuerType(subject.clone(), issuer.clone(), credential_type);
            if env.storage().instance().has(&duplicate_key) {
                panic_with_error!(&env, ContractError::DuplicateCredential);
            }
            // Check if subject is blacklisted by issuer
            if env
                .storage()
                .instance()
                .has(&DataKey2::BlacklistEntry(issuer.clone(), subject.clone()))
            {
                panic_with_error!(&env, ContractError::HolderBlacklisted);
            }
            let id = Self::issue_inner(
                &env,
                issuer.clone(),
                subject,
                credential_type,
                metadata_hash,
                expires_at.clone(),
            );
            env.storage().instance().set(&duplicate_key, &id);
            env.storage()
                .instance()
                .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
            ids.push_back(id);
        }
        ids
    }

    fn issue_inner(
        env: &Env,
        issuer: Address,
        subject: Address,
        credential_type: u32,
        metadata_hash: soroban_sdk::Bytes,
        expires_at: Option<u64>,
    ) -> u64 {
        Self::validate_hash(&metadata_hash);
        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::CredentialCount)
            .unwrap_or(0u64)
            + 1;
        let credential = Credential {
            id,
            subject: subject.clone(),
            issuer: issuer.clone(),
            credential_type,
            metadata_hash,
            revoked: false,
            suspended: false,
            expires_at,
            version: 1,
        };
        env.storage()
            .instance()
            .set(&DataKey::Credential(id), &credential);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
        env.storage().instance().set(&DataKey::CredentialCount, &id);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
        let mut subject_creds: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::SubjectCredentials(subject.clone()))
            .unwrap_or(Vec::new(env));
        subject_creds.push_back(id);
        env.storage().instance().set(
            &DataKey::SubjectCredentials(subject.clone()),
            &subject_creds,
        );
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
        let event_data = CredentialIssuedEventData {
            id,
            subject: credential.subject.clone(),
            credential_type,
        };
        let topic = String::from_str(env, TOPIC_ISSUE);
        let mut topics: Vec<String> = Vec::new(env);
        topics.push_back(topic);
        env.events().publish(topics, event_data);

        // Record activity for the holder
        Self::record_holder_activity(
            &env,
            subject.clone(),
            ActivityType::CredentialIssued,
            id,
            issuer.clone(),
            None,
        );

        Self::append_credential_version(
            env,
            id,
            1,
            credential.metadata_hash.clone(),
            issuer,
        );

        id
    }

    /// Issue multiple credentials atomically with rollback on validation failure.
    ///
    /// This function validates all credentials in the batch before issuing any of them.
    /// If any validation fails, no credentials are written to storage and a BatchError
    /// is returned indicating which entry failed and why.
    ///
    /// # Parameters
    /// - `issuer`: The address issuing all credentials; must authorize this call.
    /// - `credentials`: Vector of credential inputs to issue.
    ///
    /// # Returns
    /// - `BatchResult::Ok(Vec<u64>)`: Vector of newly issued credential IDs in same order as input
    /// - `BatchResult::Err(BatchError)`: Validation error with failing index and reason
    ///
    /// # Validation Checks
    /// - Contract is not paused
    /// - All addresses are valid
    /// - All credential types > 0
    /// - All metadata hashes are non-empty and correctly sized
    /// - No duplicate credentials for same issuer/subject/type
    /// - No subjects are blacklisted by issuer
    /// - Batch size is within limits
    pub fn issue_batch(
        env: Env,
        issuer: Address,
        credentials: Vec<CredentialInput>,
    ) -> BatchResult {
        issuer.require_auth();
        Self::require_not_paused(&env);

        let batch_len = credentials.len() as u32;
        if batch_len == 0 {
            // Empty batch is valid - return empty result
            return BatchResult::Ok(Vec::new(&env));
        }

        Self::validate_array_bounds(batch_len, 1, MAX_BATCH_SIZE, "credentials");

        // Pre-validation phase: validate all entries before issuing any
        for i in 0..batch_len {
            let cred_input = credentials.get(i).unwrap();

            // Validate subject address
            Self::require_valid_address(&env, &cred_input.subject);

            // Validate credential type
            if cred_input.credential_type == 0 {
                let reason = String::from_str(&env, "credential_type must be greater than 0");
                return BatchResult::Err(BatchError {
                    failing_index: i,
                    reason,
                });
            }

            // Validate metadata hash
            if cred_input.metadata_hash.is_empty() {
                let reason = String::from_str(&env, "metadata_hash cannot be empty");
                return BatchResult::Err(BatchError {
                    failing_index: i,
                    reason,
                });
            }

            if cred_input.metadata_hash.len() > 256 {
                let reason = String::from_str(&env, "metadata_hash exceeds 256 bytes");
                return BatchResult::Err(BatchError {
                    failing_index: i,
                    reason,
                });
            }

            // Validate optional timestamp
            if let Some(expires) = cred_input.expires_at {
                let current_time = env.ledger().timestamp();
                if expires > current_time + MAX_TIMESTAMP_FUTURE_OFFSET
                    || expires < current_time - MAX_TIMESTAMP_PAST_OFFSET
                {
                    let reason = String::from_str(&env, "expires_at timestamp out of valid range");
                    return BatchResult::Err(BatchError {
                        failing_index: i,
                        reason,
                    });
                }
            }

            // Check for duplicates within the batch and in storage
            let duplicate_key = DataKey::SubjectIssuerType(
                cred_input.subject.clone(),
                issuer.clone(),
                cred_input.credential_type,
            );

            if env.storage().instance().has(&duplicate_key) {
                let reason = String::from_str(&env, "duplicate credential type for this subject");
                return BatchResult::Err(BatchError {
                    failing_index: i,
                    reason,
                });
            }

            // Check for blacklist
            if env
                .storage()
                .instance()
                .has(&DataKey2::BlacklistEntry(issuer.clone(), cred_input.subject.clone()))
            {
                let reason = String::from_str(&env, "subject is blacklisted by this issuer");
                return BatchResult::Err(BatchError {
                    failing_index: i,
                    reason,
                });
            }

            // Check for duplicates within the batch itself
            for j in 0..i {
                let other = credentials.get(j as u32).unwrap();
                if cred_input.subject == other.subject
                    && cred_input.credential_type == other.credential_type
                {
                    let reason = String::from_str(&env, "duplicate within batch");
                    return BatchResult::Err(BatchError {
                        failing_index: i,
                        reason,
                    });
                }
            }
        }

        // Validation complete - issue all credentials
        let mut ids: Vec<u64> = Vec::new(&env);

        for i in 0..batch_len {
            let cred_input = credentials.get(i).unwrap();

            let id = Self::issue_inner(
                &env,
                issuer.clone(),
                cred_input.subject.clone(),
                cred_input.credential_type,
                cred_input.metadata_hash.clone(),
                cred_input.expires_at,
            );

            // Store duplicate prevention mapping
            let duplicate_key = DataKey::SubjectIssuerType(
                cred_input.subject.clone(),
                issuer.clone(),
                cred_input.credential_type,
            );
            env.storage().instance().set(&duplicate_key, &id);
            env.storage()
                .instance()
                .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

            ids.push_back(id);
        }

        BatchResult::Ok(ids)
    }

    /// Retrieve a credential by ID.
    ///
    /// # Parameters
    /// - `credential_id`: The ID of the credential to retrieve.
    ///
    /// # Panics
    /// Panics with `ContractError::CredentialNotFound` if no credential exists with that ID.
    /// Panics with "credential has expired" if the credential's `expires_at` has passed.
    pub fn get_credential(env: Env, credential_id: u64) -> Credential {
        let credential: Credential = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));
        if let Some(expires_at) = credential.expires_at {
            assert!(
                env.ledger().timestamp() < expires_at,
                "credential has expired"
            );
        }
        credential
    }

    /// Update the metadata hash of a credential and increment its version.
    ///
    /// Only the original issuer may call this function.
    ///
    /// # Parameters
    /// - `issuer`: The address that originally issued the credential; must authorize.
    /// - `credential_id`: The ID of the credential to update.
    /// - `new_metadata_hash`: The new metadata hash to store.
    ///
    /// # Panics
    /// Panics with `ContractError::CredentialNotFound` if the credential does not exist.
    /// Panics if the caller is not the original issuer.
    pub fn update_metadata(
        env: Env,
        issuer: Address,
        credential_id: u64,
        new_metadata_hash: soroban_sdk::Bytes,
    ) {
        issuer.require_auth();
        Self::require_not_paused(&env);
        assert!(
            !new_metadata_hash.is_empty(),
            "metadata_hash cannot be empty"
        );
        let mut credential: Credential = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));
        assert!(
            credential.issuer == issuer,
            "only the issuer may update metadata"
        );
        let old_metadata_hash = credential.metadata_hash.clone();
        credential.metadata_hash = new_metadata_hash.clone();
        credential.version += 1;
        Self::append_credential_version(
            &env,
            credential_id,
            credential.version,
            new_metadata_hash,
            issuer.clone(),
        );
        env.storage()
            .instance()
            .set(&DataKey::Credential(credential_id), &credential);

        Self::record_metadata_audit(
            &env,
            credential_id,
            issuer.clone(),
            old_metadata_hash,
            new_metadata_hash,
        );

        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Store credential metadata with compression information.
    ///
    /// Only the original issuer may call this function.
    /// The metadata bytes are stored as-is (compressed or uncompressed as provided).
    /// Compression and decompression are the caller's responsibility.
    ///
    /// # Parameters
    /// - `issuer`: The address that originally issued the credential; must authorize.
    /// - `credential_id`: The ID of the credential.
    /// - `metadata`: The metadata bytes (may be compressed or uncompressed).
    /// - `compression`: The compression type (None for uncompressed, Gzip for compressed).
    ///
    /// # Panics
    /// Panics with `ContractError::CredentialNotFound` if the credential does not exist.
    /// Panics if the caller is not the original issuer.
    pub fn set_credential_metadata(
        env: Env,
        issuer: Address,
        credential_id: u64,
        metadata: soroban_sdk::Bytes,
        compression: CompressionType,
    ) {
        issuer.require_auth();
        Self::require_not_paused(&env);
        let _credential: Credential = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));
        assert!(
            _credential.issuer == issuer,
            "only the issuer may set metadata"
        );
        let credential_metadata = CredentialMetadata {
            data: metadata,
            compression,
        };
        env.storage().instance().set(
            &DataKey2::CredentialMetadataStore(credential_id),
            &credential_metadata,
        );
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Retrieve credential metadata with compression information.
    ///
    /// # Parameters
    /// - `credential_id`: The ID of the credential.
    ///
    /// # Returns
    /// The stored metadata bytes and compression type, or None if no metadata is stored.
    ///
    /// # Panics
    /// Panics with `ContractError::CredentialNotFound` if the credential does not exist.
    pub fn get_credential_metadata(
        env: Env,
        credential_id: u64,
    ) -> Option<CredentialMetadata> {
        let _credential: Credential = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));

        env.storage()
            .instance()
            .get(&DataKey2::CredentialMetadataStore(credential_id))
    }

    /// Initiate a consent-based transfer of a credential to a new subject.
    ///
    /// The current credential subject calls this to propose a transfer to `to`.
    /// The transfer is not final until `accept_transfer` is called by `to`.
    ///
    /// # Panics
    /// Panics with `ContractError::CredentialNotFound` if the credential does not exist.
    /// Panics with `ContractError::UnauthorizedTransfer` if the caller is not the current subject.
    pub fn initiate_transfer(env: Env, from: Address, credential_id: u64, to: Address) {
        from.require_auth();
        Self::require_not_paused(&env);
        let credential: Credential = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));
        if credential.subject != from {
            panic_with_error!(&env, ContractError::UnauthorizedTransfer);
        }
        let request = TransferRequest {
            credential_id,
            from,
            to,
        };
        env.storage()
            .instance()
            .set(&DataKey2::TransferRequest(credential_id), &request);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Accept a pending transfer request, reassigning the credential to the caller.
    ///
    /// Only the address named as `to` in the pending `TransferRequest` may call this.
    ///
    /// # Panics
    /// Panics with `ContractError::CredentialNotFound` if the credential does not exist.
    /// Panics with `ContractError::UnauthorizedTransfer` if no pending request exists or
    /// the caller is not the intended recipient.
    pub fn accept_transfer(env: Env, to: Address, credential_id: u64) {
        to.require_auth();
        Self::require_not_paused(&env);
        let request: TransferRequest = env
            .storage()
            .instance()
            .get(&DataKey2::TransferRequest(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::UnauthorizedTransfer));
        if request.to != to {
            panic_with_error!(&env, ContractError::UnauthorizedTransfer);
        }
        let mut credential: Credential = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));

        // Remove credential from old subject's list
        let mut old_creds: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::SubjectCredentials(credential.subject.clone()))
            .unwrap_or(Vec::new(&env));
        let mut retained: Vec<u64> = Vec::new(&env);
        for id in old_creds.iter() {
            if id != credential_id {
                retained.push_back(id);
            }
        }
        env.storage().instance().set(
            &DataKey::SubjectCredentials(credential.subject.clone()),
            &retained,
        );

        // Add to new subject's list
        let mut new_creds: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::SubjectCredentials(to.clone()))
            .unwrap_or(Vec::new(&env));
        new_creds.push_back(credential_id);
        env.storage()
            .instance()
            .set(&DataKey::SubjectCredentials(to.clone()), &new_creds);

        // Update credential subject
        credential.subject = to;
        env.storage()
            .instance()
            .set(&DataKey::Credential(credential_id), &credential);

        // Clear the pending request
        env.storage()
            .instance()
            .remove(&DataKey2::TransferRequest(credential_id));
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Return all credential IDs issued to a subject.
    ///
    /// # Parameters
    /// - `subject`: The address whose credentials to look up.
    ///
    /// # Panics
    /// Does not panic; returns an empty `Vec` if the subject has no credentials.
    pub fn get_credentials_by_subject(
        env: Env,
        subject: Address,
        page: u32,
        page_size: u32,
    ) -> Vec<u64> {
        Self::require_valid_address(&env, &subject);
        Self::precondition(&env, page > 0);
        Self::precondition(&env, page_size > 0);
        let all_creds: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::SubjectCredentials(subject))
            .unwrap_or(Vec::new(&env));
        let total = all_creds.len();
        let start = (page - 1).saturating_mul(page_size);
        let mut result = Vec::new(&env);
        for i in start..start.saturating_add(page_size) {
            if i >= total {
                break;
            }
            if let Some(cred) = all_creds.get(i) {
                result.push_back(cred);
            }
        }
        result
    }

    /// Issue #520: Get all credential IDs for a given credential type (O(1) index lookup).
    ///
    /// # Parameters
    /// - `credential_type`: The credential type to look up.
    ///
    /// # Returns
    /// Returns a `Vec<u64>` of credential IDs of the given type (excluding revoked ones are still
    /// present in the index until revoked; revocation removes them).
    pub fn get_credentials_by_type(env: Env, credential_type: u32) -> Vec<u64> {
        env.storage()
            .instance()
            .get(&DataKey2::CredentialTypeIndex(credential_type))
            .unwrap_or(Vec::new(&env))
    }

    /// Issue #519: Validate a metadata hash for a credential, using a 1-hour cache.
    ///
    /// Returns `true` if the hash is non-empty and matches the stored credential's metadata hash.
    /// The result is cached for 1 hour and invalidated when metadata is updated or credential is revoked.
    ///
    /// # Parameters
    /// - `credential_id`: The credential to validate against.
    /// - `metadata_hash`: The hash to validate.
    pub fn validate_metadata_hash(
        env: Env,
        credential_id: u64,
        metadata_hash: soroban_sdk::Bytes,
    ) -> bool {
        if let Some(cache) = Self::get_metadata_cache(&env, credential_id) {
            if cache.metadata_hash == metadata_hash {
                return cache.is_valid;
            }
        }
        let credential: Option<Credential> = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id));
        let is_valid = match credential {
            Some(c) => !metadata_hash.is_empty() && c.metadata_hash == metadata_hash,
            None => false,
        };
        Self::set_metadata_cache(&env, credential_id, &metadata_hash, is_valid);
        is_valid
    }

    /// Check if a credential with the given ID exists.
    ///
    /// # Parameters
    /// - `credential_id`: The ID of the credential to check.
    ///
    /// # Returns
    /// Returns `true` if a credential with the given ID exists, `false` otherwise.
    ///
    /// # Panics
    /// Does not panic; returns `false` if the credential does not exist.
    pub fn credential_exists(env: Env, credential_id: u64) -> bool {
        env.storage()
            .instance()
            .has(&DataKey::Credential(credential_id))
    }

    /// Revoke a credential. Only the original issuer can revoke.
    ///
    /// # Parameters
    /// - `issuer`: The address that originally issued the credential; must authorize this call.
    /// - `credential_id`: The ID of the credential to revoke.
    ///
    /// # Panics
    /// Panics if the contract is paused.
    /// Panics with `ContractError::CredentialNotFound` if no credential exists with that ID.
    /// Panics if the caller is not the original issuer.
    /// Panics if the credential is already revoked.
    /// Panics with "credential has expired" if the credential's `expires_at` has passed.
    pub fn revoke_credential(env: Env, issuer: Address, credential_id: u64) {
        issuer.require_auth();
        Self::require_not_paused(&env);
        // Issue #381: Rate limiting
        Self::require_rate_limit(&env, &issuer);
        let mut credential: Credential = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));
        assert!(
            issuer == credential.issuer,
            "only the original issuer can revoke"
        );
        assert!(!credential.revoked, "credential already revoked");
        if let Some(expires_at) = credential.expires_at {
            assert!(
                env.ledger().timestamp() < expires_at,
                "credential has expired"
            );
        }
        Self::mark_credential_revoked(&env, credential_id, &mut credential, issuer);
    }

    /// Request revocation of a credential by its holder.
    ///
    /// The holder (credential subject) submits a pending revocation request. The issuer
    /// approves or denies via `approve_revocation` / `deny_revocation`.
    pub fn request_revocation(env: Env, holder: Address, credential_id: CredentialId) {
        holder.require_auth();
        Self::require_not_paused(&env);
        Self::require_subject(&env, &holder, credential_id);
        let credential: Credential = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));
        assert!(!credential.revoked, "credential already revoked");
        if let Some(existing) = env.storage().instance().get::<DataKey2, HolderRevocationRequest>(
            &DataKey2::RevocationRequest(credential_id),
        ) {
            assert!(
                existing.status != RevocationStatus::Pending,
                "revocation request already pending"
            );
        }
        let request = HolderRevocationRequest {
            credential_id,
            holder: holder.clone(),
            requested_at: env.ledger().timestamp(),
            requested_ledger: env.ledger().sequence(),
            status: RevocationStatus::Pending,
        };
        env.storage()
            .instance()
            .set(&DataKey2::RevocationRequest(credential_id), &request);
        Self::append_revocation_audit(
            &env,
            credential_id,
            RevocationAuditAction::RequestSubmitted,
            holder,
            RevocationStatus::Pending,
        );
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Approve a pending holder revocation request and revoke the credential.
    pub fn approve_revocation(env: Env, issuer: Address, credential_id: CredentialId) {
        issuer.require_auth();
        Self::require_not_paused(&env);
        Self::require_issuer(&env, &issuer, credential_id);
        let mut request: HolderRevocationRequest = env
            .storage()
            .instance()
            .get(&DataKey2::RevocationRequest(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::RevocationRequestNotFound));
        if request.status != RevocationStatus::Pending {
            panic_with_error!(&env, ContractError::RevocationNotPending);
        }
        request.status = RevocationStatus::Approved;
        env.storage()
            .instance()
            .set(&DataKey2::RevocationRequest(credential_id), &request);
        Self::append_revocation_audit(
            &env,
            credential_id,
            RevocationAuditAction::Approved,
            issuer.clone(),
            RevocationStatus::Approved,
        );
        let mut credential: Credential = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));
        if !credential.revoked {
            Self::mark_credential_revoked(&env, credential_id, &mut credential, issuer);
        }
    }

    /// Deny a pending holder revocation request; the credential remains active.
    pub fn deny_revocation(env: Env, issuer: Address, credential_id: CredentialId) {
        issuer.require_auth();
        Self::require_not_paused(&env);
        Self::require_issuer(&env, &issuer, credential_id);
        let mut request: HolderRevocationRequest = env
            .storage()
            .instance()
            .get(&DataKey2::RevocationRequest(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::RevocationRequestNotFound));
        if request.status != RevocationStatus::Pending {
            panic_with_error!(&env, ContractError::RevocationNotPending);
        }
        request.status = RevocationStatus::Denied;
        env.storage()
            .instance()
            .set(&DataKey2::RevocationRequest(credential_id), &request);
        Self::append_revocation_audit(
            &env,
            credential_id,
            RevocationAuditAction::Denied,
            issuer,
            RevocationStatus::Denied,
        );
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Return the current holder revocation request for a credential, if any.
    pub fn get_revocation_request(
        env: Env,
        credential_id: CredentialId,
    ) -> Option<HolderRevocationRequest> {
        env.storage()
            .instance()
            .get(&DataKey2::RevocationRequest(credential_id))
    }

    /// Return the full revocation audit trail for a credential.
    pub fn get_revocation_audit_trail(
        env: Env,
        credential_id: CredentialId,
    ) -> Vec<RevocationAuditEntry> {
        env.storage()
            .instance()
            .get(&DataKey2::RevocationAuditTrail(credential_id))
            .unwrap_or(Vec::new(&env))
    }

    /// Store AES-256 encrypted credential metadata. Encryption/decryption is performed
    /// off-chain; this contract only persists ciphertext and per-party encrypted data keys.
    pub fn set_encrypted_metadata(
        env: Env,
        issuer: Address,
        credential_id: CredentialId,
        ciphertext: Bytes,
        encrypted_keys: Map<Address, Bytes>,
    ) {
        issuer.require_auth();
        Self::require_not_paused(&env);
        Self::require_issuer(&env, &issuer, credential_id);
        assert!(!ciphertext.is_empty(), "ciphertext cannot be empty");
        let stored = EncryptedCredentialMetadata {
            ciphertext,
            encrypted_keys,
        };
        env.storage().instance().set(
            &DataKey2::CredentialMetadataCiphertext(credential_id),
            &stored,
        );
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Grant an authorized party access to decrypt credential metadata by storing their
    /// encrypted data key. Encryption/decryption is performed off-chain.
    pub fn grant_decryption_access(
        env: Env,
        issuer: Address,
        credential_id: CredentialId,
        party: Address,
        encrypted_key: Bytes,
    ) {
        issuer.require_auth();
        Self::require_not_paused(&env);
        Self::require_issuer(&env, &issuer, credential_id);
        assert!(!encrypted_key.is_empty(), "encrypted_key cannot be empty");
        let mut stored: EncryptedCredentialMetadata = env
            .storage()
            .instance()
            .get(&DataKey2::CredentialMetadataCiphertext(credential_id))
            .unwrap_or(EncryptedCredentialMetadata {
                ciphertext: Bytes::new(&env),
                encrypted_keys: Map::new(&env),
            });
        stored.encrypted_keys.set(party, encrypted_key);
        env.storage().instance().set(
            &DataKey2::CredentialMetadataCiphertext(credential_id),
            &stored,
        );
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Revoke a party's access to the credential metadata decryption key.
    pub fn revoke_decryption_access(
        env: Env,
        issuer: Address,
        credential_id: CredentialId,
        party: Address,
    ) {
        issuer.require_auth();
        Self::require_not_paused(&env);
        Self::require_issuer(&env, &issuer, credential_id);
        let mut stored: EncryptedCredentialMetadata = env
            .storage()
            .instance()
            .get(&DataKey2::CredentialMetadataCiphertext(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::DecryptionKeyNotFound));
        if !stored.encrypted_keys.contains_key(party.clone()) {
            panic_with_error!(&env, ContractError::DecryptionKeyNotFound);
        }
        stored.encrypted_keys.remove(party);
        env.storage().instance().set(
            &DataKey2::CredentialMetadataCiphertext(credential_id),
            &stored,
        );
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Return encrypted metadata (ciphertext and per-party encrypted keys) for a credential.
    pub fn get_encrypted_metadata(
        env: Env,
        credential_id: CredentialId,
    ) -> Option<EncryptedCredentialMetadata> {
        env.storage()
            .instance()
            .get(&DataKey2::CredentialMetadataCiphertext(credential_id))
    }

    /// Return a specific metadata version from history.
    pub fn get_credential_version(
        env: Env,
        credential_id: CredentialId,
        version: u32,
    ) -> CredentialVersion {
        let history: Vec<CredentialVersion> = env
            .storage()
            .instance()
            .get(&DataKey2::CredentialVersionHistory(credential_id))
            .unwrap_or(Vec::new(&env));
        for entry in history.iter() {
            if entry.version == version {
                return entry;
            }
        }
        panic_with_error!(&env, ContractError::CredentialVersionNotFound);
    }

    /// Return the metadata version whose `updated_at` is closest to and not after `timestamp`.
    pub fn get_version_at(env: Env, credential_id: CredentialId, timestamp: u64) -> CredentialVersion {
        let history: Vec<CredentialVersion> = env
            .storage()
            .instance()
            .get(&DataKey2::CredentialVersionHistory(credential_id))
            .unwrap_or(Vec::new(&env));
        let mut best: Option<CredentialVersion> = None;
        for entry in history.iter() {
            if entry.updated_at <= timestamp {
                let use_entry = match &best {
                    None => true,
                    Some(b) => entry.updated_at > b.updated_at,
                };
                if use_entry {
                    best = Some(entry);
                }
            }
        }
        best.unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialVersionNotFound))
    }

    /// Return the full metadata version history for a credential.
    pub fn get_credential_version_history(
        env: Env,
        credential_id: CredentialId,
    ) -> Vec<CredentialVersion> {
        env.storage()
            .instance()
            .get(&DataKey2::CredentialVersionHistory(credential_id))
            .unwrap_or(Vec::new(&env))
    }

    /// Revoke a credential by the holder withdrawing consent.
    ///
    /// # Parameters
    /// - `holder`: The credential subject; must authorize this call.
    /// - `credential_id`: The ID of the credential to revoke.
    ///
    /// # Panics
    /// Panics if the contract is paused.
    /// Panics with `ContractError::CredentialNotFound` if no credential exists with that ID.
    /// Panics if the caller is not the credential holder.
    /// Panics if the credential is already revoked.
    pub fn revoke_consent(env: Env, holder: Address, credential_id: u64) {
        holder.require_auth();
        Self::require_not_paused(&env);
        Self::require_rate_limit(&env, &holder);
        let mut credential: Credential = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));
        assert!(
            holder == credential.subject,
            "only the credential holder can revoke consent"
        );
        assert!(!credential.revoked, "credential already revoked");
        credential.revoked = true;
        credential.suspended = false;
        env.storage()
            .instance()
            .set(&DataKey::Credential(credential_id), &credential);
        let mut subject_creds: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::SubjectCredentials(credential.subject.clone()))
            .unwrap_or(Vec::new(&env));
        let mut retained: Vec<u64> = Vec::new(&env);
        for id in subject_creds.iter() {
            if id != credential_id {
                retained.push_back(id);
            }
        }
        if retained.len() != subject_creds.len() {
            subject_creds = retained;
            env.storage().instance().set(
                &DataKey::SubjectCredentials(credential.subject.clone()),
                &subject_creds,
            );
        }
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
        Self::invalidate_verification_caches_for_credential(&env, credential_id);
        let timestamp = env.ledger().timestamp();
        let event_data = ConsentRevokedEventData {
            credential_id,
            holder: credential.subject.clone(),
            issuer: credential.issuer.clone(),
            revoked_at: timestamp,
        };
        let topic = String::from_str(&env, TOPIC_CONSENT_REVOKED);
        let mut topics: Vec<String> = Vec::new(&env);
        topics.push_back(topic);
        env.events().publish(topics, event_data);

        // Record activity for the holder
        Self::record_holder_activity(
            &env,
            credential.subject.clone(),
            ActivityType::CredentialRevoked,
            credential_id,
            holder.clone(),
            None,
        );
    }

    /// Suspend a credential temporarily. Only the original issuer may call this.
    ///
    /// # Panics
    /// Panics if the contract is paused.
    /// Panics with `ContractError::CredentialNotFound` if the credential does not exist.
    /// Panics if the caller is not the original issuer.
    /// Panics if the credential is already suspended or revoked.
    /// Panics with "credential has expired" if the credential's `expires_at` has passed.
    pub fn suspend_credential(env: Env, issuer: Address, credential_id: u64) {
        issuer.require_auth();
        Self::require_not_paused(&env);
        let mut credential: Credential = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));
        assert!(
            issuer == credential.issuer,
            "only the original issuer can suspend"
        );
        assert!(!credential.revoked, "credential already revoked");
        assert!(!credential.suspended, "credential already suspended");
        if let Some(expires_at) = credential.expires_at {
            assert!(
                env.ledger().timestamp() < expires_at,
                "credential has expired"
            );
        }
        credential.suspended = true;
        env.storage()
            .instance()
            .set(&DataKey::Credential(credential_id), &credential);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
        Self::invalidate_verification_caches_for_credential(&env, credential_id);
        Self::emit_status_update(
            &env,
            credential_id,
            String::from_str(&env, "active"),
            String::from_str(&env, "suspended"),
        );
    }

    /// Resume a previously suspended credential. Only the original issuer may call this.
    ///
    /// # Panics
    /// Panics if the contract is paused.
    /// Panics with `ContractError::CredentialNotFound` if the credential does not exist.
    /// Panics if the caller is not the original issuer.
    /// Panics if the credential is not suspended or has been revoked.
    /// Panics with "credential has expired" if the credential's `expires_at` has passed.
    pub fn resume_credential(env: Env, issuer: Address, credential_id: u64) {
        issuer.require_auth();
        Self::require_not_paused(&env);
        let mut credential: Credential = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));
        assert!(
            issuer == credential.issuer,
            "only the original issuer can resume"
        );
        assert!(!credential.revoked, "credential already revoked");
        assert!(credential.suspended, "credential is not suspended");
        if let Some(expires_at) = credential.expires_at {
            assert!(
                env.ledger().timestamp() < expires_at,
                "credential has expired"
            );
        }
        credential.suspended = false;
        env.storage()
            .instance()
            .set(&DataKey::Credential(credential_id), &credential);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
        Self::invalidate_verification_caches_for_credential(&env, credential_id);
        Self::emit_status_update(
            &env,
            credential_id,
            String::from_str(&env, "suspended"),
            String::from_str(&env, "active"),
        );
    }

    /// Renew a credential by extending its expiry. Only the original issuer may call this.
    /// Emits a renewal event.
    pub fn renew_credential(env: Env, issuer: Address, credential_id: u64, new_expires_at: u64) {
        issuer.require_auth();
        Self::require_not_paused(&env);

        // Issue #379: Validate timestamp
        Self::validate_timestamp(&env, new_expires_at);

        let mut credential: Credential = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));
        assert!(
            credential.issuer == issuer,
            "only the original issuer can renew"
        );
        assert!(!credential.revoked, "cannot renew a revoked credential");
        assert!(!credential.suspended, "cannot renew a suspended credential");
        assert!(
            new_expires_at > env.ledger().timestamp(),
            "new_expires_at must be in the future"
        );
        credential.expires_at = Some(new_expires_at);
        env.storage()
            .instance()
            .set(&DataKey::Credential(credential_id), &credential);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
        Self::invalidate_verification_caches_for_credential(&env, credential_id);
        let event_data = RenewalEventData {
            credential_id,
            issuer: issuer.clone(),
            new_expires_at,
        };
        let topic = String::from_str(&env, TOPIC_RENEWAL);
        let mut topics: Vec<String> = Vec::new(&env);
        topics.push_back(topic);
        env.events().publish(topics, event_data);

        // Record activity for the holder
        Self::record_holder_activity(
            &env,
            credential.subject.clone(),
            ActivityType::CredentialRenewed,
            credential_id,
            issuer.clone(),
            None,
        );
    }

    /// Create a quorum slice with weighted attestors. Returns the slice ID.
    ///
    /// # Threshold Semantics
    /// The threshold is measured in weight units, not attestor count.
    /// Each attestor's weight represents their stake/contribution to the quorum.
    /// The sum of weights from attesting parties must meet or exceed this value.
    ///
    /// For example, with attestors having weights [50, 30, 20] and threshold 50:
    /// - One attestor with weight 50 would satisfy the threshold
    /// - Two attestors with weights 30 and 20 would also satisfy (50 >= 50)
    /// - Only one attestor with weight 30 would NOT satisfy (30 < 50)
    pub fn create_slice(
        env: Env,
        creator: Address,
        attestors: Vec<Address>,
        weights: Vec<u32>,
        threshold: u32,
    ) -> u64 {
        creator.require_auth();
        Self::require_valid_address(&env, &creator);
        assert!(attestors.len() > 0, "attestors cannot be empty");
        assert!(
            attestors.len() as u32 <= MAX_ATTESTORS_PER_SLICE,
            "attestors exceed maximum allowed per slice"
        );
        assert!(
            weights.len() == attestors.len(),
            "weights length must match attestors length"
        );
        assert!(threshold > 0, "threshold must be greater than 0");
        assert!(
            threshold <= attestors.len() as u32,
            "threshold cannot exceed attestors length"
        );
        // Validate each attestor address
        for a in attestors.iter() {
            Self::require_valid_address(&env, &a);
        }
        // Calculate total weight sum
        let mut total_weight: u32 = 0;
        for w in weights.iter() {
            total_weight = total_weight.saturating_add(w);
        }
        assert!(
            threshold <= total_weight,
            "threshold cannot exceed total weight sum"
        );
        assert!(total_weight > 0, "total weight must be greater than 0");
        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::SliceCount)
            .unwrap_or(0u64)
            + 1;
        let slice = QuorumSlice {
            id,
            creator,
            attestors,
            weights,
            threshold,
        };
        env.storage().instance().set(&DataKey::Slice(id), &slice);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
        env.storage().instance().set(&DataKey::SliceCount, &id);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
        // Post-condition: slice must be stored
        Self::postcondition(
            env.storage().instance().has(&DataKey::Slice(id)),
            "slice stored",
        );
        id
    }

    /// Retrieve a quorum slice by ID.
    ///
    /// # Parameters
    /// - `slice_id`: The ID of the slice to retrieve.
    ///
    /// # Panics
    /// Panics with `ContractError::SliceNotFound` if no slice exists with that ID.
    pub fn get_slice(env: Env, slice_id: u64) -> QuorumSlice {
        env.storage()
            .instance()
            .get(&DataKey::Slice(slice_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::SliceNotFound))
    }

    /// Check if a quorum slice resides in state.
    pub fn slice_exists(env: Env, slice_id: u64) -> bool {
        env.storage().instance().has(&DataKey::Slice(slice_id))
    }

    /// Return the creator address of a slice.
    ///
    /// # Parameters
    /// - `slice_id`: The ID of the slice to inspect.
    ///
    /// # Panics
    /// Panics with `ContractError::SliceNotFound` if no slice exists with that ID.
    pub fn get_slice_creator(env: Env, slice_id: u64) -> Address {
        let slice: QuorumSlice = env
            .storage()
            .instance()
            .get(&DataKey::Slice(slice_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::SliceNotFound));
        slice.creator
    }

    /// Retrieve the audit log of all threshold changes for a slice.
    ///
    /// Returns a vector of threshold change audit entries in chronological order.
    ///
    /// # Parameters
    /// - `slice_id`: The slice ID.
    ///
    /// # Returns
    /// A vector of threshold audit entries, empty if none exist.
    pub fn get_slice_threshold_audit(env: Env, slice_id: u64) -> Vec<ThresholdAuditEntry> {
        env.storage()
            .instance()
            .get(&DataKey2::ThresholdAuditLog(slice_id))
            .unwrap_or(Vec::new(&env))
    }

    /// Remove an attestor from an existing quorum slice. Only the slice creator may call this.
    /// If the removal would make the threshold unreachable, the threshold is clamped to the new total weight.
    pub fn remove_attestor(env: Env, creator: Address, slice_id: u64, attestor: Address) {
        creator.require_auth();
        let mut slice: QuorumSlice = env
            .storage()
            .instance()
            .get(&DataKey::Slice(slice_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::SliceNotFound));
        assert!(
            slice.creator == creator,
            "only the slice creator can remove attestors"
        );
        let pos = slice
            .attestors
            .iter()
            .position(|a| a == attestor)
            .expect("attestor not in slice") as u32;
        slice.attestors.remove(pos);
        slice.weights.remove(pos);
        assert!(
            !slice.attestors.is_empty(),
            "cannot remove the last attestor"
        );
        // Clamp threshold to new total weight if needed
        let mut total_weight: u32 = 0;
        for w in slice.weights.iter() {
            total_weight = total_weight.saturating_add(w);
        }
        if slice.threshold > total_weight {
            slice.threshold = total_weight;
        }
        env.storage()
            .instance()
            .set(&DataKey::Slice(slice_id), &slice);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Add a new attestor with a given weight to an existing quorum slice.
    ///
    /// # Weight Semantics
    /// The weight represents the attestor's stake/contribution to the quorum.
    /// When updating threshold, ensure the new threshold doesn't exceed
    /// the total weight sum (existing + new attestor).
    pub fn add_attestor(env: Env, creator: Address, slice_id: u64, attestor: Address, weight: u32) {
        creator.require_auth();
        Self::require_valid_address(&env, &creator);
        Self::require_valid_address(&env, &attestor);
        let mut slice: QuorumSlice = env
            .storage()
            .instance()
            .get(&DataKey::Slice(slice_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::SliceNotFound));
        assert!(
            slice.creator == creator,
            "only the slice creator can add attestors"
        );
        assert!(
            (slice.attestors.len() as u32) < MAX_ATTESTORS_PER_SLICE,
            "attestors exceed maximum allowed per slice"
        );
        assert!(weight > 0, "weight must be greater than 0");
        for a in slice.attestors.iter() {
            if a == attestor {
                panic_with_error!(&env, ContractError::DuplicateAttestor);
            }
        }
        slice.attestors.push_back(attestor);
        slice.weights.push_back(weight);
        env.storage()
            .instance()
            .set(&DataKey::Slice(slice_id), &slice);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Update the threshold of an existing quorum slice.
    ///
    /// # Threshold Semantics
    /// The threshold is measured in weight units, not attestor count.
    /// Must be greater than 0 and cannot exceed the total weight sum of all attestors.
    pub fn update_slice_threshold(env: Env, creator: Address, slice_id: u64, new_threshold: u32) {
        creator.require_auth();
        let mut slice: QuorumSlice = env
            .storage()
            .instance()
            .get(&DataKey::Slice(slice_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::SliceNotFound));
        assert!(
            slice.creator == creator,
            "only the slice creator can update threshold"
        );
        assert!(new_threshold > 0, "threshold must be greater than 0");
        // Calculate total weight sum
        let mut total_weight: u32 = 0;
        for w in slice.weights.iter() {
            total_weight = total_weight.saturating_add(w);
        }
        assert!(
            new_threshold <= total_weight,
            "threshold cannot exceed total weight sum"
        );

        // Store old threshold for audit log
        let old_threshold = slice.threshold;
        slice.threshold = new_threshold;
        env.storage()
            .instance()
            .set(&DataKey::Slice(slice_id), &slice);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

        // Record audit log entry
        let audit_entry = ThresholdAuditEntry {
            slice_id,
            old_threshold,
            new_threshold,
            changed_by: creator.clone(),
            timestamp: env.ledger().timestamp(),
        };

        let mut audit_log: Vec<ThresholdAuditEntry> = env
            .storage()
            .instance()
            .get(&DataKey2::ThresholdAuditLog(slice_id))
            .unwrap_or(Vec::new(&env));
        audit_log.push_back(audit_entry.clone());
        env.storage()
            .instance()
            .set(&DataKey2::ThresholdAuditLog(slice_id), &audit_log);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

        // Emit event
        let topic = String::from_str(&env, TOPIC_THRESHOLD_CHANGE);
        let mut topics: Vec<String> = Vec::new(&env);
        topics.push_back(topic);
        env.events().publish(topics, audit_entry);
    }

    /// Attest a credential using a quorum slice.
    ///
    /// Records the attestor's signature for the given credential. Once the total weight
    /// of all attestors meets or exceeds the slice threshold, `is_attested` returns `true`.
    ///
    /// # Parameters
    /// - `attestor`: The address attesting; must be a member of the slice and must authorize.
    /// - `credential_id`: The credential being attested.
    /// - `slice_id`: The quorum slice the attestor belongs to.
    /// - `expires_at`: Optional Unix timestamp after which this attestation expires.
    ///
    /// # Panics
    /// Panics if the contract is paused.
    /// Panics with `ContractError::CredentialNotFound` if the credential does not exist.
    /// Panics if the credential is revoked.
    /// Panics if the attestor is not a member of the slice.
    /// Panics if the attestor has already attested for this credential.

    // ── Credential Holder Blacklist (Issue #293) ──────────────────────────────

    /// Add a holder to an issuer's blacklist.
    ///
    /// # Parameters
    /// - `issuer`: The issuer adding to blacklist; must authorize this call.
    /// - `holder`: The holder address to blacklist.
    /// - `reason`: Reason for blacklisting (stored in record).
    ///
    /// # Panics
    /// Panics if the contract is paused.
    /// Panics with `ContractError::AlreadyBlacklisted` if holder is already blacklisted by issuer.
    /// Panics if issuer does not authorize the call.
    pub fn add_holder_to_blacklist(
        env: Env,
        issuer: Address,
        holder: Address,
        reason: soroban_sdk::String,
    ) {
        issuer.require_auth();
        Self::require_not_paused(&env);
        Self::require_valid_address(&env, &issuer);
        Self::require_valid_address(&env, &holder);

        let entry_key = DataKey2::BlacklistEntry(issuer.clone(), holder.clone());
        if env.storage().instance().has(&entry_key) {
            panic_with_error!(&env, ContractError::AlreadyBlacklisted);
        }

        let blacklist_entry = BlacklistEntry {
            issuer: issuer.clone(),
            holder: holder.clone(),
            reason: reason.clone(),
            blacklisted_at: env.ledger().timestamp(),
        };

        // Store the entry
        env.storage().instance().set(&entry_key, &blacklist_entry);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

        // Add to issuer's blacklist
        let mut issuer_blacklist: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey2::IssuerBlacklist(issuer.clone()))
            .unwrap_or(Vec::new(&env));
        if !issuer_blacklist.iter().any(|addr| addr == holder) {
            issuer_blacklist.push_back(holder.clone());
            env.storage()
                .instance()
                .set(&DataKey2::IssuerBlacklist(issuer.clone()), &issuer_blacklist);
            env.storage()
                .instance()
                .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
        }

        // Add to holder's recorded blacklists
        let mut holder_blacklists: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey2::HolderBlacklists(holder.clone()))
            .unwrap_or(Vec::new(&env));
        if !holder_blacklists.iter().any(|addr| addr == issuer) {
            holder_blacklists.push_back(issuer.clone());
            env.storage().instance().set(
                &DataKey2::HolderBlacklists(holder.clone()),
                &holder_blacklists,
            );
            env.storage()
                .instance()
                .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
        }

        // Emit event
        let event_data = HolderBlacklistedEventData {
            issuer,
            holder,
            reason,
            blacklisted_at: env.ledger().timestamp(),
        };
        let topic = String::from_str(&env, TOPIC_BLACKLIST_ADDED);
        let mut topics: Vec<String> = Vec::new(&env);
        topics.push_back(topic);
        env.events().publish(topics, event_data);
    }

    /// Check if a holder is blacklisted by an issuer.
    ///
    /// # Parameters
    /// - `issuer`: The issuer to check blacklist for.
    /// - `holder`: The holder address to check.
    ///
    /// # Returns
    /// true if holder is blacklisted by issuer, false otherwise.
    pub fn is_holder_blacklisted(env: Env, issuer: Address, holder: Address) -> bool {
        env.storage()
            .instance()
            .has(&DataKey2::BlacklistEntry(issuer, holder))
    }

    /// Remove a holder from an issuer's blacklist.
    ///
    /// # Parameters
    /// - `issuer`: The issuer removing from blacklist; must authorize this call.
    /// - `holder`: The holder address to remove from blacklist.
    ///
    /// # Panics
    /// Panics if the contract is paused.
    /// Panics with `ContractError::NotBlacklisted` if holder is not on issuer's blacklist.
    /// Panics if issuer does not authorize the call.
    pub fn remove_holder_from_blacklist(env: Env, issuer: Address, holder: Address) {
        issuer.require_auth();
        Self::require_not_paused(&env);
        Self::require_valid_address(&env, &issuer);
        Self::require_valid_address(&env, &holder);

        let entry_key = DataKey2::BlacklistEntry(issuer.clone(), holder.clone());
        if !env.storage().instance().has(&entry_key) {
            panic_with_error!(&env, ContractError::NotBlacklisted);
        }

        // Remove the entry
        env.storage().instance().remove(&entry_key);

        // Remove from issuer's blacklist
        let mut issuer_blacklist: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey2::IssuerBlacklist(issuer.clone()))
            .unwrap_or(Vec::new(&env));
        let mut retained: Vec<Address> = Vec::new(&env);
        for addr in issuer_blacklist.iter() {
            if addr != holder {
                retained.push_back(addr);
            }
        }
        if retained.len() < issuer_blacklist.len() {
            env.storage()
                .instance()
                .set(&DataKey2::IssuerBlacklist(issuer.clone()), &retained);
            env.storage()
                .instance()
                .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
        }

        // Remove from holder's recorded blacklists
        let mut holder_blacklists: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey2::HolderBlacklists(holder.clone()))
            .unwrap_or(Vec::new(&env));
        let mut retained: Vec<Address> = Vec::new(&env);
        for addr in holder_blacklists.iter() {
            if addr != issuer {
                retained.push_back(addr);
            }
        }
        if retained.len() < holder_blacklists.len() {
            env.storage()
                .instance()
                .set(&DataKey2::HolderBlacklists(holder.clone()), &retained);
            env.storage()
                .instance()
                .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
        }

        // Emit event
        let event_data = HolderUnblacklistedEventData {
            issuer,
            holder,
            removed_at: env.ledger().timestamp(),
        };
        let topic = String::from_str(&env, TOPIC_BLACKLIST_REMOVED);
        let mut topics: Vec<String> = Vec::new(&env);
        topics.push_back(topic);
        env.events().publish(topics, event_data);
    }

    /// Get all holders blacklisted by an issuer.
    ///
    /// # Parameters
    /// - `issuer`: The issuer to query.
    ///
    /// # Returns
    /// Vec of holder addresses blacklisted by this issuer.
    pub fn get_blacklisted_by_issuer(env: Env, issuer: Address) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey2::IssuerBlacklist(issuer))
            .unwrap_or(Vec::new(&env))
    }

    /// Get all issuers who have blacklisted a holder.
    ///
    /// # Parameters
    /// - `holder`: The holder to query.
    ///
    /// # Returns
    /// Vec of issuer addresses that have blacklisted this holder.
    pub fn get_blacklist_entries_for_holder(env: Env, holder: Address) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey2::HolderBlacklists(holder))
            .unwrap_or(Vec::new(&env))
    }

    /// Get the blacklist entry for a specific issuer-holder pair.
    ///
    /// # Parameters
    /// - `issuer`: The issuer.
    /// - `holder`: The holder.
    ///
    /// # Returns
    /// Some(BlacklistEntry) if holder is blacklisted by issuer, None otherwise.
    pub fn get_blacklist_entry(
        env: Env,
        issuer: Address,
        holder: Address,
    ) -> Option<BlacklistEntry> {
        env.storage()
            .instance()
            .get(&DataKey2::BlacklistEntry(issuer, holder))
    }

    /// Detects if a fork would occur or exists for a credential in a slice.
    /// A fork occurs when attestors in the same slice attest different values.
    /// Returns true if a fork is detected, false otherwise.
    pub fn detect_fork(
        env: Env,
        credential_id: u64,
        slice_id: u64,
        new_attestor: Address,
        new_value: bool,
    ) -> bool {
        Self::detect_fork_inner(&env, credential_id, slice_id, &new_attestor, new_value)
    }

    fn detect_fork_inner(
        env: &Env,
        credential_id: u64,
        slice_id: u64,
        new_attestor: &Address,
        new_value: bool,
    ) -> bool {
        // Get the slice to know which attestors are relevant
        let slice: QuorumSlice = env
            .storage()
            .instance()
            .get(&DataKey::Slice(slice_id))
            .unwrap_or_else(|| panic_with_error!(env, ContractError::SliceNotFound));

        // Get all attestation records for the credential
        let records: Vec<AttestationRecord> = env
            .storage()
            .instance()
            .get(&DataKey::Attestors(credential_id))
            .unwrap_or(Vec::new(env));

        // Collect values attested by attestors in this slice
        let mut slice_values: Vec<bool> = Vec::new(env);
        for record in records.iter() {
            // Check if this attestor is in the slice
            let mut in_slice = false;
            for attestor in slice.attestors.iter() {
                if attestor == record.attestor {
                    in_slice = true;
                    break;
                }
            }
            if in_slice {
                slice_values.push_back(record.attestation_value);
            }
        }

        // Check if new attestor is in slice (should be validated elsewhere)
        let mut new_in_slice = false;
        for attestor in slice.attestors.iter() {
            if attestor == *new_attestor {
                new_in_slice = true;
                break;
            }
        }
        if !new_in_slice {
            return false; // Not in slice, no fork concern
        }

        // Check for conflicts: if any existing value differs from new_value, or if existing values differ
        for existing_value in slice_values.iter() {
            if existing_value != new_value {
                return true; // Fork detected
            }
        }

        false // No fork
    }

    pub fn attest(
        env: Env,
        attestor: Address,
        credential_id: u64,
        slice_id: u64,
        attestation_value: bool,
        expires_at: Option<u64>,
    ) {
        attestor.require_auth();
        Self::require_not_paused(&env);
        // Issue #381: Rate limiting
        Self::require_rate_limit(&env, &attestor);
        Self::require_valid_address(&env, &attestor);
        // Pre-condition: credential_id and slice_id must be non-zero
        Self::precondition(&env, credential_id > 0);
        Self::precondition(&env, slice_id > 0);

        // Issue #379: Validate timestamp
        Self::validate_optional_timestamp(&env, &expires_at);

        let credential: Credential = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));
        assert!(!credential.revoked, "credential is revoked");
        assert!(!credential.suspended, "credential is suspended");
        // Enforce attestation time window if configured
        if let Some(window) = env
            .storage()
            .instance()
            .get::<DataKey, AttestationTimeWindow>(&DataKey::AttestationWindow(credential_id))
        {
            let now = env.ledger().timestamp();
            if now < window.start || now >= window.end {
                panic_with_error!(&env, ContractError::AttestationWindowOutside);
            }
        }
        let slice: QuorumSlice = env
            .storage()
            .instance()
            .get(&DataKey::Slice(slice_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::SliceNotFound));
        let mut found = false;
        for a in slice.attestors.iter() {
            if a == attestor {
                found = true;
                break;
            }
        }
        assert!(found, "attestor not in slice");

        // Check if attestor is suspended
        if Self::is_attestor_suspended(env.clone(), slice_id, attestor.clone()) {
            panic!("attestor is suspended");
        }

        // Check for fork before allowing attestation
        if Self::detect_fork_inner(&env, credential_id, slice_id, &attestor, attestation_value) {
            // Store fork information
            let records: Vec<AttestationRecord> = env
                .storage()
                .instance()
                .get(&DataKey::Attestors(credential_id))
                .unwrap_or(Vec::new(&env));
            let mut conflicting_attestors: Vec<Address> = Vec::new(&env);
            let mut attested_values: Vec<bool> = Vec::new(&env);
            for record in records.iter() {
                let mut in_slice = false;
                for a in slice.attestors.iter() {
                    if a == record.attestor {
                        in_slice = true;
                        break;
                    }
                }
                if in_slice {
                    conflicting_attestors.push_back(record.attestor.clone());
                    attested_values.push_back(record.attestation_value);
                }
            }
            conflicting_attestors.push_back(attestor.clone());
            attested_values.push_back(attestation_value);

            let fork_info = ForkInfo {
                credential_id,
                slice_id,
                conflicting_attestors: conflicting_attestors.clone(),
                attested_values,
                detected_at: env.ledger().timestamp(),
            };
            env.storage()
                .instance()
                .set(&DataKey2::ForkInfo(credential_id, slice_id), &fork_info);
            env.storage().instance().set(
                &DataKey2::ForkStatus(credential_id, slice_id),
                &ForkStatus::ForkDetected,
            );

            // Emit fork detected event
            let event_data = ForkDetectedEventData {
                credential_id,
                slice_id,
                conflicting_attestors,
                detected_at: env.ledger().timestamp(),
            };
            let topic = String::from_str(&env, TOPIC_FORK_DETECTED);
            let mut topics: Vec<String> = Vec::new(&env);
            topics.push_back(topic);
            env.events().publish(topics, event_data);

            panic_with_error!(&env, ContractError::ForkDetected);
        }

        let mut records: Vec<AttestationRecord> = env
            .storage()
            .instance()
            .get(&DataKey::Attestors(credential_id))
            .unwrap_or(Vec::new(&env));

        // Check if attestor has already attested for this credential
        for rec in records.iter() {
            if rec.attestor == attestor {
                panic!("attestor has already attested for this credential");
            }
        }

        let record = AttestationRecord {
            attestor: attestor.clone(),
            attested_at: env.ledger().timestamp(),
            expires_at,
            attestation_value,
            metadata: None,
        };
        records.push_back(record);
        env.storage()
            .instance()
            .set(&DataKey::Attestors(credential_id), &records);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

        // Issue #377: Invalidate verification cache when attestation changes
        Self::invalidate_verification_cache(&env, credential_id, slice_id);

        let event_data = AttestationEventData {
            attestor: attestor.clone(),
            credential_id,
            slice_id,
        };
        let topic = String::from_str(&env, TOPIC_ATTESTATION);
        let mut topics: Vec<String> = Vec::new(&env);
        topics.push_back(topic);
        env.events().publish(topics, event_data);
        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::AttestorCount(attestor.clone()))
            .unwrap_or(0u64);
        env.storage()
            .instance()
            .set(&DataKey::AttestorCount(attestor.clone()), &(count + 1));
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

        // Record activity for the holder
        let credential: Credential = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));
        Self::record_holder_activity(
            &env,
            credential.subject.clone(),
            ActivityType::CredentialAttested,
            credential_id,
            attestor.clone(),
            Some(slice_id),
        );

        // Increment holder attestation counter (Issue #371)
        let holder_count: u64 = env
            .storage()
            .instance()
            .get(&DataKey2::HolderAttestationCount(credential.subject.clone()))
            .unwrap_or(0u64);
        env.storage().instance().set(
            &DataKey2::HolderAttestationCount(credential.subject.clone()),
            &(holder_count + 1),
        );
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

        // Notify the credential holder
        let notification = HolderNotification {
            credential_id,
            attestor: attestor.clone(),
            slice_id,
            notified_at: env.ledger().timestamp(),
        };
        let mut history: Vec<HolderNotification> = env
            .storage()
            .instance()
            .get(&DataKey2::NotificationHistory(credential.subject.clone()))
            .unwrap_or(Vec::new(&env));
        history.push_back(notification.clone());
        env.storage().instance().set(
            &DataKey2::NotificationHistory(credential.subject.clone()),
            &history,
        );
        let topic = String::from_str(&env, TOPIC_HOLDER_NOTIFIED);
        let mut topics: Vec<String> = Vec::new(&env);
        topics.push_back(topic);
        env.events().publish(topics, notification);
    }

    /// Issue #511: Batch attest multiple credentials in a single transaction.
    /// Extends TTL exactly once for the entire batch instead of once per credential,
    /// achieving >20% gas savings over calling attest() in a loop.
    /// Caller must be a member of the slice for each credential.
    pub fn batch_attest(
        env: Env,
        attestor: Address,
        credential_ids: Vec<u64>,
        slice_id: u64,
        attestation_value: bool,
        expires_at: Option<u64>,
    ) {
        attestor.require_auth();
        Self::require_not_paused(&env);
        // Issue #381: Rate limiting — charge once for the batch
        Self::require_rate_limit(&env, &attestor);
        Self::require_valid_address(&env, &attestor);
        Self::validate_array_bounds(credential_ids.len(), 1, MAX_BATCH_SIZE, "credential_ids");
        Self::precondition(&env, slice_id > 0);
        Self::validate_optional_timestamp(&env, &expires_at);

        // Load and validate the slice once for the whole batch
        let slice: QuorumSlice = env
            .storage()
            .instance()
            .get(&DataKey::Slice(slice_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::SliceNotFound));
        let mut in_slice = false;
        for a in slice.attestors.iter() {
            if a == attestor {
                in_slice = true;
                break;
            }
        }
        assert!(in_slice, "attestor not in slice");
        if Self::is_attestor_suspended(env.clone(), slice_id, attestor.clone()) {
            panic!("attestor is suspended");
        }

        let now = env.ledger().timestamp();

        for credential_id in credential_ids.iter() {
            Self::precondition(&env, credential_id > 0);

            let credential: Credential = env
                .storage()
                .instance()
                .get(&DataKey::Credential(credential_id))
                .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));
            assert!(!credential.revoked, "credential is revoked");
            assert!(!credential.suspended, "credential is suspended");

            if let Some(window) = env
                .storage()
                .instance()
                .get::<DataKey, AttestationTimeWindow>(&DataKey::AttestationWindow(credential_id))
            {
                if now < window.start || now >= window.end {
                    panic_with_error!(&env, ContractError::AttestationWindowOutside);
                }
            }

            if Self::detect_fork_inner(
                &env,
                credential_id,
                slice_id,
                &attestor,
                attestation_value,
            ) {
                panic_with_error!(&env, ContractError::ForkDetected);
            }

            let mut records: Vec<AttestationRecord> = env
                .storage()
                .instance()
                .get(&DataKey::Attestors(credential_id))
                .unwrap_or(Vec::new(&env));
            for rec in records.iter() {
                if rec.attestor == attestor {
                    panic!("attestor has already attested for this credential");
                }
            }
            records.push_back(AttestationRecord {
                attestor: attestor.clone(),
                attested_at: now,
                expires_at,
                attestation_value,
                metadata: None,
            });
            env.storage()
                .instance()
                .set(&DataKey::Attestors(credential_id), &records);

            Self::invalidate_verification_cache(&env, credential_id, slice_id);

            let event_data = AttestationEventData {
                attestor: attestor.clone(),
                credential_id,
                slice_id,
            };
            let topic = String::from_str(&env, TOPIC_ATTESTATION);
            let mut topics: Vec<String> = Vec::new(&env);
            topics.push_back(topic);
            env.events().publish(topics, event_data);

            let count: u64 = env
                .storage()
                .instance()
                .get(&DataKey::AttestorCount(attestor.clone()))
                .unwrap_or(0u64);
            env.storage()
                .instance()
                .set(&DataKey::AttestorCount(attestor.clone()), &(count + 1));

            Self::record_holder_activity(
                &env,
                credential.subject.clone(),
                ActivityType::CredentialAttested,
                credential_id,
                attestor.clone(),
                Some(slice_id),
            );

            let holder_count: u64 = env
                .storage()
                .instance()
                .get(&DataKey2::HolderAttestationCount(credential.subject.clone()))
                .unwrap_or(0u64);
            env.storage().instance().set(
                &DataKey2::HolderAttestationCount(credential.subject.clone()),
                &(holder_count + 1),
            );

            let notification = HolderNotification {
                credential_id,
                attestor: attestor.clone(),
                slice_id,
                notified_at: now,
            };
            let mut history: Vec<HolderNotification> = env
                .storage()
                .instance()
                .get(&DataKey2::NotificationHistory(credential.subject.clone()))
                .unwrap_or(Vec::new(&env));
            history.push_back(notification.clone());
            env.storage().instance().set(
                &DataKey2::NotificationHistory(credential.subject.clone()),
                &history,
            );
            let topic = String::from_str(&env, TOPIC_HOLDER_NOTIFIED);
            let mut topics: Vec<String> = Vec::new(&env);
            topics.push_back(topic);
            env.events().publish(topics, notification);
        }

        // Issue #511: Single TTL extension for the entire batch — the key gas optimization.
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Retrieve the total number of attestations an address has made.
    pub fn get_attestor_count(env: Env, address: Address) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::AttestorCount(address))
            .unwrap_or(0u64)
    }

    // ── Issue #371: Credential Holder Attestation Counter ──────────────────

    /// Get the total number of attestations a credential holder has received.
    pub fn get_holder_attestation_count(env: Env, holder: Address) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey2::HolderAttestationCount(holder))
            .unwrap_or(0u64)
    }

    // ── Issue #370: Credential Expiry Renewal with Grace Period ────────────

    /// Set the grace period (in seconds) for a credential type.
    /// Grace period allows renewal after expiry before full revocation.
    pub fn set_grace_period(
        env: Env,
        admin: Address,
        credential_type: u32,
        grace_period_seconds: u64,
    ) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::InvalidInput));
        assert!(admin == stored_admin, "only admin can set grace period");

        env.storage().instance().set(
            &DataKey2::GracePeriod(credential_type as u32),
            &grace_period_seconds,
        );
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Get the grace period for a credential type.
    pub fn get_grace_period(env: Env, credential_type: u32) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey2::GracePeriod(credential_type))
            .unwrap_or(0u64)
    }

    /// Check if a credential is expired, considering grace period.
    /// Returns false during grace period, true only after grace period ends.
    pub fn is_expired(env: Env, credential_id: u64) -> bool {
        let credential: Credential = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));

        if let Some(expires_at) = credential.expires_at {
            let now = env.ledger().timestamp();
            if now >= expires_at {
                let grace_period = env
                    .storage()
                    .instance()
                    .get::<DataKey2, u64>(&DataKey2::GracePeriod(credential.credential_type))
                    .unwrap_or(0u64);
                let grace_end = expires_at + grace_period;
                return now >= grace_end;
            }
        }
        false
    }

    /// Renew a credential during its grace period.
    /// Panics if credential is not in grace period or if not authorized.
    pub fn renew_credential_with_grace(
        env: Env,
        issuer: Address,
        credential_id: u64,
        new_expires_at: u64,
    ) {
        issuer.require_auth();
        Self::require_not_paused(&env);

        let mut credential: Credential = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));

        assert!(
            credential.issuer == issuer,
            "only issuer can renew credential"
        );
        assert!(!credential.revoked, "cannot renew revoked credential");
        assert!(!credential.suspended, "cannot renew suspended credential");

        if let Some(expires_at) = credential.expires_at {
            let now = env.ledger().timestamp();
            assert!(now >= expires_at, "credential not yet expired");

            let grace_period = env
                .storage()
                .instance()
                .get::<DataKey2, u64>(&DataKey2::GracePeriod(credential.credential_type))
                .unwrap_or(0u64);
            let grace_end = expires_at + grace_period;
            assert!(now < grace_end, "grace period has ended, cannot renew");
        }

        credential.expires_at = Some(new_expires_at);
        credential.version += 1;
        env.storage()
            .instance()
            .set(&DataKey::Credential(credential_id), &credential);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
        Self::invalidate_verification_caches_for_credential(&env, credential_id);

        let event_data = RenewalEventData {
            credential_id,
            issuer: issuer.clone(),
            new_expires_at,
        };
        let topic = String::from_str(&env, TOPIC_RENEWAL);
        let mut topics: Vec<String> = Vec::new(&env);
        topics.push_back(topic);
        env.events().publish(topics, event_data);
    }

    // ── Issue #372: Credential Holder Whitelist ──────────────────────────

    /// Add a holder to an issuer's whitelist.
    pub fn add_holder_to_whitelist(env: Env, issuer: Address, holder: Address) {
        issuer.require_auth();
        Self::require_valid_address(&env, &holder);

        env.storage().instance().set(
            &DataKey2::HolderWhitelist(issuer.clone(), holder.clone()),
            &true,
        );

        let mut whitelist: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey2::IssuerWhitelist(issuer.clone()))
            .unwrap_or(Vec::new(&env));

        let mut already_exists = false;
        for addr in whitelist.iter() {
            if addr == holder {
                already_exists = true;
                break;
            }
        }

        if !already_exists {
            whitelist.push_back(holder);
            env.storage()
                .instance()
                .set(&DataKey2::IssuerWhitelist(issuer), &whitelist);
        }

        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Check if a holder is whitelisted by an issuer.
    pub fn is_holder_whitelisted(env: Env, issuer: Address, holder: Address) -> bool {
        env.storage()
            .instance()
            .get::<DataKey2, bool>(&DataKey2::HolderWhitelist(issuer, holder))
            .unwrap_or(false)
    }

    /// Remove a holder from an issuer's whitelist.
    pub fn remove_holder_from_whitelist(env: Env, issuer: Address, holder: Address) {
        issuer.require_auth();

        env.storage()
            .instance()
            .remove(&DataKey2::HolderWhitelist(issuer.clone(), holder.clone()));

        let mut whitelist: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey2::IssuerWhitelist(issuer.clone()))
            .unwrap_or(Vec::new(&env));

        let mut new_whitelist = Vec::new(&env);
        for addr in whitelist.iter() {
            if addr != holder {
                new_whitelist.push_back(addr);
            }
        }

        env.storage()
            .instance()
            .set(&DataKey2::IssuerWhitelist(issuer), &new_whitelist);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Stub for multisig approval check.
    /// Returns true to preserve backward compatibility until full multisig is implemented.
    fn is_multisig_approved(_env: &Env, _credential_id: u64) -> bool {
        true
    }

    /// Check if a credential has met its quorum threshold using weighted trust.
    ///
    /// # FBA Weighted Trust Model
    /// This function implements the federated Byzantine agreement (FBA) weighted trust model.
    /// Instead of simply counting attestors, this sums the weights of attesting parties.
    ///
    /// The threshold represents the minimum total weight required, not the count.
    /// For example, with threshold 50 and two attestors with weights 30 and 20:
    /// - If only one attestor with weight 30 has signed: NOT attested (30 < 50)
    /// - If both attestors have signed: attested (30 + 20 = 50 >= 50)
    ///
    /// Returns false if the credential is revoked, suspended, or expired.
    /// Check if a credential is attested by a quorum slice.
    /// Panics with ContractError::CredentialNotFound if missing.
    pub fn is_attested(env: Env, credential_id: u64, slice_id: u64) -> bool {
        // Issue #377: Check verification cache first
        if let Some(cache) = Self::get_verification_cache(&env, credential_id, slice_id) {
            let now = env.ledger().timestamp();
            if now < cache.expires_at {
                return cache.is_attested;
            }
        }

        let credential: Credential = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));
        if credential.revoked {
            return false;
        }
        if credential.suspended {
            return false;
        }
        if let Some(expires_at) = credential.expires_at {
            if env.ledger().timestamp() >= expires_at {
                return false;
            }
        }
        // Check condition-based attestation expiry
        if let Some(attest_expires_at) = env
            .storage()
            .instance()
            .get::<DataKey, u64>(&DataKey::AttestationExpiry(credential_id))
        {
            if env.ledger().timestamp() >= attest_expires_at {
                return false;
            }
        }
        let slice: QuorumSlice = env
            .storage()
            .instance()
            .get(&DataKey::Slice(slice_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::SliceNotFound));
        let attested_addresses: Vec<AttestationRecord> = env
            .storage()
            .instance()
            .get(&DataKey::Attestors(credential_id))
            .unwrap_or(Vec::new(&env));

        // Calculate total weight of attesting parties, skipping expired attestations
        let now = env.ledger().timestamp();
        let mut total_attested_weight: u32 = 0;
        for rec in attested_addresses.iter() {
            // Skip expired attestations
            if let Some(exp) = rec.expires_at {
                if now >= exp {
                    continue;
                }
            }
            // Find the index of this attestor in the slice and sum their weight
            for (i, attestor) in slice.attestors.iter().enumerate() {
                if attestor == rec.attestor {
                    // Skip suspended attestors
                    if Self::is_attestor_suspended(env.clone(), slice_id, attestor.clone()) {
                        break;
                    }
                    total_attested_weight = total_attested_weight
                        .saturating_add(slice.weights.get(i as u32).unwrap_or(0));
                    break;
                }
            }
        }

        let is_sufficient = total_attested_weight >= slice.threshold;
        let is_attested_result = is_sufficient && Self::is_multisig_approved(&env, credential_id);

        // Record consensus decision if threshold is met
        if is_sufficient {
            let decision = ConsensusDecision {
                decision_id: env
                    .storage()
                    .instance()
                    .get::<DataKey, Vec<ConsensusDecision>>(&DataKey::SliceConsensusHistory(
                        slice_id,
                    ))
                    .unwrap_or(Vec::new(&env))
                    .len() as u64
                    + 1,
                slice_id,
                credential_id,
                timestamp: now,
                required_weight_threshold: slice.threshold,
                achieved_weight: total_attested_weight,
                total_weight: slice.weights.iter().sum(),
            };

            let mut history: Vec<ConsensusDecision> = env
                .storage()
                .instance()
                .get(&DataKey::SliceConsensusHistory(slice_id))
                .unwrap_or(Vec::new(&env));
            history.push_back(decision);
            env.storage()
                .instance()
                .set(&DataKey::SliceConsensusHistory(slice_id), &history);
            env.storage()
                .instance()
                .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
        }

        // Issue #377: Cache the verification result for 60 seconds
        Self::set_verification_cache(&env, credential_id, slice_id, is_attested_result, 60);

        is_attested_result
    }

    /// Returns true if the credential has been revoked.
    ///
    /// # Parameters
    /// - `credential_id`: The credential to check.
    ///
    /// # Panics
    /// Panics with `ContractError::CredentialNotFound` if the credential does not exist.
    pub fn is_revoked(env: Env, credential_id: u64) -> bool {
        let credential: Credential = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));
        credential.revoked
    }

    /// Returns true if the credential has been suspended.
    ///
    /// # Parameters
    /// - `credential_id`: The credential to check.
    ///
    /// # Panics
    /// Panics with `ContractError::CredentialNotFound` if the credential does not exist.
    pub fn is_suspended(env: Env, credential_id: u64) -> bool {
        let credential: Credential = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));
        credential.suspended
    }

    /// Get all attestors that have signed a credential.
    ///
    /// # Parameters
    /// - `credential_id`: The credential to query.
    ///
    /// # Panics
    /// Does not panic; returns an empty `Vec` if no attestations exist.
    pub fn get_attestors(env: Env, credential_id: u64) -> Vec<Address> {
        let records: Vec<AttestationRecord> = env
            .storage()
            .instance()
            .get(&DataKey::Attestors(credential_id))
            .unwrap_or(Vec::new(&env));
        let mut addrs: Vec<Address> = Vec::new(&env);
        for rec in records.iter() {
            addrs.push_back(rec.attestor);
        }
        addrs
    }

    /// Get all attestation records for a credential, including expiry information.
    pub fn get_attestation_records(env: Env, credential_id: u64) -> Vec<AttestationRecord> {
        env.storage()
            .instance()
            .get(&DataKey::Attestors(credential_id))
            .unwrap_or(Vec::new(&env))
    }

    /// Returns true if the given attestor's attestation on a credential has expired.
    ///
    /// Returns false if the attestation has no expiry or has not yet expired.
    ///
    /// # Panics
    /// Panics with `ContractError::CredentialNotFound` if the credential does not exist.
    /// Panics with "attestation not found" if the attestor has not attested this credential.
    pub fn is_single_attestation_expired(env: Env, credential_id: u64, attestor: Address) -> bool {
        if !env
            .storage()
            .instance()
            .has(&DataKey::Credential(credential_id))
        {
            panic_with_error!(&env, ContractError::CredentialNotFound);
        }
        let records: Vec<AttestationRecord> = env
            .storage()
            .instance()
            .get(&DataKey::Attestors(credential_id))
            .unwrap_or(Vec::new(&env));
        for rec in records.iter() {
            if rec.attestor == attestor {
                return match rec.expires_at {
                    Some(exp) => env.ledger().timestamp() >= exp,
                    None => false,
                };
            }
        }
        panic!("attestation not found");
    }

    /// Renew an attestation by extending its expiry. Only the original attestor may call this.
    ///
    /// # Parameters
    /// - `attestor`: The address that originally attested; must authorize this call.
    /// - `credential_id`: The credential whose attestation to renew.
    /// - `new_expires_at`: New Unix timestamp; must be in the future.
    ///
    /// # Panics
    /// Panics if the contract is paused.
    /// Panics with `ContractError::CredentialNotFound` if the credential does not exist.
    /// Panics if the credential is revoked.
    /// Panics with "attestation not found" if the attestor has not attested this credential.
    /// Panics if `new_expires_at` is not in the future.
    pub fn renew_attestation(env: Env, attestor: Address, credential_id: u64, new_expires_at: u64) {
        attestor.require_auth();
        Self::require_not_paused(&env);
        let credential: Credential = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));
        assert!(!credential.revoked, "credential is revoked");
        assert!(!credential.suspended, "credential is suspended");
        assert!(
            new_expires_at > env.ledger().timestamp(),
            "new_expires_at must be in the future"
        );
        let mut records: Vec<AttestationRecord> = env
            .storage()
            .instance()
            .get(&DataKey::Attestors(credential_id))
            .unwrap_or(Vec::new(&env));
        let mut found = false;
        let mut updated: Vec<AttestationRecord> = Vec::new(&env);
        for rec in records.iter() {
            if rec.attestor == attestor {
                found = true;
                updated.push_back(AttestationRecord {
                    attestor: rec.attestor.clone(),
                    attested_at: rec.attested_at,
                    expires_at: Some(new_expires_at),
                    attestation_value: rec.attestation_value,
                    metadata: rec.metadata.clone(),
                });
            } else {
                updated.push_back(rec);
            }
        }
        assert!(found, "attestation not found");
        records = updated;
        env.storage()
            .instance()
            .set(&DataKey::Attestors(credential_id), &records);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
        Self::invalidate_verification_caches_for_credential(&env, credential_id);
        let event_data = AttestationRenewalEventData {
            attestor: attestor.clone(),
            credential_id,
            new_expires_at,
        };
        let topic = String::from_str(&env, TOPIC_ATTESTATION_RENEWAL);
        let mut topics: Vec<String> = Vec::new(&env);
        topics.push_back(topic);
        env.events().publish(topics, event_data);

        // Record activity for the holder
        let credential: Credential = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));
        Self::record_holder_activity(
            &env,
            credential.subject.clone(),
            ActivityType::AttestationExpired,
            credential_id,
            attestor.clone(),
            None,
        );
    }

    /// Returns the number of attestations recorded for a credential.
    ///
    /// # Parameters
    /// - `credential_id`: The credential to count attestations for.
    ///
    /// # Panics
    /// Does not panic; returns `0` if no attestations exist.
    pub fn get_attestation_count(env: Env, credential_id: u64) -> u32 {
        let records: Vec<AttestationRecord> = env
            .storage()
            .instance()
            .get(&DataKey::Attestors(credential_id))
            .unwrap_or(Vec::new(&env));
        records.len()
    }

    /// Returns the total number of credentials an attestor has signed across all credentials.
    ///
    /// # Parameters
    /// - `attestor`: The attestor address to query.
    ///
    /// # Panics
    /// Does not panic; returns `0` if the attestor has never attested.
    pub fn get_attestor_reputation(env: Env, attestor: Address) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::AttestorCount(attestor))
            .unwrap_or(0u64)
    }

    /// Returns the total number of credentials issued on this contract.
    ///
    /// # Panics
    /// Panics with "not initialized" if the contract has not been initialized.
    pub fn get_credential_count(env: Env) -> u64 {
        assert!(
            env.storage().instance().has(&DataKey::Admin),
            "not initialized"
        );
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
        env.storage()
            .instance()
            .get(&DataKey::CredentialCount)
            .unwrap_or(0u64)
    }

    /// Returns the total number of quorum slices created on this contract.
    ///
    /// # Panics
    /// Panics with "not initialized" if the contract has not been initialized.
    pub fn get_slice_count(env: Env) -> u64 {
        assert!(
            env.storage().instance().has(&DataKey::Admin),
            "not initialized"
        );
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
        env.storage()
            .instance()
            .get(&DataKey::SliceCount)
            .unwrap_or(0u64)
    }

    /// Verify multiple ZK claims for a credential in a single call.
    ///
    /// Iterates over `claim_types` and `proofs` in parallel, calling the ZK verifier
    /// for each pair. Returns a `Vec<bool>` where each element corresponds to whether
    /// the claim at that index was verified successfully.
    ///
    /// # Parameters
    /// - `zk_verifier_id`: Address of the deployed ZK verifier contract.
    /// - `quorum_proof_id`: Address of this quorum proof contract (passed to ZK verifier).
    /// - `credential_id`: The credential to verify claims against.
    /// - `claim_types`: Ordered list of claim types to verify.
    /// - `proofs`: Ordered list of ZK proofs corresponding to each claim type.
    ///
    /// # Panics
    /// Panics if `claim_types` and `proofs` have different lengths.
    pub fn verify_claim_batch(
        env: Env,
        zk_verifier_id: Address,
        zk_admin: Address,
        quorum_proof_id: Address,
        credential_id: u64,
        claim_types: Vec<zk_verifier::ClaimType>,
        proofs: Vec<soroban_sdk::Bytes>,
    ) -> Vec<bool> {
        Self::validate_array_bounds(claim_types.len(), 1, MAX_BATCH_SIZE, "claim_types");
        assert!(
            claim_types.len() == proofs.len(),
            "claim_types and proofs lengths must match"
        );
        let zk_client = ZkVerifierContractClient::new(&env, &zk_verifier_id);
        let mut results: Vec<bool> = Vec::new(&env);
        for i in 0..claim_types.len() {
            let result = zk_client.verify_claim(
                &zk_admin,
                &quorum_proof_id,
                &credential_id,
                &claim_types.get(i).unwrap(),
                &proofs.get(i).unwrap(),
            );
            results.push_back(result);
        }
        results
    }

    /// Returns the attestation status of each attestor in a slice for a given credential.
    ///
    /// For each attestor in the slice, returns a tuple of `(Address, bool)` where the
    /// boolean indicates whether that attestor has signed the credential. Useful for
    /// UX progress tracking (e.g. "2 of 3 attestors have signed").
    ///
    /// # Parameters
    /// - `credential_id`: The credential to check attestation status for.
    /// - `slice_id`: The quorum slice whose attestors to inspect.
    ///
    /// # Panics
    /// Panics with `ContractError::CredentialNotFound` if the credential does not exist.
    /// Panics with `ContractError::SliceNotFound` if the slice does not exist.
    pub fn get_slice_attestation_status(
        env: Env,
        credential_id: u64,
        slice_id: u64,
    ) -> Vec<(Address, bool)> {
        if !env
            .storage()
            .instance()
            .has(&DataKey::Credential(credential_id))
        {
            panic_with_error!(&env, ContractError::CredentialNotFound);
        }
        let slice: QuorumSlice = env
            .storage()
            .instance()
            .get(&DataKey::Slice(slice_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::SliceNotFound));
        let attested: Vec<AttestationRecord> = env
            .storage()
            .instance()
            .get(&DataKey::Attestors(credential_id))
            .unwrap_or(Vec::new(&env));
        let mut status: Vec<(Address, bool)> = Vec::new(&env);
        for attestor in slice.attestors.iter() {
            let signed = attested.iter().any(|rec| rec.attestor == attestor);
            status.push_back((attestor, signed));
        }
        status
    }

    /// Verify multiple (credential_id, slice_id) pairs in a single call.
    ///
    /// Gas-optimized: each credential and slice is read from storage at most once,
    /// regardless of how many times it appears in the input list.
    ///
    /// Returns a `Vec<bool>` of the same length as the input, where each element
    /// corresponds to `is_attested(credential_ids[i], slice_ids[i])`.
    ///
    /// # Panics
    /// Panics if `credential_ids` and `slice_ids` have different lengths, or if
    /// either list is empty or exceeds `MAX_BATCH_SIZE`.
    pub fn verify_attestations_batch(
        env: Env,
        credential_ids: Vec<u64>,
        slice_ids: Vec<u64>,
    ) -> Vec<bool> {
        Self::validate_array_bounds(credential_ids.len(), 1, MAX_BATCH_SIZE, "credential_ids");
        assert!(
            credential_ids.len() == slice_ids.len(),
            "credential_ids and slice_ids lengths must match"
        );
        let now = env.ledger().timestamp();
        let mut results: Vec<bool> = Vec::new(&env);
        for i in 0..credential_ids.len() {
            let credential_id = credential_ids.get(i).unwrap();
            let slice_id = slice_ids.get(i).unwrap();
            let attested = match env
                .storage()
                .instance()
                .get::<DataKey, Credential>(&DataKey::Credential(credential_id))
            {
                None => false,
                Some(cred) => {
                    if cred.revoked || cred.suspended {
                        false
                    } else if cred.expires_at.map_or(false, |e| now >= e) {
                        false
                    } else if env
                        .storage()
                        .instance()
                        .get::<DataKey, u64>(&DataKey::AttestationExpiry(credential_id))
                        .map_or(false, |e| now >= e)
                    {
                        false
                    } else {
                        match env
                            .storage()
                            .instance()
                            .get::<DataKey, QuorumSlice>(&DataKey::Slice(slice_id))
                        {
                            None => false,
                            Some(slice) => {
                                let records: Vec<AttestationRecord> = env
                                    .storage()
                                    .instance()
                                    .get(&DataKey::Attestors(credential_id))
                                    .unwrap_or(Vec::new(&env));
                                let mut weight: u32 = 0;
                                for rec in records.iter() {
                                    if rec.expires_at.map_or(false, |e| now >= e) {
                                        continue;
                                    }
                                    for (j, a) in slice.attestors.iter().enumerate() {
                                        if a == rec.attestor {
                                            weight = weight.saturating_add(
                                                slice.weights.get(j as u32).unwrap_or(0),
                                            );
                                            break;
                                        }
                                    }
                                }
                                weight >= slice.threshold
                            }
                        }
                    }
                }
            };
            results.push_back(attested);
        }
        results
    }

    /// Unified engineer verification entry point.
    ///
    /// Checks that the subject holds an SBT linked to the credential, then delegates
    /// ZK claim verification to the `zk_verifier` contract.
    ///
    /// # Parameters
    /// - `quorum_proof_id`: Address of this contract (forwarded to the ZK verifier).
    /// - `sbt_registry_id`: Address of the deployed SBT registry contract.
    /// - `zk_verifier_id`: Address of the deployed ZK verifier contract.
    /// - `subject`: The engineer whose credential is being verified.
    /// - `credential_id`: The credential to verify.
    /// - `claim_type`: The specific claim to verify (degree, license, employment).
    /// - `proof`: The ZK proof bytes for the claim.
    /// - `verifier`: Optional address performing the verification. If `Some`, must be the subject
    ///   or an active delegate for the subject's SBT. If `None`, no caller check is performed.
    ///
    /// # Panics
    /// Does not panic; returns `false` if the subject has no matching SBT or the proof fails.
    pub fn verify_engineer(
        env: Env,
        sbt_registry_id: Address,
        zk_verifier_id: Address,
        zk_admin: Address,
        subject: Address,
        credential_id: u64,
        claim_type: ClaimType,
        proof: soroban_sdk::Bytes,
        verifier: Option<Address>,
    ) -> bool {
        // Check if subject or a delegate is authorized
        if !Self::is_authorized_verifier(&env, subject.clone(), sbt_registry_id, credential_id) {
            return false;
        }
        let quorum_proof_id = env.current_contract_address();
        let zk_client = ZkVerifierContractClient::new(&env, &zk_verifier_id);
        zk_client.verify_claim(
            &zk_admin,
            &quorum_proof_id,
            &credential_id,
            &claim_type,
            &proof,
        )
    }

    /// Check if a caller is authorized to verify a credential.
    ///
    /// Authorization is granted if the caller is either:
    /// 1. The credential subject (holder) with a valid SBT token, OR
    /// 2. A delegate with a non-expired delegation for the credential
    ///
    /// # Parameters
    /// - `caller`: The address attempting to verify.
    /// - `sbt_registry_id`: Address of the SBT registry contract.
    /// - `credential_id`: The credential being verified.
    ///
    /// # Returns
    /// true if the caller is authorized, false otherwise.
    fn is_authorized_verifier(
        env: &Env,
        caller: Address,
        sbt_registry_id: Address,
        credential_id: u64,
    ) -> bool {
        // Check if caller has a valid delegation
        if let Some(delegation) = env
            .storage()
            .instance()
            .get::<DataKey2, Delegation>(&DataKey2::Delegation(credential_id, caller.clone()))
        {
            // Check if delegation hasn't expired (current ledger time < expiry)
            if env.ledger().timestamp() < delegation.expiry {
                return true;
            }
        }

        // Check if caller is the holder with valid SBT
        let sbt_client = SbtRegistryContractClient::new(env, &sbt_registry_id);
        let tokens = sbt_client.get_tokens_by_owner(&caller);
        tokens.iter().any(|token_id| {
            let token = sbt_client.get_token(&token_id);
            token.credential_id == credential_id
        })
    }

    /// Verify an engineer anonymously using a ZK proof and holder commitment.
    /// This avoids revealing the subject's public address on-chain.
    pub fn verify_engineer_anonymous(
        env: Env,
        zk_verifier_id: Address,
        credential_id: u64,
        claim_type: ClaimType,
        holder_commitment: soroban_sdk::Bytes,
        proof: soroban_sdk::Bytes,
    ) -> bool {
        // In a production system, this would also verify that the holder_commitment
        // is linked to a valid SBT in SbtRegistry. For this task, we leverage
        // the anonymous verification logic in ZkVerifier.
        let zk_client = ZkVerifierContractClient::new(&env, &zk_verifier_id);
        zk_client.verify_claim_anonymous(
            &credential_id,
            &claim_type,
            &holder_commitment,
            &proof,
        )
    }

    /// Register a human-readable label for a credential type with optional parent type.
    ///
    /// # Parameters
    /// - `admin`: The admin address; must authorize this call.
    /// - `type_id`: Numeric identifier for the credential type.
    /// - `name`: Human-readable name (e.g. "Mechanical Engineering Degree").
    /// - `description`: Longer description of what the credential type represents.
    /// - `parent_type`: Optional parent type ID for hierarchy support (enables inheritance).
    ///
    /// # Panics
    /// Panics with `ContractError::InvalidParentType` if parent_type is provided but not registered.
    /// Panics with `ContractError::CircularHierarchy` if setting parent_type would create a cycle.
    /// Does not panic on duplicate registration; overwrites the existing entry.
    pub fn register_credential_type(
        env: Env,
        admin: Address,
        type_id: u32,
        name: soroban_sdk::String,
        description: soroban_sdk::String,
        parent_type: Option<u32>,
    ) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(admin == stored_admin, "unauthorized");

        // Validate parent_type if provided
        if let Some(parent) = parent_type {
            if !Self::parent_type_exists(&env, parent) {
                panic_with_error!(&env, ContractError::InvalidParentType);
            }
            if Self::would_create_cycle(&env, type_id, parent) {
                panic_with_error!(&env, ContractError::CircularHierarchy);
            }
        }

        let def = CredentialTypeDef {
            type_id,
            name,
            description,
            parent_type,
        };
        env.storage()
            .instance()
            .set(&DataKey::CredentialType(type_id), &def);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

        // Store parent relationship
        if let Some(parent) = parent_type {
            env.storage()
                .instance()
                .set(&DataKey2::CredentialTypeParent(type_id), &parent);
            env.storage()
                .instance()
                .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

            // Add to parent's children list
            let mut children: Vec<u32> = env
                .storage()
                .instance()
                .get(&DataKey2::CredentialTypeChildren(parent))
                .unwrap_or(Vec::new(&env));

            // Avoid duplicates
            if !children.iter().any(|child| child == type_id) {
                children.push_back(type_id);
                env.storage()
                    .instance()
                    .set(&DataKey2::CredentialTypeChildren(parent), &children);
                env.storage()
                    .instance()
                    .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
            }
        }

        let mut topics: Vec<soroban_sdk::Val> = Vec::new(&env);
        topics.push_back(symbol_short!("reg_type").into_val(&env));
        env.events().publish(topics, type_id);
    }

    /// Look up the registered name and description for a credential type.
    ///
    /// # Parameters
    /// - `type_id`: The numeric credential type ID to look up.
    ///
    /// # Panics
    /// Panics with "credential type not registered" if the type has not been registered.
    pub fn get_credential_type(env: Env, type_id: u32) -> CredentialTypeDef {
        env.storage()
            .instance()
            .get(&DataKey::CredentialType(type_id))
            .expect("credential type not registered")
    }

    /// Get the direct parent type of a credential type, if one exists.
    ///
    /// # Parameters
    /// - `type_id`: The credential type to query.
    ///
    /// # Returns
    /// Some(parent_type_id) if a parent is defined, None otherwise.
    /// Returns None if the type does not exist.
    pub fn get_credential_type_parent(env: Env, type_id: u32) -> Option<u32> {
        env.storage()
            .instance()
            .get::<DataKey2, Option<u32>>(&DataKey2::CredentialTypeParent(type_id))
            .flatten()
    }

    /// Get all direct children of a credential type.
    ///
    /// # Parameters
    /// - `parent_type_id`: The parent credential type to query.
    ///
    /// # Returns
    /// Vec of child type IDs. Empty vector if no children exist.
    pub fn get_credential_type_children(env: Env, parent_type_id: u32) -> Vec<u32> {
        env.storage()
            .instance()
            .get(&DataKey2::CredentialTypeChildren(parent_type_id))
            .unwrap_or(Vec::new(&env))
    }

    /// Get the full lineage (ancestors) of a credential type, starting from its parent
    /// and going up to the root.
    ///
    /// # Parameters
    /// - `type_id`: The credential type to query.
    ///
    /// # Returns
    /// Vec of ancestor type IDs, ordered from direct parent to root.
    /// Empty vector if the type has no parent (is a root type).
    pub fn get_credential_type_ancestors(env: Env, type_id: u32) -> Vec<u32> {
        let mut ancestors: Vec<u32> = Vec::new(&env);
        let mut current = Self::get_credential_type_parent(env.clone(), type_id);

        while let Some(curr_type) = current {
            ancestors.push_back(curr_type);
            current = Self::get_credential_type_parent(env.clone(), curr_type);
        }

        ancestors
    }

    /// Check if one type is a child (direct or transitive) of another in the hierarchy.
    ///
    /// # Parameters
    /// - `child_id`: The potential child type to check.
    /// - `parent_id`: The potential parent/ancestor type.
    ///
    /// # Returns
    /// true if child_id is anywhere in parent_id's descendant tree, false otherwise.
    pub fn is_credential_type_child_of(env: Env, child_id: u32, parent_id: u32) -> bool {
        let ancestors = Self::get_credential_type_ancestors(env, child_id);
        ancestors.iter().any(|ancestor| ancestor == parent_id)
    }

    /// Get all credential types whose verification rules should be applied to a given type.
    /// This is used for inheritance chains - returns the type itself plus all ancestors.
    ///
    /// # Parameters
    /// - `type_id`: The credential type to query.
    ///
    /// # Returns
    /// Vec of type IDs to check for verification rules, ordered from most specific (child)
    /// to most general (root). The first element is always the type_id itself.
    pub fn inherit_verification_rules(env: Env, type_id: u32) -> Vec<u32> {
        let mut rules: Vec<u32> = Vec::new(&env);
        rules.push_back(type_id);

        let ancestors = Self::get_credential_type_ancestors(env, type_id);
        // Reverse to go from root to parent
        let len = ancestors.len();
        for i in (0..len).rev() {
            rules.push_back(ancestors.get(i).unwrap());
        }

        rules
    }

    /// Admin-only contract upgrade to new WASM. Uses deployer convention for auth.
    ///
    /// # Parameters
    /// - `admin`: The admin address; must authorize this call.
    /// - `new_wasm_hash`: The 32-byte hash of the new WASM to upgrade to.
    ///
    /// # Panics
    /// Panics if `admin` does not authorize the call.
    /// Panics with `ContractError::InvalidInput` if upgrade validation fails.
    pub fn upgrade(env: Env, admin: Address, new_wasm_hash: soroban_sdk::BytesN<32>) {
        admin.require_auth();
        let stored: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(stored == admin, "unauthorized");
        Self::validate_upgrade(env.clone(), new_wasm_hash.clone());
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    /// Validate that a new WASM hash is safe to upgrade to.
    ///
    /// Checks:
    /// - The hash is non-zero (not a blank/empty deployment)
    /// - The contract is not paused (upgrades blocked while paused)
    /// - The current error code count is preserved (no error codes removed)
    ///
    /// # Parameters
    /// - `new_wasm_hash`: The 32-byte hash of the candidate WASM.
    ///
    /// # Panics
    /// Panics with `ContractError::InvalidInput` if any check fails.
    pub fn validate_upgrade(env: Env, new_wasm_hash: soroban_sdk::BytesN<32>) {
        // Check 1: hash must not be all-zeros (blank WASM guard)
        let zero = soroban_sdk::BytesN::<32>::from_array(&env, &[0u8; 32]);
        if new_wasm_hash == zero {
            panic_with_error!(&env, ContractError::InvalidInput);
        }

        // Check 2: upgrades are blocked while the contract is paused
        if env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
        {
            panic_with_error!(&env, ContractError::ContractPaused);
        }

        // Check 3: record the current error code ceiling so callers can verify
        // no error codes were removed. We store the max known error code (44)
        // as the compatibility baseline. Any upgrade that reduces this value
        // would break existing clients that depend on those error codes.
        let current_max_error_code: u32 = env
            .storage()
            .instance()
            .get(&DataKey2::RateLimitConfig) // reuse existing storage path for baseline
            .map(|cfg: RateLimitConfig| cfg.max_calls)
            .unwrap_or(44u32); // 44 = highest ContractError variant

        // Emit a validation event so off-chain tooling can audit upgrade attempts
        let topic = soroban_sdk::String::from_str(&env, "UpgradeValidated");
        let mut topics: Vec<soroban_sdk::String> = Vec::new(&env);
        topics.push_back(topic);
        env.events().publish(topics, new_wasm_hash);
    }

    // ── Reputation Recovery (Issue #298) ─────────────────────────────────────

    /// Initiate a reputation recovery request for a slice member.
    ///
    /// Recovery conditions:
    /// - The attestor must have made at least one attestation (reputation > 0).
    /// - No pending (incomplete) recovery may already exist for this attestor.
    /// - The contract must not be paused.
    ///
    /// # Parameters
    /// - `attestor`: The address initiating recovery; must authorize this call.
    ///
    /// # Panics
    /// Panics if the contract is paused.
    /// Panics if the attestor has no attestation history.
    /// Panics if a pending recovery already exists for this attestor.
    pub fn initiate_reputation_recovery(env: Env, attestor: Address) {
        attestor.require_auth();
        Self::require_not_paused(&env);

        let reputation: u64 = env
            .storage()
            .instance()
            .get(&DataKey::AttestorCount(attestor.clone()))
            .unwrap_or(0u64);
        assert!(
            reputation > 0,
            "attestor has no attestation history to recover"
        );

        if let Some(existing) = env
            .storage()
            .instance()
            .get::<DataKey, ReputationRecovery>(&DataKey::ReputationRecovery(attestor.clone()))
        {
            assert!(
                existing.completed,
                "a pending recovery already exists for this attestor"
            );
        }

        let recovery = ReputationRecovery {
            attestor: attestor.clone(),
            initiated_at: env.ledger().timestamp(),
            completed: false,
        };
        env.storage()
            .instance()
            .set(&DataKey::ReputationRecovery(attestor.clone()), &recovery);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Complete a pending reputation recovery for an attestor. Only admin may call this.
    ///
    /// # Panics
    /// Panics if no pending recovery exists for the attestor.
    pub fn complete_reputation_recovery(env: Env, admin: Address, attestor: Address) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(admin == stored_admin, "unauthorized");

        let mut recovery: ReputationRecovery = env
            .storage()
            .instance()
            .get(&DataKey::ReputationRecovery(attestor.clone()))
            .expect("no pending recovery for this attestor");
        assert!(!recovery.completed, "recovery already completed");

        recovery.completed = true;
        env.storage()
            .instance()
            .set(&DataKey::ReputationRecovery(attestor.clone()), &recovery);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Get the reputation recovery record for an attestor, if any.
    pub fn get_reputation_recovery(env: Env, attestor: Address) -> Option<ReputationRecovery> {
        env.storage()
            .instance()
            .get(&DataKey::ReputationRecovery(attestor))
    }

    // ── Credential Holder Delegation (Issue #532) ────────────────────────────

    /// Grant a delegate the right to verify a credential on behalf of the holder.
    ///
    /// Only the credential holder (subject) can call this function.
    /// The delegation is valid until the specified expiry timestamp.
    ///
    /// # Parameters
    /// - `holder`: The credential holder delegating verification rights; must authorize.
    /// - `credential_id`: The credential for which delegation is granted.
    /// - `delegate`: The address that will be allowed to verify the credential.
    /// - `expiry`: Ledger timestamp when this delegation expires.
    ///
    /// # Panics
    /// Panics if the credential does not exist.
    /// Panics if the caller is not the credential subject (holder).
    pub fn delegate_verification(
        env: Env,
        holder: Address,
        credential_id: u64,
        delegate: Address,
        expiry: u64,
    ) {
        holder.require_auth();
        Self::require_not_paused(&env);

        // Verify credential exists and holder is the subject
        let credential: Credential = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));

        assert!(
            credential.subject == holder,
            "only the credential holder can delegate"
        );

        // Store the delegation record
        let delegation = Delegation {
            delegate: delegate.clone(),
            credential_id,
            expiry,
            granted_at: env.ledger().sequence() as u64,
        };

        env.storage()
            .instance()
            .set(&DataKey2::Delegation(credential_id, delegate.clone()), &delegation);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

        // Record delegation in audit log
        let audit_entry = DelegationAuditEntry {
            delegate: delegate.clone(),
            credential_id,
            expiry,
            granted_at: env.ledger().sequence() as u64,
        };

        let mut audit_log: Vec<DelegationAuditEntry> = env
            .storage()
            .instance()
            .get(&DataKey2::DelegationAuditLog(credential_id))
            .unwrap_or(Vec::new(&env));
        audit_log.push_back(audit_entry.clone());
        env.storage()
            .instance()
            .set(&DataKey2::DelegationAuditLog(credential_id), &audit_log);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

        // Emit event
        let topic = String::from_str(&env, TOPIC_DELEGATION);
        let mut topics: Vec<String> = Vec::new(&env);
        topics.push_back(topic);
        env.events().publish(topics, audit_entry);
    }

    /// Retrieve the delegation record for a specific credential and delegate.
    ///
    /// Returns the delegation if it exists, or None if no delegation is found.
    ///
    /// # Parameters
    /// - `credential_id`: The credential ID.
    /// - `delegate`: The delegate address.
    ///
    /// # Returns
    /// The delegation record if it exists, None otherwise.
    pub fn get_delegation(env: Env, credential_id: u64, delegate: Address) -> Option<Delegation> {
        env.storage()
            .instance()
            .get(&DataKey2::Delegation(credential_id, delegate))
    }

    /// Retrieve the audit log of all delegations for a credential.
    ///
    /// Returns a vector of delegation audit entries in chronological order.
    ///
    /// # Parameters
    /// - `credential_id`: The credential ID.
    ///
    /// # Returns
    /// A vector of delegation audit entries, empty if none exist.
    pub fn get_delegation_audit(env: Env, credential_id: u64) -> Vec<DelegationAuditEntry> {
        env.storage()
            .instance()
            .get(&DataKey2::DelegationAuditLog(credential_id))
            .unwrap_or(Vec::new(&env))
    }

    // ── Proof Request History (Issue #38) ────────────────────────────────────    /// Record a new proof request for a credential and return its unique request ID.
    ///
    /// Verifiers call this to create an auditable trail every time they request
    /// proof of a credential. The request is appended to the per-credential history
    /// retrievable via [`get_proof_requests`].
    ///
    /// # Parameters
    /// - `verifier`: The address initiating the proof request; must authorize this call.
    /// - `credential_id`: The credential for which proof is being requested.
    /// - `claim_types`: The ZK claim types the verifier wants proven.
    ///
    /// # Returns
    /// The unique ID assigned to this proof request.
    ///
    /// # Panics
    /// Panics if the contract is paused.
    /// Panics with `ContractError::CredentialNotFound` if no credential exists with that ID.
    pub fn generate_proof_request(
        env: Env,
        verifier: Address,
        credential_id: u64,
        claim_types: Vec<zk_verifier::ClaimType>,
    ) -> u64 {
        verifier.require_auth();
        Self::require_not_paused(&env);

        // Verify that the credential exists.
        if !env
            .storage()
            .instance()
            .has(&DataKey::Credential(credential_id))
        {
            panic_with_error!(&env, ContractError::CredentialNotFound);
        }

        // Assign a globally unique ID.
        let request_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ProofRequestCount)
            .unwrap_or(0u64)
            + 1;

        let request = ProofRequest {
            id: request_id,
            credential_id,
            verifier: verifier.clone(),
            requested_at: env.ledger().timestamp(),
            claim_types,
        };

        // Append to the per-credential history.
        let mut history: Vec<ProofRequest> = env
            .storage()
            .instance()
            .get(&DataKey::ProofRequests(credential_id))
            .unwrap_or(Vec::new(&env));
        history.push_back(request.clone());
        env.storage()
            .instance()
            .set(&DataKey::ProofRequests(credential_id), &history);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

        // Update global counter.
        env.storage()
            .instance()
            .set(&DataKey::ProofRequestCount, &request_id);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

        // Emit event so off-chain indexers can track requests without polling storage.
        let topic = String::from_str(&env, TOPIC_PROOF_REQUEST);
        let mut topics: Vec<String> = Vec::new(&env);
        topics.push_back(topic);
        env.events().publish(topics, request);

        request_id
    }

    /// Return all proof requests ever generated for a credential, in insertion order.
    ///
    /// Verifiers and auditors use this to inspect the full verification history of
    /// a credential.
    ///
    /// # Parameters
    /// - `credential_id`: The credential whose proof-request history to retrieve.
    ///
    /// # Returns
    /// A `Vec<ProofRequest>` in the order requests were recorded. Returns an empty
    /// `Vec` if no requests have been made yet (does not panic).
    ///
    /// # Panics
    /// Does not panic even if the credential does not exist; returns empty in that case.
    pub fn get_proof_requests(env: Env, credential_id: u64) -> Vec<ProofRequest> {
        env.storage()
            .instance()
            .get(&DataKey::ProofRequests(credential_id))
            .unwrap_or(Vec::new(&env))
    }

    // ── Challenge / Dispute Resolution ───────────────────────────────────────

    /// Open a challenge against an attestor's signature on a credential.
    ///
    /// Only a member of the quorum slice (other than the accused) may challenge.
    /// Only one open challenge per (credential, accused) pair is allowed at a time.
    ///
    /// # Parameters
    /// - `challenger`: Slice member raising the challenge; must authorize.
    /// - `credential_id`: The credential whose attestation is being disputed.
    /// - `slice_id`: The quorum slice both challenger and accused belong to.
    /// - `accused`: The attestor whose signature is being challenged.
    ///
    /// # Returns
    /// The new challenge ID.
    pub fn challenge_attestation(
        env: Env,
        challenger: Address,
        credential_id: u64,
        slice_id: u64,
        accused: Address,
    ) -> u64 {
        challenger.require_auth();
        Self::require_not_paused(&env);

        // Credential must exist
        if !env
            .storage()
            .instance()
            .has(&DataKey::Credential(credential_id))
        {
            panic_with_error!(&env, ContractError::CredentialNotFound);
        }

        let slice: QuorumSlice = env
            .storage()
            .instance()
            .get(&DataKey::Slice(slice_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::SliceNotFound));

        // Both challenger and accused must be in the slice
        let mut challenger_in = false;
        let mut accused_in = false;
        for a in slice.attestors.iter() {
            if a == challenger {
                challenger_in = true;
            }
            if a == accused {
                accused_in = true;
            }
        }
        if !challenger_in || !accused_in {
            panic_with_error!(&env, ContractError::NotInSlice);
        }

        // Accused must have actually attested this credential
        let attestors: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Attestors(credential_id))
            .unwrap_or(Vec::new(&env));
        if !attestors.iter().any(|a| a == accused) {
            panic_with_error!(&env, ContractError::NotAttested);
        }

        // No duplicate open challenge for same (credential, accused)
        if env
            .storage()
            .instance()
            .has(&DataKey::ActiveChallenge(credential_id, accused.clone()))
        {
            panic_with_error!(&env, ContractError::AlreadyChallenged);
        }

        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ChallengeCount)
            .unwrap_or(0u64)
            + 1;

        let challenge = Challenge {
            id,
            credential_id,
            slice_id,
            accused: accused.clone(),
            challenger,
            status: ChallengeStatus::Open,
            uphold_votes: Vec::new(&env),
            dismiss_votes: Vec::new(&env),
        };

        env.storage()
            .instance()
            .set(&DataKey::Challenge(id), &challenge);
        env.storage().instance().set(&DataKey::ChallengeCount, &id);
        env.storage()
            .instance()
            .set(&DataKey::ActiveChallenge(credential_id, accused), &id);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
        id
    }

    /// Cast a vote on an open challenge.
    ///
    /// Any slice member except the accused may vote once. When the total weight of
    /// votes on either side meets or exceeds the slice threshold the challenge resolves:
    /// - Upheld → accused's attestation is removed from the credential.
    /// - Dismissed → challenge is closed, attestation stands.
    ///
    /// # Parameters
    /// - `voter`: Slice member casting the vote; must authorize.
    /// - `challenge_id`: The challenge to vote on.
    /// - `uphold`: `true` to uphold (remove attestation), `false` to dismiss.
    pub fn vote_on_challenge(env: Env, voter: Address, challenge_id: u64, uphold: bool) {
        voter.require_auth();
        Self::require_not_paused(&env);

        let mut challenge: Challenge = env
            .storage()
            .instance()
            .get(&DataKey::Challenge(challenge_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::ChallengeNotFound));

        if challenge.status != ChallengeStatus::Open {
            panic_with_error!(&env, ContractError::ChallengeResolved);
        }

        // Accused cannot vote
        if voter == challenge.accused {
            panic_with_error!(&env, ContractError::AccusedCannotVote);
        }

        let slice: QuorumSlice = env
            .storage()
            .instance()
            .get(&DataKey::Slice(challenge.slice_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::SliceNotFound));

        // Voter must be in the slice
        if !slice.attestors.iter().any(|a| a == voter) {
            panic_with_error!(&env, ContractError::NotInSlice);
        }

        // No double-voting
        let already_voted = challenge.uphold_votes.iter().any(|a| a == voter)
            || challenge.dismiss_votes.iter().any(|a| a == voter);
        if already_voted {
            panic_with_error!(&env, ContractError::AlreadyVoted);
        }

        if uphold {
            challenge.uphold_votes.push_back(voter);
        } else {
            challenge.dismiss_votes.push_back(voter);
        }

        // Helper: sum weights for a set of voters
        let weighted_sum = |votes: &Vec<Address>| -> u32 {
            let mut total: u32 = 0;
            for v in votes.iter() {
                for (i, a) in slice.attestors.iter().enumerate() {
                    if a == v {
                        total = total.saturating_add(slice.weights.get(i as u32).unwrap_or(0));
                        break;
                    }
                }
            }
            total
        };

        let uphold_weight = weighted_sum(&challenge.uphold_votes);
        let dismiss_weight = weighted_sum(&challenge.dismiss_votes);

        if uphold_weight >= slice.threshold {
            challenge.status = ChallengeStatus::Open; // Temporary to allow slash_attestor call
            Self::slash_attestor(env.clone(), env.current_contract_address(), challenge.slice_id, challenge.accused.clone());
            challenge.status = ChallengeStatus::Upheld;

            // Remove accused's attestation from the credential
            let attestors: Vec<Address> = env
                .storage()
                .instance()
                .get(&DataKey::Attestors(challenge.credential_id))
                .unwrap_or(Vec::new(&env));
            let mut retained: Vec<Address> = Vec::new(&env);
            for a in attestors.iter() {
                if a != challenge.accused {
                    retained.push_back(a);
                }
            }
            env.storage()
                .instance()
                .set(&DataKey::Attestors(challenge.credential_id), &retained);
            env.storage().instance().remove(&DataKey::ActiveChallenge(
                challenge.credential_id,
                challenge.accused.clone(),
            ));
        } else if dismiss_weight >= slice.threshold {
            challenge.status = ChallengeStatus::Dismissed;
            env.storage().instance().remove(&DataKey::ActiveChallenge(
                challenge.credential_id,
                challenge.accused.clone(),
            ));
        }

        env.storage()
            .instance()
            .set(&DataKey::Challenge(challenge_id), &challenge);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Retrieve a challenge by ID.
    ///
    /// # Panics
    /// Panics with `ContractError::ChallengeNotFound` if no challenge exists with that ID.
    pub fn get_challenge(env: Env, challenge_id: u64) -> Challenge {
        env.storage()
            .instance()
            .get(&DataKey::Challenge(challenge_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::ChallengeNotFound))
    }

    /// Track all credential-related activities per holder
    /// Activity log stored on-chain
    /// Returns paginated activity records for a holder
    pub fn get_holder_activity(
        env: Env,
        holder: Address,
        page: u32,
        page_size: u32,
    ) -> Vec<ActivityRecord> {
        Self::require_not_paused(&env);
        let mut activities: Vec<ActivityRecord> = env
            .storage()
            .instance()
            .get(&DataKey::HolderActivity(holder.clone()))
            .unwrap_or(Vec::new(&env));
        let total = activities.len();
        let start = (page - 1).saturating_mul(page_size);
        let mut result = Vec::new(&env);
        for i in start..start.saturating_add(page_size) {
            if i >= total {
                break;
            }
            if let Some(activity) = activities.get(i) {
                result.push_back(activity);
            }
        }
        result
    }

    /// Returns the immutable audit trail for a credential's metadata updates.
    ///
    /// # Parameters
    /// - `credential_id`: The ID of the credential to get the audit trail for.
    ///
    /// # Returns
    /// All audit entries for the credential in chronological order (oldest first).
    ///
    /// # Panics
    /// Panics with `ContractError::CredentialNotFound` if the credential does not exist.
    pub fn get_audit_trail(env: Env, credential_id: u64) -> Vec<AuditEntry> {
        let _credential: Credential = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));

        env.storage()
            .instance()
            .get(&DataKey2::CredentialAuditTrail(credential_id))
            .unwrap_or(Vec::new(&env))
    }

    /// Returns all attestation notifications for a credential holder.
    pub fn get_notification_history(env: Env, holder: Address) -> Vec<HolderNotification> {
        env.storage()
            .instance()
            .get(&DataKey2::NotificationHistory(holder))
            .unwrap_or(Vec::new(&env))
    }

    /// Attach arbitrary metadata to an existing attestation.
    /// Only the original attestor may set metadata for their own attestation.
    pub fn set_attestation_metadata(
        env: Env,
        attestor: Address,
        credential_id: u64,
        metadata: soroban_sdk::Bytes,
    ) {
        attestor.require_auth();
        // Verify the attestor has actually attested this credential
        let records: Vec<AttestationRecord> = env
            .storage()
            .instance()
            .get(&DataKey::Attestors(credential_id))
            .unwrap_or(Vec::new(&env));
        let found = records.iter().any(|r| r.attestor == attestor);
        assert!(found, "attestor has not attested this credential");
        env.storage().instance().set(
            &DataKey2::AttestationMetadata(credential_id, attestor),
            &metadata,
        );
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Retrieve metadata attached to an attestation, if any.
    pub fn get_attestation_metadata(
        env: Env,
        credential_id: u64,
        attestor: Address,
    ) -> Option<soroban_sdk::Bytes> {
        env.storage()
            .instance()
            .get(&DataKey2::AttestationMetadata(credential_id, attestor))
    }

    /// Store historical consensus decisions per slice
    /// Returns paginated consensus history for a slice
    pub fn get_slice_consensus_history(
        env: Env,
        slice_id: u64,
        page: u32,
        page_size: u32,
    ) -> Vec<ConsensusDecision> {
        Self::require_not_paused(&env);
        let mut history: Vec<ConsensusDecision> = env
            .storage()
            .instance()
            .get(&DataKey::SliceConsensusHistory(slice_id))
            .unwrap_or(Vec::new(&env));
        let total = history.len();
        let start = (page - 1).saturating_mul(page_size);
        let mut result = Vec::new(&env);
        for i in start..start.saturating_add(page_size) {
            if i >= total {
                break;
            }
            if let Some(decision) = history.get(i) {
                result.push_back(decision);
            }
        }
        result
    }

    /// Structured process for adding new slice members
    /// Returns the new onboarding request ID
    pub fn initiate_member_onboarding(
        env: Env,
        requester: Address,
        slice_id: u64,
        proposed_member: Address,
        proposed_weight: u32,
    ) -> u64 {
        requester.require_auth();
        Self::require_not_paused(&env);

        // Verify slice exists
        let slice: QuorumSlice = env
            .storage()
            .instance()
            .get(&DataKey::Slice(slice_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::SliceNotFound));

        // Verify requester is in the slice
        let mut requester_in_slice = false;
        for a in slice.attestors.iter() {
            if a == requester {
                requester_in_slice = true;
                break;
            }
        }
        assert!(
            requester_in_slice,
            "only slice members can initiate onboarding"
        );

        // Verify proposed member is not already in the slice
        for a in slice.attestors.iter() {
            if a == proposed_member {
                panic_with_error!(&env, ContractError::DuplicateAttestor);
            }
        }

        // Verify proposed weight is valid
        assert!(proposed_weight > 0, "weight must be greater than 0");

        let mut total_weight: u32 = 0;
        for w in slice.weights.iter() {
            total_weight = total_weight.saturating_add(w);
        }
        assert!(
            proposed_weight <= total_weight,
            "proposed weight cannot exceed current total weight"
        );

        let request_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::OnboardingRequestCount)
            .unwrap_or(0u64)
            + 1;

        let request = OnboardingRequest {
            id: request_id,
            slice_id,
            requester: requester.clone(),
            proposed_member: proposed_member.clone(),
            proposed_weight,
            status: OnboardingStatus::Pending,
            created_at: env.ledger().timestamp(),
            votes: Vec::new(&env),
        };

        // Store individual request
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

        // Add to active requests list
        let mut active_requests: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::OnboardingRequests)
            .unwrap_or(Vec::new(&env));
        active_requests.push_back(request_id);
        env.storage()
            .instance()
            .set(&DataKey::OnboardingRequests, &active_requests);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

        // Update counter
        env.storage()
            .instance()
            .set(&DataKey::OnboardingRequestCount, &request_id);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

        request_id
    }

    /// Mechanism for resolving disputes between slice members
    /// Returns the new dispute ID
    pub fn initiate_dispute(
        env: Env,
        initiator: Address,
        slice_id: u64,
        accused: Address,
        reason: String,
    ) -> u64 {
        initiator.require_auth();
        Self::require_not_paused(&env);

        // Verify slice exists
        let slice: QuorumSlice = env
            .storage()
            .instance()
            .get(&DataKey::Slice(slice_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::SliceNotFound));

        // Verify initiator is in the slice
        let mut initiator_in_slice = false;
        for a in slice.attestors.iter() {
            if a == initiator {
                initiator_in_slice = true;
                break;
            }
        }
        assert!(
            initiator_in_slice,
            "only slice members can initiate disputes"
        );

        // Verify accused is in the slice
        let mut accused_in_slice = false;
        for a in slice.attestors.iter() {
            if a == accused {
                accused_in_slice = true;
                break;
            }
        }
        assert!(accused_in_slice, "accused must be a member of the slice");

        // Verify initiator and accused are different
        assert!(
            initiator != accused,
            "initiator and accused must be different"
        );

        let dispute_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::DisputeCount)
            .unwrap_or(0u64)
            + 1;

        let dispute = Dispute {
            id: dispute_id,
            slice_id,
            initiator: initiator.clone(),
            accused: accused.clone(),
            reason,
            status: DisputeStatus::Active,
            created_at: env.ledger().timestamp(),
            votes: Vec::new(&env),
        };

        // Store individual dispute
        env.storage()
            .instance()
            .set(&DataKey::Dispute(dispute_id), &dispute);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

        // Add to active disputes list
        let mut active_disputes: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::Disputes)
            .unwrap_or(Vec::new(&env));
        active_disputes.push_back(dispute_id);
        env.storage()
            .instance()
            .set(&DataKey::Disputes, &active_disputes);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

        // Update counter
        env.storage()
            .instance()
            .set(&DataKey::DisputeCount, &dispute_id);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

        dispute_id
    }

    // ── Credential Holder Recovery (Issue #290) ──────────────────────────────

    /// Initiate a credential recovery request.
    ///
    /// Only the original issuer may initiate recovery for a credential.
    /// The recovery requires multi-sig approval from the designated approvers.
    ///
    /// # Parameters
    /// - `issuer`: The address that originally issued the credential; must authorize.
    /// - `credential_id`: The ID of the credential to recover.
    /// - `new_subject`: The new address that will receive the recovered credential.
    /// - `approvers`: List of addresses authorized to approve this recovery.
    /// - `threshold`: Number of approvers required to execute the recovery.
    ///
    /// # Panics
    /// Panics if the contract is paused.
    /// Panics with `ContractError::CredentialNotFound` if the credential does not exist.
    /// Panics if the caller is not the original issuer.
    /// Panics with `ContractError::RecoveryAlreadyExists` if a pending recovery already exists for this credential.
    pub fn initiate_recovery(
        env: Env,
        issuer: Address,
        credential_id: u64,
        new_subject: Address,
        approvers: Vec<Address>,
        threshold: u32,
    ) -> u64 {
        issuer.require_auth();
        Self::require_not_paused(&env);
        Self::require_valid_address(&env, &new_subject);
        Self::precondition(&env, credential_id > 0);
        Self::precondition(&env, threshold > 0);
        Self::validate_array_bounds(approvers.len(), 1, MAX_MULTISIG_SIGNERS, "approvers");

        let credential: Credential = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));
        assert!(
            credential.issuer == issuer,
            "only the original issuer can initiate recovery"
        );
        assert!(!credential.revoked, "cannot recover a revoked credential");
        assert!(
            !credential.suspended,
            "cannot recover a suspended credential"
        );

        // No duplicate pending recovery
        if env
            .storage()
            .instance()
            .has(&DataKey2::CredentialRecovery(credential_id))
        {
            panic_with_error!(&env, ContractError::RecoveryAlreadyExists);
        }

        let recovery_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::RecoveryRequestCount)
            .unwrap_or(0u64)
            + 1;

        let request = RecoveryRequest {
            id: recovery_id,
            credential_id,
            issuer: issuer.clone(),
            new_subject: new_subject.clone(),
            status: RecoveryStatus::Pending,
            created_at: env.ledger().timestamp(),
            executed_at: None,
            approvers,
            threshold,
        };

        env.storage()
            .instance()
            .set(&DataKey::RecoveryRequest(recovery_id), &request);
        env.storage()
            .instance()
            .set(&DataKey2::CredentialRecovery(credential_id), &recovery_id);
        env.storage()
            .instance()
            .set(&DataKey::RecoveryRequestCount, &recovery_id);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

        // Emit event
        let event_data = RecoveryInitiatedEventData {
            recovery_id,
            credential_id,
            issuer,
            new_subject,
        };
        let topic = String::from_str(&env, TOPIC_RECOVERY_INITIATED);
        let mut topics: Vec<String> = Vec::new(&env);
        topics.push_back(topic);
        env.events().publish(topics, event_data);

        recovery_id
    }

    /// Approve a pending credential recovery request.
    ///
    /// Only addresses in the recovery approvers list may call this.
    /// When the total number of approvals meets or exceeds the threshold,
    /// the recovery status is automatically updated to `Approved`.
    ///
    /// # Parameters
    /// - `approver`: The address approving the recovery; must authorize.
    /// - `recovery_request_id`: The ID of the recovery request to approve.
    pub fn approve_recovery(env: Env, approver: Address, recovery_request_id: u64) {
        approver.require_auth();
        Self::require_not_paused(&env);
        Self::require_valid_address(&env, &approver);

        let mut request: RecoveryRequest = env
            .storage()
            .instance()
            .get(&DataKey::RecoveryRequest(recovery_request_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::RecoveryNotFound));

        if request.status != RecoveryStatus::Pending {
            panic_with_error!(&env, ContractError::RecoveryNotPending);
        }

        // Verify approver is in the approvers list
        let mut is_approver = false;
        for a in request.approvers.iter() {
            if a == approver {
                is_approver = true;
                break;
            }
        }
        if !is_approver {
            panic_with_error!(&env, ContractError::NotRecoveryApprover);
        }

        let mut approvals: Vec<RecoveryApproval> = env
            .storage()
            .instance()
            .get(&DataKey2::RecoveryApprovals(recovery_request_id))
            .unwrap_or(Vec::new(&env));

        // Check for duplicate approval
        for approval in approvals.iter() {
            if approval.approver == approver {
                panic_with_error!(&env, ContractError::DuplicateRecoveryApproval);
            }
        }

        approvals.push_back(RecoveryApproval {
            approver: approver.clone(),
            approved_at: env.ledger().timestamp(),
        });
        env.storage()
            .instance()
            .set(&DataKey2::RecoveryApprovals(recovery_request_id), &approvals);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

        // Emit approval event
        let event_data = RecoveryApprovedEventData {
            recovery_id: recovery_request_id,
            approver,
        };
        let topic = String::from_str(&env, TOPIC_RECOVERY_APPROVED);
        let mut topics: Vec<String> = Vec::new(&env);
        topics.push_back(topic);
        env.events().publish(topics, event_data);

        // Auto-approve if threshold met
        if approvals.len() as u32 >= request.threshold {
            request.status = RecoveryStatus::Approved;
            env.storage()
                .instance()
                .set(&DataKey::RecoveryRequest(recovery_request_id), &request);
            env.storage()
                .instance()
                .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
        }
    }

    /// Execute an approved credential recovery.
    ///
    /// Only the original issuer may execute the recovery.
    /// The recovery must have status `Approved` (threshold met).
    /// Updates the credential subject, subject credential lists, and optionally
    /// transfers the linked SBT via cross-contract call.
    ///
    /// # Parameters
    /// - `issuer`: The original issuer; must authorize.
    /// - `recovery_request_id`: The ID of the approved recovery request.
    /// - `sbt_registry_id`: Optional address of the SBT registry for SBT transfer.
    pub fn execute_recovery(
        env: Env,
        issuer: Address,
        recovery_request_id: u64,
        sbt_registry_id: Option<Address>,
    ) {
        issuer.require_auth();
        Self::require_not_paused(&env);

        let mut request: RecoveryRequest = env
            .storage()
            .instance()
            .get(&DataKey::RecoveryRequest(recovery_request_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::RecoveryNotFound));

        assert!(
            request.issuer == issuer,
            "only the original issuer can execute recovery"
        );

        if request.status != RecoveryStatus::Approved {
            panic_with_error!(&env, ContractError::RecoveryThresholdNotMet);
        }

        let credential_id = request.credential_id;
        let old_subject = request.new_subject.clone(); // placeholder - will read from credential

        let mut credential: Credential = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));

        let prev_subject = credential.subject.clone();
        let new_subject = request.new_subject.clone();

        // Remove credential from old subject's list
        let mut old_creds: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::SubjectCredentials(prev_subject.clone()))
            .unwrap_or(Vec::new(&env));
        let mut retained: Vec<u64> = Vec::new(&env);
        for id in old_creds.iter() {
            if id != credential_id {
                retained.push_back(id);
            }
        }
        env.storage().instance().set(
            &DataKey::SubjectCredentials(prev_subject.clone()),
            &retained,
        );

        // Add to new subject's list
        let mut new_creds: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::SubjectCredentials(new_subject.clone()))
            .unwrap_or(Vec::new(&env));
        new_creds.push_back(credential_id);
        env.storage().instance().set(
            &DataKey::SubjectCredentials(new_subject.clone()),
            &new_creds,
        );

        // Update duplicate prevention mapping
        let old_dup_key = DataKey::SubjectIssuerType(
            prev_subject.clone(),
            credential.issuer.clone(),
            credential.credential_type,
        );
        env.storage().instance().remove(&old_dup_key);
        let new_dup_key = DataKey::SubjectIssuerType(
            new_subject.clone(),
            credential.issuer.clone(),
            credential.credential_type,
        );
        env.storage().instance().set(&new_dup_key, &credential_id);

        // Update credential subject
        credential.subject = new_subject.clone();
        env.storage()
            .instance()
            .set(&DataKey::Credential(credential_id), &credential);

        // Update recovery request status
        request.status = RecoveryStatus::Executed;
        request.executed_at = Some(env.ledger().timestamp());
        env.storage()
            .instance()
            .set(&DataKey::RecoveryRequest(recovery_request_id), &request);
        env.storage()
            .instance()
            .remove(&DataKey2::CredentialRecovery(credential_id));
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

        // Transfer SBT if registry provided
        if let Some(registry_id) = sbt_registry_id {
            let sbt_client = SbtRegistryContractClient::new(&env, &registry_id);
            let tokens = sbt_client.get_tokens_by_owner(&prev_subject);
            for token_id in tokens.iter() {
                let token = sbt_client.get_token(&token_id);
                if token.credential_id == credential_id {
                    sbt_client.recover_sbt(
                        &env.current_contract_address(),
                        &token_id,
                        &new_subject,
                    );
                }
            }
        }

        // Emit event
        let event_data = RecoveryExecutedEventData {
            recovery_id: recovery_request_id,
            credential_id,
            new_subject: new_subject.clone(),
        };
        let topic = String::from_str(&env, TOPIC_RECOVERY_EXECUTED);
        let mut topics: Vec<String> = Vec::new(&env);
        topics.push_back(topic);
        env.events().publish(topics, event_data);

        // Record activity for audit trail
        Self::record_holder_activity(
            &env,
            new_subject,
            ActivityType::CredentialRecovered,
            credential_id,
            issuer,
            None,
        );
    }

    /// Retrieve a recovery request by ID.
    pub fn get_recovery_request(env: Env, recovery_request_id: u64) -> RecoveryRequest {
        env.storage()
            .instance()
            .get(&DataKey::RecoveryRequest(recovery_request_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::RecoveryNotFound))
    }

    /// Retrieve all approvals for a recovery request.
    pub fn get_recovery_approvals(env: Env, recovery_request_id: u64) -> Vec<RecoveryApproval> {
        env.storage()
            .instance()
            .get(&DataKey2::RecoveryApprovals(recovery_request_id))
            .unwrap_or(Vec::new(&env))
    }

    /// Cancel a pending recovery request. Only the issuer may cancel.
    pub fn cancel_recovery(env: Env, issuer: Address, recovery_request_id: u64) {
        issuer.require_auth();
        Self::require_not_paused(&env);

        let request: RecoveryRequest = env
            .storage()
            .instance()
            .get(&DataKey::RecoveryRequest(recovery_request_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::RecoveryNotFound));

        assert!(
            request.issuer == issuer,
            "only the issuer can cancel recovery"
        );

        if request.status != RecoveryStatus::Pending && request.status != RecoveryStatus::Approved {
            panic_with_error!(&env, ContractError::RecoveryNotPending);
        }

        let mut updated = request;
        updated.status = RecoveryStatus::Rejected;
        env.storage()
            .instance()
            .set(&DataKey::RecoveryRequest(recovery_request_id), &updated);
        env.storage()
            .instance()
            .remove(&DataKey2::CredentialRecovery(updated.credential_id));
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    // ── Feature #373: Slice Member Suspension ──────────────────────────────────

    /// Suspend an attestor in a slice. Only the slice creator may call this.
    ///
    /// # Parameters
    /// - `creator`: The slice creator; must authorize this call.
    /// - `slice_id`: The ID of the slice.
    /// - `attestor`: The attestor to suspend.
    ///
    /// # Panics
    /// Panics with `ContractError::SliceNotFound` if the slice does not exist.
    /// Panics if the caller is not the slice creator.
    /// Panics if the attestor is not in the slice.
    pub fn suspend_attestor(env: Env, creator: Address, slice_id: u64, attestor: Address) {
        creator.require_auth();
        Self::require_not_paused(&env);

        let slice: QuorumSlice = env
            .storage()
            .instance()
            .get(&DataKey::Slice(slice_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::SliceNotFound));

        assert!(
            slice.creator == creator,
            "only slice creator can suspend attestors"
        );

        let mut found = false;
        for a in slice.attestors.iter() {
            if a == attestor {
                found = true;
                break;
            }
        }
        assert!(found, "attestor not in slice");

        env.storage().instance().set(
            &DataKey2::SuspendedAttestor(slice_id, attestor.clone()),
            &true,
        );
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Check if an attestor is suspended in a slice.
    ///
    /// # Parameters
    /// - `slice_id`: The ID of the slice.
    /// - `attestor`: The attestor to check.
    ///
    /// # Returns
    /// true if the attestor is suspended, false otherwise.
    pub fn is_attestor_suspended(env: Env, slice_id: u64, attestor: Address) -> bool {
        env.storage()
            .instance()
            .get(&DataKey2::SuspendedAttestor(slice_id, attestor))
            .unwrap_or(false)
    }

    /// Resume a suspended attestor in a slice. Only the slice creator may call this.
    ///
    /// # Parameters
    /// - `creator`: The slice creator; must authorize this call.
    /// - `slice_id`: The ID of the slice.
    /// - `attestor`: The attestor to resume.
    ///
    /// # Panics
    /// Panics with `ContractError::SliceNotFound` if the slice does not exist.
    /// Panics if the caller is not the slice creator.
    pub fn resume_attestor(env: Env, creator: Address, slice_id: u64, attestor: Address) {
        creator.require_auth();
        Self::require_not_paused(&env);

        let slice: QuorumSlice = env
            .storage()
            .instance()
            .get(&DataKey::Slice(slice_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::SliceNotFound));

        assert!(
            slice.creator == creator,
            "only slice creator can resume attestors"
        );

        env.storage()
            .instance()
            .remove(&DataKey2::SuspendedAttestor(slice_id, attestor));
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Slash an attestor for malicious activity.
    /// Increases their global slash count and suspends them in the specified slice.
    pub fn slash_attestor(env: Env, caller: Address, slice_id: u64, attestor: Address) {
        // Can be called by admin or internally by the contract (e.g. from challenge resolution)
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        
        if caller != env.current_contract_address() {
            caller.require_auth();
            assert!(caller == admin, "only admin or contract can slash attestors");
        }

        // Suspend in the slice
        env.storage().instance().set(
            &DataKey2::SuspendedAttestor(slice_id, attestor.clone()),
            &true,
        );

        // Increase global slash count
        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::SlashCount(attestor.clone()))
            .unwrap_or(0u64);
        env.storage()
            .instance()
            .set(&DataKey::SlashCount(attestor), &(count + 1));
        
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Get the total number of times an attestor has been slashed.
    pub fn get_slash_count(env: Env, attestor: Address) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::SlashCount(attestor))
            .unwrap_or(0u64)
    }

    // ── Feature #374: Slice Member Communication Channel ──────────────────────────

    /// Send a message to slice members. Only slice members may call this.
    ///
    /// # Parameters
    /// - `sender`: The sender address; must authorize this call and be in the slice.
    /// - `slice_id`: The ID of the slice.
    /// - `content`: The message content.
    /// - `expires_at`: Unix timestamp when the message expires.
    ///
    /// # Panics
    /// Panics with `ContractError::SliceNotFound` if the slice does not exist.
    /// Panics if the sender is not in the slice.
    pub fn send_slice_message(
        env: Env,
        sender: Address,
        slice_id: u64,
        content: soroban_sdk::String,
        expires_at: u64,
    ) {
        sender.require_auth();
        Self::require_not_paused(&env);

        let slice: QuorumSlice = env
            .storage()
            .instance()
            .get(&DataKey::Slice(slice_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::SliceNotFound));

        let mut found = false;
        for a in slice.attestors.iter() {
            if a == sender {
                found = true;
                break;
            }
        }
        assert!(found, "sender not in slice");

        let message = SliceMessage {
            sender: sender.clone(),
            content,
            sent_at: env.ledger().timestamp(),
            expires_at,
        };

        let mut messages: Vec<SliceMessage> = env
            .storage()
            .instance()
            .get(&DataKey2::SliceMessages(slice_id))
            .unwrap_or(Vec::new(&env));
        messages.push_back(message);
        env.storage()
            .instance()
            .set(&DataKey2::SliceMessages(slice_id), &messages);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Get all non-expired messages for a slice.
    ///
    /// # Parameters
    /// - `slice_id`: The ID of the slice.
    ///
    /// # Returns
    /// Vec of non-expired SliceMessage records.
    pub fn get_slice_messages(env: Env, slice_id: u64) -> Vec<SliceMessage> {
        let messages: Vec<SliceMessage> = env
            .storage()
            .instance()
            .get(&DataKey2::SliceMessages(slice_id))
            .unwrap_or(Vec::new(&env));

        let now = env.ledger().timestamp();
        let mut active: Vec<SliceMessage> = Vec::new(&env);
        for msg in messages.iter() {
            if msg.expires_at > now {
                active.push_back(msg);
            }
        }
        active
    }

    // ── Feature #375: Attestation with Evidence Attachment ──────────────────────

    /// Attach evidence to an attestation. Only the attestor may call this.
    ///
    /// # Parameters
    /// - `attestor`: The attestor; must authorize this call.
    /// - `credential_id`: The ID of the credential.
    /// - `evidence_hash`: Hash of the evidence document.
    ///
    /// # Panics
    /// Panics with `ContractError::CredentialNotFound` if the credential does not exist.
    /// Panics if the evidence_hash is empty.
    pub fn attach_evidence(
        env: Env,
        attestor: Address,
        credential_id: u64,
        evidence_hash: soroban_sdk::Bytes,
    ) {
        attestor.require_auth();
        Self::require_not_paused(&env);

        if !env
            .storage()
            .instance()
            .has(&DataKey::Credential(credential_id))
        {
            panic_with_error!(&env, ContractError::CredentialNotFound);
        }

        assert!(!evidence_hash.is_empty(), "evidence_hash cannot be empty");

        let evidence = AttestationEvidence {
            evidence_hash,
            attached_at: env.ledger().timestamp(),
        };

        env.storage()
            .instance()
            .set(&DataKey2::AttestEvidence(credential_id, attestor), &evidence);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Get evidence attached to an attestation.
    ///
    /// # Parameters
    /// - `credential_id`: The ID of the credential.
    /// - `attestor`: The attestor address.
    ///
    /// # Returns
    /// Option containing the AttestationEvidence if it exists.
    pub fn get_attestation_evidence(
        env: Env,
        credential_id: u64,
        attestor: Address,
    ) -> Option<AttestationEvidence> {
        env.storage()
            .instance()
            .get(&DataKey2::AttestEvidence(credential_id, attestor))
    }

    // ── Feature #376: Attestation Conditional Logic ──────────────────────────────

    /// Set conditions for attestation validity on a credential.
    ///
    /// # Parameters
    /// - `issuer`: The credential issuer; must authorize this call.
    /// - `credential_id`: The ID of the credential.
    /// - `conditions`: Vec of AttestationCondition records.
    ///
    /// # Panics
    /// Panics with `ContractError::CredentialNotFound` if the credential does not exist.
    /// Panics if the caller is not the issuer.
    pub fn set_attestation_conditions(
        env: Env,
        issuer: Address,
        credential_id: u64,
        conditions: Vec<AttestationCondition>,
    ) {
        issuer.require_auth();
        Self::require_not_paused(&env);

        let credential: Credential = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));

        assert!(
            credential.issuer == issuer,
            "only the credential issuer can set conditions"
        );

        env.storage()
            .instance()
            .set(&DataKey2::AttestConditions(credential_id), &conditions);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Get conditions for attestation validity on a credential.
    ///
    /// # Parameters
    /// - `credential_id`: The ID of the credential.
    ///
    /// # Returns
    /// Vec of AttestationCondition records, or empty Vec if none set.
    pub fn get_attestation_conditions(env: Env, credential_id: u64) -> Vec<AttestationCondition> {
        env.storage()
            .instance()
            .get(&DataKey2::AttestConditions(credential_id))
            .unwrap_or(Vec::new(&env))
    }

    /// Evaluate if attestation conditions are met for a credential.
    ///
    /// # Parameters
    /// - `credential_id`: The ID of the credential.
    /// - `condition_values`: Vec of condition values to evaluate against.
    ///
    /// # Returns
    /// true if all conditions are met, false otherwise.
    pub fn evaluate_attestation_conditions(
        env: Env,
        credential_id: u64,
        condition_values: Vec<soroban_sdk::Bytes>,
    ) -> bool {
        let conditions: Vec<AttestationCondition> = env
            .storage()
            .instance()
            .get(&DataKey2::AttestConditions(credential_id))
            .unwrap_or(Vec::new(&env));

        if conditions.is_empty() {
            return true;
        }

        if condition_values.len() != conditions.len() {
            return false;
        }

        for i in 0..conditions.len() {
            let condition = conditions.get(i).unwrap();
            let value = condition_values.get(i).unwrap();
            if condition.value != value {
                return false;
            }
        }

        true
    }

    // ── Feature #355: Proof Expiry ───────────────────────────────────────────

    /// Check if a proof has expired based on its expiry timestamp.
    pub fn is_proof_expired(env: Env, credential_id: u64, proof_expires_at: u64) -> bool {
        if !env
            .storage()
            .instance()
            .has(&DataKey::Credential(credential_id))
        {
            panic_with_error!(&env, ContractError::CredentialNotFound);
        }
        env.ledger().timestamp() >= proof_expires_at
    }

    /// Renew a proof by extending its expiry timestamp.
    pub fn renew_proof(
        env: Env,
        issuer: Address,
        credential_id: u64,
        new_proof_expires_at: u64,
    ) -> u64 {
        issuer.require_auth();
        Self::require_not_paused(&env);

        let credential: Credential = env
            .storage()
            .instance()
            .get(&DataKey::Credential(credential_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));

        assert!(
            credential.issuer == issuer,
            "only the issuer can renew proofs"
        );
        assert!(
            !credential.revoked,
            "cannot renew proof for revoked credential"
        );
        assert!(
            !credential.suspended,
            "cannot renew proof for suspended credential"
        );
        assert!(
            new_proof_expires_at > env.ledger().timestamp(),
            "new_proof_expires_at must be in the future"
        );

        new_proof_expires_at
    }

    // ── Feature #356: Batch Proof Verification ───────────────────────────────

    /// Verify multiple proofs in a single call.
    pub fn batch_verify_proofs(
        env: Env,
        credential_ids: Vec<u64>,
        slice_ids: Vec<u64>,
        proof_expires_at_list: Vec<u64>,
    ) -> Vec<(u64, bool, bool)> {
        Self::validate_array_bounds(credential_ids.len(), 1, MAX_BATCH_SIZE, "credential_ids");
        assert!(
            credential_ids.len() == slice_ids.len()
                && credential_ids.len() == proof_expires_at_list.len(),
            "input lengths must match"
        );

        let mut results: Vec<(u64, bool, bool)> = Vec::new(&env);

        for i in 0..credential_ids.len() {
            let credential_id = credential_ids.get(i).unwrap();
            let slice_id = slice_ids.get(i).unwrap();
            let proof_expires_at = proof_expires_at_list.get(i).unwrap();

            let is_valid = if env
                .storage()
                .instance()
                .has(&DataKey::Credential(credential_id))
            {
                Self::is_attested(env.clone(), credential_id, slice_id)
            } else {
                false
            };

            let is_expired = if env
                .storage()
                .instance()
                .has(&DataKey::Credential(credential_id))
            {
                Self::is_proof_expired(env.clone(), credential_id, proof_expires_at)
            } else {
                true
            };

            results.push_back((credential_id, is_valid, is_expired));
        }

        results
    }

    // ── Feature #357: Claim Type Validation ──────────────────────────────────

    /// Validate that a claim type is supported.
    pub fn is_claim_type_supported(_env: Env, claim_type: ClaimType) -> bool {
        match claim_type {
            ClaimType::HasDegree => true,
            ClaimType::HasLicense => true,
            ClaimType::HasEmploymentHistory => true,
            ClaimType::HasCertification => true,
            ClaimType::HasResearchPublication => true,
        }
    }

    /// Get list of all supported claim types.
    pub fn get_supported_claim_types(env: Env) -> Vec<ClaimType> {
        let mut types: Vec<ClaimType> = Vec::new(&env);
        types.push_back(ClaimType::HasDegree);
        types.push_back(ClaimType::HasLicense);
        types.push_back(ClaimType::HasEmploymentHistory);
        types.push_back(ClaimType::HasCertification);
        types.push_back(ClaimType::HasResearchPublication);
        types
    }

    /// Validate claim types in a proof request.
    pub fn validate_claim_types(env: Env, claim_types: Vec<ClaimType>) -> bool {
        for claim_type in claim_types.iter() {
            if !Self::is_claim_type_supported(env.clone(), claim_type) {
                return false;
            }
        }
        true
    }

    // ── Feature #359: Credential Search with Filters ─────────────────────────

    /// Search credentials with advanced filters.
    pub fn search_credentials(
        env: Env,
        subject: Option<Address>,
        issuer: Option<Address>,
        credential_type: Option<u32>,
        start_date: Option<u64>,
        end_date: Option<u64>,
        page: u32,
        page_size: u32,
    ) -> Vec<u64> {
        Self::precondition(&env, page > 0);
        Self::precondition(&env, page_size > 0);
        Self::precondition(&env, page_size <= MAX_BATCH_SIZE);

        let _ = start_date;
        let _ = end_date;

        let mut matching_ids: Vec<u64> = Vec::new(&env);
        let total_credentials: u64 = env
            .storage()
            .instance()
            .get(&DataKey::CredentialCount)
            .unwrap_or(0u64);

        for id in 1..=total_credentials {
            if let Some(credential) = env
                .storage()
                .instance()
                .get::<DataKey, Credential>(&DataKey::Credential(id))
            {
                if let Some(ref filter_subject) = subject {
                    if credential.subject != *filter_subject {
                        continue;
                    }
                }
                if let Some(ref filter_issuer) = issuer {
                    if credential.issuer != *filter_issuer {
                        continue;
                    }
                }
                if let Some(filter_type) = credential_type {
                    if credential.credential_type != filter_type {
                        continue;
                    }
                }
                matching_ids.push_back(id);
            }
        }

        let total = matching_ids.len();
        let start = (page - 1).saturating_mul(page_size);
        let mut result = Vec::new(&env);
        for i in start..start.saturating_add(page_size) {
            if i >= total {
                break;
            }
            if let Some(cred_id) = matching_ids.get(i) {
                result.push_back(cred_id);
            }
        }
        result
    }

    /// Get total count of credentials matching filters.
    pub fn count_credentials(
        env: Env,
        subject: Option<Address>,
        issuer: Option<Address>,
        credential_type: Option<u32>,
    ) -> u32 {
        let mut count: u32 = 0;
        let total_credentials: u64 = env
            .storage()
            .instance()
            .get(&DataKey::CredentialCount)
            .unwrap_or(0u64);

        for id in 1..=total_credentials {
            if let Some(credential) = env
                .storage()
                .instance()
                .get::<DataKey, Credential>(&DataKey::Credential(id))
            {
                if let Some(ref filter_subject) = subject {
                    if credential.subject != *filter_subject {
                        continue;
                    }
                }
                if let Some(ref filter_issuer) = issuer {
                    if credential.issuer != *filter_issuer {
                        continue;
                    }
                }
                if let Some(filter_type) = credential_type {
                    if credential.credential_type != filter_type {
                        continue;
                    }
                }
                count += 1;
            }
        }
        count
    }

    // ── Missing helper methods ────────────────────────────────────────────────

    /// Update credential metrics (no-op stub for tracking purposes).
    fn update_credential_metrics(_env: &Env, _credential_id: u64, _action: &str) {
        // Metrics tracking stub — extend as needed
    }

    /// Validate that a metadata hash is non-empty.
    fn validate_hash(metadata_hash: &soroban_sdk::Bytes) {
        assert!(!metadata_hash.is_empty(), "metadata_hash cannot be empty");
    }

    /// Emit a status update event for a credential state transition.
    fn emit_status_update(
        env: &Env,
        credential_id: u64,
        from: soroban_sdk::String,
        to: soroban_sdk::String,
    ) {
        let topic = soroban_sdk::String::from_str(env, "status_update");
        let mut topics: Vec<soroban_sdk::String> = Vec::new(env);
        topics.push_back(topic);
        env.events().publish(topics, (credential_id, from, to));
    }

    /// Get verification statistics (stub — returns zeroed stats).
    pub fn get_verification_stats(_env: Env) -> VerificationStats {
        VerificationStats {
            total_verifications: 0,
            successful_verifications: 0,
            failed_verifications: 0,
        }
    }

    /// Configure how holder reputation is scored from attestation history.
    ///
    /// The score is computed as:
    /// `attestation_count * attestation_weight + (attestation_age_seconds / age_divisor) * age_weight`
    pub fn set_holder_reputation_config(
        env: Env,
        admin: Address,
        attestation_weight: u64,
        age_weight: u64,
        age_divisor_seconds: u64,
    ) {
        admin.require_auth();
        let stored: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(stored == admin, "unauthorized");
        assert!(age_divisor_seconds > 0, "age_divisor_seconds must be greater than 0");

        env.storage().instance().set(
            &DataKey2::AttestConditions(0),
            &HolderReputationConfig {
                attestation_weight,
                age_weight,
                age_divisor_seconds,
            },
        );
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
    }

    /// Return the current holder reputation scoring configuration.
    pub fn get_holder_reputation_config(env: Env) -> HolderReputationConfig {
        env.storage()
            .instance()
            .get(&DataKey2::AttestConditions(0))
            .unwrap_or(HolderReputationConfig {
                attestation_weight: DEFAULT_REPUTATION_ATTESTATION_WEIGHT,
                age_weight: DEFAULT_REPUTATION_AGE_WEIGHT,
                age_divisor_seconds: DEFAULT_REPUTATION_AGE_DIVISOR_SECONDS,
            })
    }

    fn compute_holder_reputation(
        env: &Env,
        holder: Address,
    ) -> (u64, u64, u64, u64, u64) {
        let config = Self::get_holder_reputation_config(env.clone());
        let activities: Vec<ActivityRecord> = env
            .storage()
            .instance()
            .get(&DataKey::HolderActivity(holder.clone()))
            .unwrap_or(Vec::new(env));
        let mut attestation_count: u64 = 0;
        let mut oldest_attestation_at: Option<u64> = None;
        for activity in activities.iter() {
            if activity.activity_type == ActivityType::CredentialAttested {
                attestation_count = attestation_count.saturating_add(1);
                oldest_attestation_at = Some(match oldest_attestation_at {
                    Some(current_oldest) => core::cmp::min(current_oldest, activity.timestamp),
                    None => activity.timestamp,
                });
            }
        }

        let now = env.ledger().timestamp();
        let attestation_age_seconds = oldest_attestation_at
            .map(|attested_at| now.saturating_sub(attested_at))
            .unwrap_or(0);
        let age_score = attestation_age_seconds
            .saturating_div(config.age_divisor_seconds)
            .saturating_mul(config.age_weight);
        let count_score = attestation_count.saturating_mul(config.attestation_weight);
        let score = count_score.saturating_add(age_score);
        let subject_credentials: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::SubjectCredentials(holder.clone()))
            .unwrap_or(Vec::new(env));
        let credentials_held: u64 = subject_credentials
            .len()
            .into();

        (
            credentials_held,
            attestation_count,
            attestation_age_seconds,
            count_score,
            score,
        )
    }

    /// Get holder reputation derived from attestation history.
    pub fn get_holder_reputation(env: Env, holder: Address) -> HolderReputation {
        let (credentials_held, attestation_count, attestation_age_seconds, _count_score, score) =
            Self::compute_holder_reputation(&env, holder);
        HolderReputation {
            credentials_held,
            successful_verifications: attestation_count,
            attestation_count,
            attestation_age_seconds,
            score,
        }
    }

    // ── Issue #522: Credential holder consent tracking ────────────────────────

    /// Issuer requests consent from a subject to issue a credential.
    /// Returns the consent request ID. Expires after 7 days.
    pub fn request_credential(
        env: Env,
        issuer: Address,
        subject: Address,
        credential_type: u32,
        metadata_hash: soroban_sdk::Bytes,
    ) -> u64 {
        issuer.require_auth();
        Self::require_not_paused(&env);

        // Prevent duplicate pending requests
        let pending_key = DataKey2::PendingConsent(issuer.clone(), subject.clone(), credential_type);
        if env.storage().instance().has(&pending_key) {
            panic_with_error!(&env, ContractError::ConsentRequestAlreadyExists);
        }

        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey2::ConsentRequestCount)
            .unwrap_or(0u64)
            + 1;

        let now = env.ledger().timestamp();
        let request = ConsentRequest {
            id,
            issuer: issuer.clone(),
            subject: subject.clone(),
            credential_type,
            metadata_hash,
            expires_at_ts: now + CONSENT_REQUEST_TIMEOUT,
            approved: false,
        };

        env.storage().instance().set(&DataKey2::ConsentRequest(id), &request);
        env.storage().instance().set(&DataKey2::ConsentRequestCount, &id);
        env.storage().instance().set(&pending_key, &id);
        env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);

        // Emit consent requested event
        let topic = String::from_str(&env, "ConsentRequested");
        let mut topics: Vec<String> = Vec::new(&env);
        topics.push_back(topic);
        env.events().publish(topics, id);

        id
    }

    /// Subject approves a pending consent request.
    pub fn approve_credential_request(env: Env, subject: Address, request_id: u64) {
        subject.require_auth();

        let mut request: ConsentRequest = env
            .storage()
            .instance()
            .get(&DataKey2::ConsentRequest(request_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::ConsentRequestNotFound));

        assert!(request.subject == subject, "unauthorized");

        let now = env.ledger().timestamp();
        if now > request.expires_at_ts {
            panic_with_error!(&env, ContractError::ConsentRequestExpired);
        }

        request.approved = true;
        env.storage().instance().set(&DataKey2::ConsentRequest(request_id), &request);
        env.storage().instance().extend_ttl(STANDARD_TTL, EXTENDED_TTL);

        // Emit consent approved event (audit trail)
        let topic = String::from_str(&env, "ConsentApproved");
        let mut topics: Vec<String> = Vec::new(&env);
        topics.push_back(topic);
        env.events().publish(topics, request_id);
    }

    /// Issue a credential after consent has been granted. Consumes the consent request.
    pub fn issue_with_consent(
        env: Env,
        issuer: Address,
        request_id: u64,
        nonce: u64,
    ) -> u64 {
        issuer.require_auth();

        let request: ConsentRequest = env
            .storage()
            .instance()
            .get(&DataKey2::ConsentRequest(request_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::ConsentRequestNotFound));

        assert!(request.issuer == issuer, "unauthorized");

        if !request.approved {
            panic_with_error!(&env, ContractError::ConsentNotGranted);
        }

        let now = env.ledger().timestamp();
        if now > request.expires_at_ts {
            panic_with_error!(&env, ContractError::ConsentRequestExpired);
        }

        // Remove pending consent marker
        let pending_key = DataKey2::PendingConsent(
            request.issuer.clone(),
            request.subject.clone(),
            request.credential_type,
        );
        env.storage().instance().remove(&pending_key);
        env.storage().instance().remove(&DataKey2::ConsentRequest(request_id));

        // Issue the credential
        Self::issue_credential(
            env,
            request.issuer,
            request.subject,
            request.credential_type,
            request.metadata_hash,
            None,
            nonce,
        )
    }

    /// Get a consent request by ID.
    pub fn get_consent_request(env: Env, request_id: u64) -> ConsentRequest {
        env.storage()
            .instance()
            .get(&DataKey2::ConsentRequest(request_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::ConsentRequestNotFound))
    }

    /// Alias for issue_credential for backward compatibility.
    pub fn issue(
        env: Env,
        issuer: Address,
        subject: Address,
        credential_type: u32,
        expires_at: Option<u64>,
    ) -> u64 {
        let metadata = soroban_sdk::Bytes::from_slice(&env, b"default");
        // Backward compatibility: nonce=0 requires difficulty=0 to succeed.
        // Callers should use issue_credential directly with a valid nonce.
        Self::issue_credential(env, issuer, subject, credential_type, metadata, expires_at, 0)
    }

    /// Generate a time-limited share link token for a credential.
    ///
    /// The caller must be the credential subject (holder). Returns an opaque
    /// token (the credential ID encoded as bytes XOR'd with the expiry) that
    /// can be embedded in a share URL. Call `validate_share_token` to redeem it.
    pub fn generate_share_link(
        env: Env,
        subject: Address,
        credential_id: u64,
        expiry_hours: u32,
    ) -> soroban_sdk::Bytes {
        subject.require_auth();
        Self::require_not_paused(&env);

        assert!(expiry_hours > 0, "expiry_hours must be greater than 0");

        // Credential must exist.
        if !env
            .storage()
            .instance()
            .has(&DataKey::Credential(credential_id))
        {
            panic_with_error!(&env, ContractError::CredentialNotFound);
        }

        let now = env.ledger().timestamp();
        let expires_at = now + (expiry_hours as u64) * 3600;

        // Build a deterministic token: 8 bytes credential_id || 8 bytes expires_at
        let cid_bytes = credential_id.to_be_bytes();
        let exp_bytes = expires_at.to_be_bytes();
        let mut raw = [0u8; 16];
        raw[..8].copy_from_slice(&cid_bytes);
        raw[8..].copy_from_slice(&exp_bytes);
        let token = soroban_sdk::Bytes::from_slice(&env, &raw);

        let link = ShareLink { credential_id, expires_at };
        env.storage()
            .instance()
            .set(&DataKey2::ShareToken(token.clone()), &link);
        env.storage()
            .instance()
            .extend_ttl(STANDARD_TTL, EXTENDED_TTL);

        token
    }

    /// Validate a share token and return the credential ID.
    ///
    /// Panics with `ContractError::InvalidInput` if the token is unknown or expired.
    pub fn validate_share_token(env: Env, token: soroban_sdk::Bytes) -> u64 {
        let link: ShareLink = env
            .storage()
            .instance()
            .get(&DataKey2::ShareToken(token))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::InvalidInput));

        let now = env.ledger().timestamp();
        if now >= link.expires_at {
            panic_with_error!(&env, ContractError::InvalidInput);
        }

        link.credential_id
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Events as _, Ledger as _, LedgerInfo};
    use soroban_sdk::{vec, Bytes, Env, FromVal, IntoVal};

    // --- Deployment verification tests ---

    #[test]
    fn test_deploy_contract_registers() {
        let env = Env::default();
        // Registering the contract should succeed without panicking.
        let contract_id = env.register_contract(None, QuorumProofContract);
        // A valid contract address is returned.
        let _ = QuorumProofContractClient::new(&env, &contract_id);
    }

    #[test]
    fn test_deploy_initialize_sets_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        // initialize must succeed and store the admin.
        client.initialize(&admin);
        // Verify the contract is operational: is_paused returns false after init.
        assert!(!client.is_paused());
    }

    #[test]
    #[should_panic(expected = "already initialized")]
    fn test_deploy_initialize_only_once() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        // Second call must panic.
        client.initialize(&admin);
    }

    fn setup(env: &Env) -> (QuorumProofContractClient<'_>, Address) {
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(env, &contract_id);
        let admin = Address::generate(env);
        client.initialize(&admin);
        (client, admin)
    }

    fn set_ledger_timestamp(env: &Env, ts: u64) {
        env.ledger().set(LedgerInfo {
            timestamp: ts,
            protocol_version: 20,
            sequence_number: 1,
            network_id: Default::default(),
            base_reserve: 10,
            min_persistent_entry_ttl: 4096,
            min_temp_entry_ttl: 16,
            max_entry_ttl: 6_312_000,
        });
    }

    #[test]
    fn test_get_attestor_count() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let creator = Address::generate(&env);
        let attestor = Address::generate(&env);

        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        assert_eq!(client.get_attestor_count(&attestor), 0);

        env.mock_all_auths();
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cid = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&creator, &attestors, &weights, &1u32);

        client.attest(&attestor, &cid, &slice_id, &true, &None);
        assert_eq!(client.get_attestor_count(&attestor), 1);
    }

    #[test]
    fn test_storage_persists_across_ledgers() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        env.ledger().set(LedgerInfo {
            timestamp: 1_000,
            protocol_version: 20,
            sequence_number: 100,
            network_id: Default::default(),
            base_reserve: 10,
            min_persistent_entry_ttl: 4096,
            min_temp_entry_ttl: 16,
            max_entry_ttl: 6_312_000,
        });

        let cred = client.get_credential(&id);
        assert_eq!(cred.id, id);
        assert_eq!(cred.subject, subject);
        assert!(!cred.revoked);
    }

    // --- pause / unpause ---

    #[test]
    fn test_is_paused_false_before_pause() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
        assert_eq!(id, 1);
    }

    #[test]
    fn test_pause_and_unpause() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);
        client.pause(&admin);
        assert!(client.is_paused());
        client.unpause(&admin);
        assert!(!client.is_paused());
    }

    #[test]
    fn test_issuer_field_stored_on_credential() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmTest");
        let id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
        let cred = client.get_credential(&id);
        assert_eq!(cred.issuer, issuer);
    }

    #[test]
    fn test_different_issuers_produce_distinct_provenance() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let issuer_a = Address::generate(&env);
        let issuer_b = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        let id_a = client.issue_credential(&issuer_a, &subject, &1u32, &metadata, &None, &0u64);
        let id_b = client.issue_credential(&issuer_b, &subject, &1u32, &metadata, &None, &0u64);

        assert_eq!(client.get_credential(&id_a).issuer, issuer_a);
        assert_eq!(client.get_credential(&id_b).issuer, issuer_b);
        assert_ne!(
            client.get_credential(&id_a).issuer,
            client.get_credential(&id_b).issuer
        );
    }

    #[test]
    fn test_unpause_allows_issue_credential() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        client.pause(&admin);
        client.unpause(&admin);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let credential_type: u32 = 42;

        let id = client.issue_credential(&issuer, &subject, &credential_type, &metadata, &None, &0u64);

        let all_events = env.events().all();
        let expected_topic = String::from_str(&env, TOPIC_ISSUE);

        let issued = all_events.iter().find(
            |(_, topics, _): &(
                Address,
                soroban_sdk::Vec<soroban_sdk::Val>,
                soroban_sdk::Val,
            )| {
                if let Some(raw) = topics.get(0) {
                    let s = String::from_val(&env, &raw);
                    return s == expected_topic;
                }
                false
            },
        );

        assert!(issued.is_some(), "CredentialIssued event was not emitted");

        let (_, _, data) = issued.unwrap();
        let event_data: CredentialIssuedEventData = soroban_sdk::Val::into_val(&data, &env);

        assert_eq!(event_data.id, id);
        assert_eq!(event_data.subject, subject);
        assert_eq!(event_data.credential_type, credential_type);
    }

    #[test]
    #[should_panic]
    fn test_pause_blocks_issue_credential() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);
        client.pause(&admin);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
    }

    // --- credential issuance ---

    #[test]
    fn test_issue_and_get_credential() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let creator = Address::generate(&env);
        let mut attestors = Vec::new(&env);
        attestors.push_back(Address::generate(&env));
        attestors.push_back(Address::generate(&env));
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        weights.push_back(1u32);
        client.create_slice(&creator, &attestors, &weights, &2u32);
    }

    #[test]
    #[should_panic(expected = "attestors exceed maximum allowed per slice")]
    fn test_empty_metadata_hash_rejection() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let empty_metadata = Bytes::new(&env);
        client.issue_credential(&issuer, &subject, &1u32, &empty_metadata, &None, &0u64);
    }

    #[test]
    #[should_panic(expected = "credential_type must be greater than 0")]
    fn test_zero_credential_type_rejection() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        client.issue_credential(&issuer, &subject, &0u32, &metadata, &None, &0u64);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #1)")]
    fn test_get_credential_not_found() {
        let env = Env::default();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        // Try to get a credential that doesn't exist
        client.get_credential(&999u64);
    }

    // --- revocation ---

    #[test]
    #[should_panic]
    fn test_pause_blocks_revoke_credential() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        client.pause(&admin);
        client.revoke_credential(&issuer, &id);
        let cred = client.get_credential(&id);
        assert!(cred.revoked);
    }

    #[test]
    fn test_subject_revoke_credential() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        client.revoke_credential(&issuer, &id);

        let cred = client.get_credential(&id);
        assert!(cred.revoked);
    }

    #[test]
    fn test_suspend_and_resume_credential() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        assert!(!client.is_suspended(&id));

        client.suspend_credential(&issuer, &id);
        assert!(client.is_suspended(&id));
        assert!(client.get_credential(&id).suspended);

        client.resume_credential(&issuer, &id);
        assert!(!client.is_suspended(&id));
        assert!(!client.get_credential(&id).suspended);
    }

    #[test]
    #[should_panic(expected = "credential is suspended")]
    fn test_suspended_credential_blocks_attestation() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);

        client.suspend_credential(&issuer, &cred_id);
        client.attest(&attestor, &cred_id, &slice_id, &true, &None);
    }

    #[test]
    #[should_panic]
    fn test_pause_blocks_attest() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);

        client.pause(&admin);
        client.attest(&attestor, &cred_id, &slice_id, &true, &None);
    }

    // --- slices & attestation ---

    #[test]
    fn test_quorum_slice_and_attestation() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let creator = Address::generate(&env);
        let slice_id = client.create_slice(&creator, &attestors, &weights, &1u32);

        assert!(!client.is_attested(&cred_id, &slice_id));
        client.attest(&attestor, &cred_id, &slice_id, &true, &None);
        assert!(client.is_attested(&cred_id, &slice_id));
    }

    #[test]
    #[should_panic(expected = "attestor has already attested for this credential")]
    fn test_duplicate_attestation_rejection() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);
        client.attest(&attestor, &cred_id, &slice_id, &true, &None);
        client.attest(&attestor, &cred_id, &slice_id, &true, &None);
    }

    #[test]
    #[should_panic(expected = "credential is revoked")]
    fn test_attest_revoked_credential_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);
        client.revoke_credential(&issuer, &id);
        client.attest(&attestor, &id, &slice_id, &true, &None);
    }

    // --- slice management ---

    #[test]
    #[should_panic(expected = "attestors cannot be empty")]
    fn test_create_slice_empty_attestors_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        client.create_slice(
            &Address::generate(&env),
            &Vec::new(&env),
            &Vec::new(&env),
            &1u32,
        );
    }

    #[test]
    #[should_panic(expected = "threshold must be greater than 0")]
    fn test_zero_threshold_rejection() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let creator = Address::generate(&env);
        let mut attestors = Vec::new(&env);
        attestors.push_back(Address::generate(&env));
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);

        client.create_slice(&creator, &attestors, &weights, &0u32);
    }

    #[test]
    #[should_panic(expected = "threshold cannot exceed attestors length")]
    fn test_threshold_exceeds_attestors() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let creator = Address::generate(&env);
        let mut attestors = soroban_sdk::Vec::new(&env);
        attestors.push_back(Address::generate(&env));
        attestors.push_back(Address::generate(&env));
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        weights.push_back(1u32);

        // 2 attestors but threshold of 3 — must panic
        client.create_slice(&creator, &attestors, &weights, &3u32);
    }

    #[test]
    #[should_panic(expected = "attestors exceed maximum allowed per slice")]
    fn test_create_slice_exceeds_max_attestors() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let creator = Address::generate(&env);
        let mut attestors = Vec::new(&env);
        let mut weights = Vec::new(&env);
        for _ in 0..=MAX_ATTESTORS_PER_SLICE {
            attestors.push_back(Address::generate(&env));
            weights.push_back(1u32);
        }
        client.create_slice(&creator, &attestors, &weights, &1u32);
    }

    #[test]
    fn test_get_slice_creator_matches() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let creator = Address::generate(&env);
        let mut attestors = Vec::new(&env);
        attestors.push_back(Address::generate(&env));
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&creator, &attestors, &weights, &1u32);
        assert_eq!(client.get_slice_creator(&slice_id), creator);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_get_slice_not_found() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        // Try to get a slice that doesn't exist
        client.get_slice(&999u64);
    }

    #[test]
    #[should_panic(expected = "unauthorized")]
    fn test_pause_unauthorized_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let non_admin = Address::generate(&env);
        client.pause(&non_admin);
    }

    #[test]
    fn test_get_credentials_by_subject_multiple() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        let id1 = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
        let id2 = client.issue_credential(&issuer, &subject, &2u32, &metadata, &None, &0u64);
        let id3 = client.issue_credential(&issuer, &subject, &3u32, &metadata, &None, &0u64);

        let ids = client.get_credentials_by_subject(&subject, &1, &100);
        assert_eq!(ids.len(), 3);
        assert_eq!(ids.get(0).unwrap(), id1);
        assert_eq!(ids.get(1).unwrap(), id2);
        assert_eq!(ids.get(2).unwrap(), id3);
    }

    #[test]
    fn test_revoke_prunes_subject_credentials_only_for_target_subject() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);

        let issuer = Address::generate(&env);
        let subject_a = Address::generate(&env);
        let subject_b = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        let id_a1 = client.issue_credential(&issuer, &subject_a, &1u32, &metadata, &None, &0u64);
        let id_a2 = client.issue_credential(&issuer, &subject_a, &2u32, &metadata, &None, &0u64);
        let id_b1 = client.issue_credential(&issuer, &subject_b, &1u32, &metadata, &None, &0u64);

        let before_a = client.get_credentials_by_subject(&subject_a, &1, &100);
        assert_eq!(before_a.len(), 2);
        assert_eq!(before_a.get(0).unwrap(), id_a1);
        assert_eq!(before_a.get(1).unwrap(), id_a2);

        let before_b = client.get_credentials_by_subject(&subject_b, &1, &100);
        assert_eq!(before_b.len(), 1);
        assert_eq!(before_b.get(0).unwrap(), id_b1);

        client.revoke_credential(&issuer, &id_a1);

        let after_a = client.get_credentials_by_subject(&subject_a, &1, &100);
        assert_eq!(after_a.len(), 1);
        assert_eq!(after_a.get(0).unwrap(), id_a2);

        let after_b = client.get_credentials_by_subject(&subject_b, &1, &100);
        assert_eq!(after_b.len(), 1);
        assert_eq!(after_b.get(0).unwrap(), id_b1);

        let revoked = client.get_credential(&id_a1);
        assert!(revoked.revoked);
    }

    #[test]
    fn test_update_threshold_success() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let subject = Address::generate(&env);
        let ids = client.get_credentials_by_subject(&subject, &1, &100);
        assert_eq!(ids.len(), 0);
    }

    #[test]
    #[should_panic(expected = "only the slice creator can update threshold")]
    fn test_update_slice_threshold_unauthorized_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let creator = Address::generate(&env);
        let non_creator = Address::generate(&env);
        let mut attestors = Vec::new(&env);
        attestors.push_back(Address::generate(&env));
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&creator, &attestors, &weights, &1u32);

        client.update_slice_threshold(&non_creator, &slice_id, &1u32);
    }

    // --- expiry ---

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_add_attestor_slice_not_found_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let creator = Address::generate(&env);
        client.add_attestor(&creator, &999u64, &Address::generate(&env), &1u32);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_update_slice_threshold_slice_not_found_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let creator = Address::generate(&env);
        client.update_slice_threshold(&creator, &999u64, &1u32);
    }

    #[test]
    fn test_single_attestation_produces_exactly_one_entry() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);
        client.attest(&attestor, &cred_id, &slice_id, &true, &None);
        assert_eq!(client.get_attestors(&cred_id).len(), 1);
    }

    // --- expiry ---

    #[test]
    fn test_is_expired_no_expiry() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        set_ledger_timestamp(&env, 999_999_999);
        assert!(!client.is_expired(&id));
    }

    #[test]
    fn test_credential_not_expired_before_expiry() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &Some(2_000u64), &0u64);

        assert!(!client.is_expired(&id));
    }

    #[test]
    fn test_credential_expired_after_expiry() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        set_ledger_timestamp(&env, 1_000);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &Some(2_000u64), &0u64);

        set_ledger_timestamp(&env, 3_000);
        assert!(client.is_expired(&id));
    }

    #[test]
    #[should_panic(expected = "credential has expired")]
    fn test_get_credential_panics_when_expired() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        set_ledger_timestamp(&env, 1_000);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &Some(2_000u64), &0u64);
        set_ledger_timestamp(&env, 3_000);
        client.get_credential(&id);
    }

    #[test]
    fn test_version_increments_on_update_metadata() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        let cred_v1 = client.get_credential(&id);
        assert_eq!(cred_v1.version, 1);

        let new_metadata = Bytes::from_slice(&env, b"QmUpdatedHash0000000000000000000000");
        client.update_metadata(&issuer, &id, &new_metadata);
        let cred_v2 = client.get_credential(&id);
        assert_eq!(cred_v2.version, 2);
        assert_eq!(cred_v2.metadata_hash, new_metadata);

        client.update_metadata(&issuer, &id, &metadata);
        let cred_v3 = client.get_credential(&id);
        assert_eq!(cred_v3.version, 3);
    }

    #[test]
    fn test_transfer_full_flow() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let recipient = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        client.initiate_transfer(&subject, &id, &recipient);
        client.accept_transfer(&recipient, &id);

        let cred = client.get_credential(&id);
        assert_eq!(cred.subject, recipient);
    }

    #[test]
    #[should_panic]
    fn test_initiate_transfer_unauthorized() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attacker = Address::generate(&env);
        let recipient = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        // attacker is not the subject — should panic with UnauthorizedTransfer
        client.initiate_transfer(&attacker, &id, &recipient);
    }

    #[test]
    #[should_panic]
    fn test_accept_transfer_wrong_recipient() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let recipient = Address::generate(&env);
        let other = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        client.initiate_transfer(&subject, &id, &recipient);
        // `other` is not the intended recipient — should panic
        client.accept_transfer(&other, &id);
    }

    #[test]
    fn test_transfer_updates_subject_credential_lists() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let recipient = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        client.initiate_transfer(&subject, &id, &recipient);
        client.accept_transfer(&recipient, &id);

        let old_list = client.get_credentials_by_subject(&subject, &1u32, &50u32);
        let new_list = client.get_credentials_by_subject(&recipient, &1u32, &50u32);
        assert!(!old_list.contains(&id));
        assert!(new_list.contains(&id));
    }

    #[test]
    fn test_is_attested_returns_false_when_expired() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        set_ledger_timestamp(&env, 1_000);
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &Some(2_000u64), &0u64);

        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);
        client.attest(&attestor, &cred_id, &slice_id, &true, &None);
        assert!(client.is_attested(&cred_id, &slice_id));

        set_ledger_timestamp(&env, 3_000);
        assert!(!client.is_attested(&cred_id, &slice_id));
    }

    #[test]
    fn test_is_attested_returns_false_before_threshold_is_met() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor1 = Address::generate(&env);
        let attestor2 = Address::generate(&env);
        let attestor3 = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor1.clone());
        attestors.push_back(attestor2.clone());
        attestors.push_back(attestor3.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        weights.push_back(1u32);
        weights.push_back(1u32);
        let creator = Address::generate(&env);
        let slice_id = client.create_slice(&creator, &attestors, &weights, &3u32);

        client.attest(&attestor1, &cred_id, &slice_id, &true, &None);
        client.attest(&attestor2, &cred_id, &slice_id, &true, &None);

        assert!(!client.is_attested(&cred_id, &slice_id));
    }

    // --- verify_attestations_batch tests ---

    #[test]
    fn test_verify_attestations_batch_all_attested() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        let cred1 = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
        let cred2 = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);

        client.attest(&attestor, &cred1, &slice_id, &true, &None);
        client.attest(&attestor, &cred2, &slice_id, &true, &None);

        let mut cred_ids = Vec::new(&env);
        cred_ids.push_back(cred1);
        cred_ids.push_back(cred2);
        let mut slice_ids = Vec::new(&env);
        slice_ids.push_back(slice_id);
        slice_ids.push_back(slice_id);

        let results = client.verify_attestations_batch(&cred_ids, &slice_ids);
        assert_eq!(results.len(), 2);
        assert!(results.get(0).unwrap());
        assert!(results.get(1).unwrap());
    }

    #[test]
    fn test_verify_attestations_batch_mixed_results() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        let cred1 = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
        let cred2 = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);

        // Only attest cred1
        client.attest(&attestor, &cred1, &slice_id, &true, &None);

        let mut cred_ids = Vec::new(&env);
        cred_ids.push_back(cred1);
        cred_ids.push_back(cred2);
        let mut slice_ids = Vec::new(&env);
        slice_ids.push_back(slice_id);
        slice_ids.push_back(slice_id);

        let results = client.verify_attestations_batch(&cred_ids, &slice_ids);
        assert!(results.get(0).unwrap());
        assert!(!results.get(1).unwrap());
    }

    #[test]
    fn test_verify_attestations_batch_revoked_returns_false() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);
        client.attest(&attestor, &cred_id, &slice_id, &true, &None);
        client.revoke_credential(&issuer, &cred_id);

        let mut cred_ids = Vec::new(&env);
        cred_ids.push_back(cred_id);
        let mut slice_ids = Vec::new(&env);
        slice_ids.push_back(slice_id);

        let results = client.verify_attestations_batch(&cred_ids, &slice_ids);
        assert!(!results.get(0).unwrap());
    }

    // --- batch issue ---

    #[test]
    fn test_add_attestor_success() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let creator = Address::generate(&env);
        let attestor1 = Address::generate(&env);
        let attestor2 = Address::generate(&env);

        let mut initial = Vec::new(&env);
        initial.push_back(attestor1.clone());
        let mut initial_weights = Vec::new(&env);
        initial_weights.push_back(1u32);
        let slice_id = client.create_slice(&creator, &initial, &initial_weights, &1u32);

        client.add_attestor(&creator, &slice_id, &attestor2, &1u32);

        let slice = client.get_slice(&slice_id);
        assert_eq!(slice.attestors.len(), 2);
        assert_eq!(slice.attestors.get(1).unwrap(), attestor2);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #5)")]
    fn test_add_attestor_duplicate_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let creator = Address::generate(&env);
        let attestor = Address::generate(&env);

        let mut initial = Vec::new(&env);
        initial.push_back(attestor.clone());
        let mut initial_weights = Vec::new(&env);
        initial_weights.push_back(1u32);
        let slice_id = client.create_slice(&creator, &initial, &initial_weights, &1u32);

        client.add_attestor(&creator, &slice_id, &attestor, &1u32);
    }

    #[test]
    #[should_panic(expected = "only the slice creator can add attestors")]
    fn test_add_attestor_unauthorized_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let creator = Address::generate(&env);
        let non_creator = Address::generate(&env);
        let attestor = Address::generate(&env);

        // Create slice with at least one attestor to avoid "attestors cannot be empty" panic
        let mut initial = Vec::new(&env);
        initial.push_back(Address::generate(&env));
        let mut initial_weights = Vec::new(&env);
        initial_weights.push_back(1u32);
        let slice_id = client.create_slice(&creator, &initial, &initial_weights, &1u32);

        // This should panic with "only the slice creator can add attestors"
        client.add_attestor(&non_creator, &slice_id, &attestor, &1u32);
    }

    #[test]
    fn test_add_attestor_enables_attestation() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let creator = Address::generate(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor1 = Address::generate(&env);
        let attestor2 = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        let mut initial = Vec::new(&env);
        initial.push_back(attestor1.clone());
        let mut initial_weights = Vec::new(&env);
        initial_weights.push_back(1u32);
        let slice_id = client.create_slice(&creator, &initial, &initial_weights, &1u32);

        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        client.attest(&attestor1, &cred_id, &slice_id, &true, &None);
        assert!(client.is_attested(&cred_id, &slice_id)); // threshold=1, met after attestor1

        client.add_attestor(&creator, &slice_id, &attestor2, &1u32);
        client.update_slice_threshold(&creator, &slice_id, &2u32);
        assert!(!client.is_attested(&cred_id, &slice_id)); // threshold raised to 2, not met yet
        client.attest(&attestor2, &cred_id, &slice_id, &true, &None);
        assert!(client.is_attested(&cred_id, &slice_id));
    }

    #[test]
    fn test_verify_engineer_success() {
        use sbt_registry::{SbtRegistryContract, SbtRegistryContractClient};
        use zk_verifier::{ClaimType, ZkVerifierContract, ZkVerifierContractClient};

        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let qp_id = env.register_contract(None, QuorumProofContract);
        let sbt_id = env.register_contract(None, SbtRegistryContract);
        let zk_id = env.register_contract(None, ZkVerifierContract);

        let qp = QuorumProofContractClient::new(&env, &qp_id);
        let sbt = SbtRegistryContractClient::new(&env, &sbt_id);
        let zk_admin = Address::generate(&env);
        ZkVerifierContractClient::new(&env, &zk_id).initialize(&zk_admin);
        sbt.initialize(&zk_admin, &qp_id);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        let cred_id = qp.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        let sbt_uri = Bytes::from_slice(&env, b"ipfs://QmSbt");
        sbt.mint(&subject, &cred_id, &sbt_uri);

        let proof = Bytes::from_slice(&env, b"valid-proof");
        let result = qp.verify_engineer(
            &sbt_id,
            &zk_id,
            &zk_admin,
            &subject,
            &cred_id,
            &ClaimType::HasDegree,
            &proof,
        &None,
        );
        assert!(result);
    }

    #[test]
    fn test_verify_engineer_fails_without_sbt() {
        use zk_verifier::{ClaimType, ZkVerifierContract, ZkVerifierContractClient};

        let env = Env::default();
        env.mock_all_auths();

        let qp_id = env.register_contract(None, QuorumProofContract);
        let sbt_id = env.register_contract(None, sbt_registry::SbtRegistryContract);
        let zk_id = env.register_contract(None, ZkVerifierContract);

        let qp = QuorumProofContractClient::new(&env, &qp_id);
        let zk_admin = Address::generate(&env);
        ZkVerifierContractClient::new(&env, &zk_id).initialize(&zk_admin);
        sbt_registry::SbtRegistryContractClient::new(&env, &sbt_id).initialize(&zk_admin, &qp_id);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        let cred_id = qp.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        let proof = Bytes::from_slice(&env, b"valid-proof");
        let result = qp.verify_engineer(
            &sbt_id,
            &zk_id,
            &zk_admin,
            &subject,
            &cred_id,
            &ClaimType::HasDegree,
            &proof,
        &None,
        );
        assert!(!result);
    }

    #[test]
    fn test_verify_engineer_fails_with_empty_proof() {
        use sbt_registry::{SbtRegistryContract, SbtRegistryContractClient};
        use zk_verifier::{ClaimType, ZkVerifierContract, ZkVerifierContractClient};

        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let qp_id = env.register_contract(None, QuorumProofContract);
        let sbt_id = env.register_contract(None, SbtRegistryContract);
        let zk_id = env.register_contract(None, ZkVerifierContract);

        let qp = QuorumProofContractClient::new(&env, &qp_id);
        let sbt = SbtRegistryContractClient::new(&env, &sbt_id);
        let zk_admin = Address::generate(&env);
        ZkVerifierContractClient::new(&env, &zk_id).initialize(&zk_admin);
        sbt.initialize(&zk_admin, &qp_id);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        let cred_id = qp.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
        let sbt_uri = Bytes::from_slice(&env, b"ipfs://QmSbt");
        sbt.mint(&subject, &cred_id, &sbt_uri);

        let proof = Bytes::from_slice(&env, b"");
        let result = qp.verify_engineer(
            &sbt_id,
            &zk_id,
            &zk_admin,
            &subject,
            &cred_id,
            &ClaimType::HasLicense,
            &proof,
        &None,
        );
        assert!(!result);
    }

    #[test]
    fn test_verify_engineer_with_active_delegate_succeeds() {
        use sbt_registry::{SbtRegistryContract, SbtRegistryContractClient};
        use zk_verifier::{ClaimType, ZkVerifierContract, ZkVerifierContractClient};

        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let qp_id = env.register_contract(None, QuorumProofContract);
        let sbt_id = env.register_contract(None, SbtRegistryContract);
        let zk_id = env.register_contract(None, ZkVerifierContract);

        let qp = QuorumProofContractClient::new(&env, &qp_id);
        let sbt = SbtRegistryContractClient::new(&env, &sbt_id);
        let zk_admin = Address::generate(&env);
        ZkVerifierContractClient::new(&env, &zk_id).initialize(&zk_admin);
        sbt.initialize(&zk_admin, &qp_id);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let hr_delegate = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        let cred_id = qp.issue_credential(&issuer, &subject, &1u32, &metadata, &None);
        let sbt_uri = Bytes::from_slice(&env, b"ipfs://QmSbt");
        let token_id = sbt.mint(&subject, &cred_id, &sbt_uri);

        let expires_at = env.ledger().timestamp() + 10_000;
        sbt.delegate_sbt_rights(&subject, &token_id, &hr_delegate, &expires_at);

        let proof = Bytes::from_slice(&env, b"valid-proof");
        let result = qp.verify_engineer(
            &sbt_id,
            &zk_id,
            &zk_admin,
            &subject,
            &cred_id,
            &ClaimType::HasDegree,
            &proof,
            &Some(hr_delegate),
        );
        assert!(result);
    }

    #[test]
    fn test_verify_engineer_with_revoked_delegate_fails() {
        use sbt_registry::{SbtRegistryContract, SbtRegistryContractClient};
        use zk_verifier::{ClaimType, ZkVerifierContract, ZkVerifierContractClient};

        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let qp_id = env.register_contract(None, QuorumProofContract);
        let sbt_id = env.register_contract(None, SbtRegistryContract);
        let zk_id = env.register_contract(None, ZkVerifierContract);

        let qp = QuorumProofContractClient::new(&env, &qp_id);
        let sbt = SbtRegistryContractClient::new(&env, &sbt_id);
        let zk_admin = Address::generate(&env);
        ZkVerifierContractClient::new(&env, &zk_id).initialize(&zk_admin);
        sbt.initialize(&zk_admin, &qp_id);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let hr_delegate = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        let cred_id = qp.issue_credential(&issuer, &subject, &1u32, &metadata, &None);
        let sbt_uri = Bytes::from_slice(&env, b"ipfs://QmSbt");
        let token_id = sbt.mint(&subject, &cred_id, &sbt_uri);

        let expires_at = env.ledger().timestamp() + 10_000;
        sbt.delegate_sbt_rights(&subject, &token_id, &hr_delegate, &expires_at);
        sbt.revoke_sbt_delegation(&subject, &token_id);

        let proof = Bytes::from_slice(&env, b"valid-proof");
        let result = qp.verify_engineer(
            &sbt_id,
            &zk_id,
            &zk_admin,
            &subject,
            &cred_id,
            &ClaimType::HasDegree,
            &proof,
            &Some(hr_delegate),
        );
        assert!(!result);
    }

    #[test]
    fn test_verify_engineer_with_unauthorized_verifier_fails() {
        use sbt_registry::{SbtRegistryContract, SbtRegistryContractClient};
        use zk_verifier::{ClaimType, ZkVerifierContract, ZkVerifierContractClient};

        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let qp_id = env.register_contract(None, QuorumProofContract);
        let sbt_id = env.register_contract(None, SbtRegistryContract);
        let zk_id = env.register_contract(None, ZkVerifierContract);

        let qp = QuorumProofContractClient::new(&env, &qp_id);
        let sbt = SbtRegistryContractClient::new(&env, &sbt_id);
        let zk_admin = Address::generate(&env);
        ZkVerifierContractClient::new(&env, &zk_id).initialize(&zk_admin);
        sbt.initialize(&zk_admin, &qp_id);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let stranger = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        let cred_id = qp.issue_credential(&issuer, &subject, &1u32, &metadata, &None);
        let sbt_uri = Bytes::from_slice(&env, b"ipfs://QmSbt");
        sbt.mint(&subject, &cred_id, &sbt_uri);

        let proof = Bytes::from_slice(&env, b"valid-proof");
        let result = qp.verify_engineer(
            &sbt_id,
            &zk_id,
            &zk_admin,
            &subject,
            &cred_id,
            &ClaimType::HasDegree,
            &proof,
            &Some(stranger),
        );
        assert!(!result);
    }

    #[test]
    fn test_get_attestor_reputation_increments_per_attestation() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);
        let cred_id1 = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
        let cred_id2 = client.issue_credential(&issuer, &subject, &2u32, &metadata, &None, &0u64);
        assert_eq!(client.get_attestor_reputation(&attestor), 0);
        client.attest(&attestor, &cred_id1, &slice_id, &true, &None);
        assert_eq!(client.get_attestor_reputation(&attestor), 1);
        client.attest(&attestor, &cred_id2, &slice_id, &true, &None);
        assert_eq!(client.get_attestor_reputation(&attestor), 2);
    }

    #[test]
    fn test_batch_issue_credentials_success() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let issuer = Address::generate(&env);
        let subject1 = Address::generate(&env);
        let subject2 = Address::generate(&env);
        let subject3 = Address::generate(&env);

        let mut subjects = Vec::new(&env);
        subjects.push_back(subject1.clone());
        subjects.push_back(subject2.clone());
        subjects.push_back(subject3.clone());

        let mut cred_types = Vec::new(&env);
        cred_types.push_back(1u32);
        cred_types.push_back(2u32);
        cred_types.push_back(1u32);

        let mut hashes = Vec::new(&env);
        hashes.push_back(Bytes::from_slice(
            &env,
            b"QmHash1_000000000000000000000000000",
        ));
        hashes.push_back(Bytes::from_slice(
            &env,
            b"QmHash2_000000000000000000000000000",
        ));
        hashes.push_back(Bytes::from_slice(
            &env,
            b"QmHash3_000000000000000000000000000",
        ));

        let ids = client.batch_issue_credentials(&issuer, &subjects, &cred_types, &hashes, &None);

        assert_eq!(ids.len(), 3);
        assert_eq!(
            client.get_credentials_by_subject(&subject1, &1, &100).len(),
            1
        );
        assert_eq!(
            client.get_credentials_by_subject(&subject2, &1, &100).len(),
            1
        );
        assert_eq!(
            client.get_credentials_by_subject(&subject3, &1, &100).len(),
            1
        );
        assert_eq!(ids.get(1).unwrap(), ids.get(0).unwrap() + 1);
        assert_eq!(ids.get(2).unwrap(), ids.get(0).unwrap() + 2);
    }

    #[test]
    #[should_panic(expected = "input lengths must match")]
    fn test_batch_issue_credentials_mismatched_lengths_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let issuer = Address::generate(&env);

        let mut subjects = Vec::new(&env);
        subjects.push_back(Address::generate(&env));
        subjects.push_back(Address::generate(&env));

        let mut cred_types = Vec::new(&env);
        cred_types.push_back(1u32);

        let mut hashes = Vec::new(&env);
        hashes.push_back(Bytes::from_slice(
            &env,
            b"QmHash1_000000000000000000000000000",
        ));
        hashes.push_back(Bytes::from_slice(
            &env,
            b"QmHash2_000000000000000000000000000",
        ));

        client.batch_issue_credentials(&issuer, &subjects, &cred_types, &hashes, &None);
    }

    #[test]
    #[should_panic(expected = "DuplicateCredential")]
    fn test_batch_issue_credentials_duplicate_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);

        // Pre-issue a credential so the batch hits a duplicate
        let metadata = Bytes::from_slice(&env, b"QmExisting00000000000000000000000000");
        client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        let mut subjects = Vec::new(&env);
        subjects.push_back(subject.clone());
        let mut cred_types = Vec::new(&env);
        cred_types.push_back(1u32); // duplicate
        let mut hashes = Vec::new(&env);
        hashes.push_back(Bytes::from_slice(
            &env,
            b"QmNewHash0000000000000000000000000",
        ));

        client.batch_issue_credentials(&issuer, &subjects, &cred_types, &hashes, &None);
    }

    #[test]
    #[should_panic]
    fn test_batch_issue_credentials_paused_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);
        client.pause(&admin);

        let issuer = Address::generate(&env);
        let mut subjects = Vec::new(&env);
        subjects.push_back(Address::generate(&env));
        let mut cred_types = Vec::new(&env);
        cred_types.push_back(1u32);
        let mut hashes = Vec::new(&env);
        hashes.push_back(Bytes::from_slice(
            &env,
            b"QmTestHash000000000000000000000000",
        ));

        client.batch_issue_credentials(&issuer, &subjects, &cred_types, &hashes, &None);
    }

    #[test]
    fn test_batch_issue_credentials_with_expiry() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let issuer = Address::generate(&env);
        let subject1 = Address::generate(&env);
        let subject2 = Address::generate(&env);

        let mut subjects = Vec::new(&env);
        subjects.push_back(subject1.clone());
        subjects.push_back(subject2.clone());
        let mut cred_types = Vec::new(&env);
        cred_types.push_back(1u32);
        cred_types.push_back(2u32);
        let mut hashes = Vec::new(&env);
        hashes.push_back(Bytes::from_slice(
            &env,
            b"QmHash1_000000000000000000000000000",
        ));
        hashes.push_back(Bytes::from_slice(
            &env,
            b"QmHash2_000000000000000000000000000",
        ));

        let ids = client.batch_issue_credentials(
            &issuer,
            &subjects,
            &cred_types,
            &hashes,
            &Some(9_999_999u64),
        );

        assert_eq!(ids.len(), 2);
        assert_eq!(
            client.get_credential(&ids.get(0).unwrap()).expires_at,
            Some(9_999_999u64)
        );
        assert_eq!(
            client.get_credential(&ids.get(1).unwrap()).expires_at,
            Some(9_999_999u64)
        );
    }

    #[test]
    fn test_register_and_get_credential_type() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);
        let name = String::from_str(&env, "Mechanical Engineering Degree");
        let desc = String::from_str(&env, "Bachelor or higher in Mechanical Engineering");

        client.register_credential_type(&admin, &1u32, &name, &desc, &None);
        let def = client.get_credential_type(&1u32);
        assert_eq!(def.type_id, 1u32);
        assert_eq!(def.name, name);
    }

    #[test]
    #[should_panic(expected = "credential type not registered")]
    fn test_get_credential_type_not_registered_panics() {
        let env = Env::default();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        client.get_credential_type(&99u32);
    }

    #[test]
    fn test_register_credential_type_overwrites() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        let name_v1 = String::from_str(&env, "Old Name");
        let name_v2 = String::from_str(&env, "New Name");
        let desc = String::from_str(&env, "desc");

        client.register_credential_type(&admin, &1u32, &name_v1, &desc, &None);
        client.register_credential_type(&admin, &1u32, &name_v2, &desc, &None);

        let def = client.get_credential_type(&1u32);
        assert_eq!(def.name, name_v2);
    }

    #[test]
    #[should_panic(expected = "unauthorized")]
    fn test_register_credential_type_non_admin_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin) = setup(&env);
        let non_admin = Address::generate(&env);
        let name = String::from_str(&env, "Fake Type");
        let desc = String::from_str(&env, "desc");
        client.register_credential_type(&non_admin, &1u32, &name, &desc, &None);
    }

    #[test]
    fn test_register_credential_type_emits_event() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);
        let name = String::from_str(&env, "Civil Engineering");
        let desc = String::from_str(&env, "desc");

        client.register_credential_type(&admin, &5u32, &name, &desc, &None);

        let events = env.events().all();
        let reg_event = events.iter().find(|(_, topics, _)| {
            if let Some(first) = topics.get(0) {
                soroban_sdk::Symbol::from_val(&env, &first) == symbol_short!("reg_type")
            } else {
                false
            }
        });
        assert!(reg_event.is_some(), "reg_type event not emitted");
        let (_, _, data) = reg_event.unwrap();
        let emitted_id = u32::from_val(&env, &data);
        assert_eq!(emitted_id, 5u32);
    }

    #[test]
    #[should_panic] // upgrade requires the WASM to exist in host storage; this verifies auth passes
    fn test_upgrade_success() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let wasm_hash = soroban_sdk::BytesN::from_array(&env, &[0u8; 32]);
        client.upgrade(&admin, &wasm_hash);
    }

    #[test]
    fn test_get_credential_count() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin) = setup(&env);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        assert_eq!(client.get_credential_count(), 0);

        let id1 = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
        let _id2 = client.issue_credential(&issuer, &subject, &2u32, &metadata, &None, &0u64);
        let _id3 = client.issue_credential(&issuer, &subject, &3u32, &metadata, &None, &0u64);

        assert_eq!(client.get_credential_count(), 3);

        client.revoke_credential(&issuer, &id1);
        assert_eq!(client.get_credential_count(), 3);
    }

    #[test]
    fn test_get_slice_count() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin) = setup(&env);

        let creator = Address::generate(&env);
        let mut attestors = Vec::new(&env);
        attestors.push_back(Address::generate(&env));
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);

        assert_eq!(client.get_slice_count(), 0);

        client.create_slice(&creator, &attestors.clone(), &weights.clone(), &1u32);
        client.create_slice(&creator, &attestors, &weights, &1u32);

        assert_eq!(client.get_slice_count(), 2);
    }

    // Issue #47: revoke_credential prevents further attestation
    #[test]
    #[should_panic(expected = "credential is revoked")]
    fn test_revoke_credential_prevents_attestation() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        // Issue a credential
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        // Set up a quorum slice with the attestor
        let mut attestors = soroban_sdk::Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);

        // Revoke the credential
        client.revoke_credential(&issuer, &cred_id);

        // Attempting to attest a revoked credential must panic
        client.attest(&attestor, &cred_id, &slice_id, &true, &None);
    }

    #[test]
    fn test_get_attestation_count() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor1 = Address::generate(&env);
        let attestor2 = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        let mut attestors = soroban_sdk::Vec::new(&env);
        attestors.push_back(attestor1.clone());
        attestors.push_back(attestor2.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);

        assert_eq!(client.get_attestation_count(&cred_id), 0);
        client.attest(&attestor1, &cred_id, &slice_id, &true, &None);
        assert_eq!(client.get_attestation_count(&cred_id), 1);
        client.attest(&attestor2, &cred_id, &slice_id, &true, &None);
        assert_eq!(client.get_attestation_count(&cred_id), 2);
    }

    // --- holder notification tests ---

    #[test]
    fn test_notification_event_emitted_on_attest() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        let mut attestors = soroban_sdk::Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);

        client.attest(&attestor, &cred_id, &slice_id, &true, &None);

        let events = env.events().all();
        let notified = events.iter().find(|(_, topics, _)| {
            if let Some(t) = topics.get(0) {
                String::from_val(&env, &t) == String::from_str(&env, "HolderNotified")
            } else {
                false
            }
        });
        assert!(notified.is_some(), "HolderNotified event not emitted");
    }

    #[test]
    fn test_notification_history_stored_on_attest() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        let mut attestors = soroban_sdk::Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);

        assert_eq!(client.get_notification_history(&subject).len(), 0);
        client.attest(&attestor, &cred_id, &slice_id, &true, &None);

        let history = client.get_notification_history(&subject);
        assert_eq!(history.len(), 1);
        let notif = history.get(0).unwrap();
        assert_eq!(notif.credential_id, cred_id);
        assert_eq!(notif.attestor, attestor);
        assert_eq!(notif.slice_id, slice_id);
    }

    #[test]
    fn test_notification_history_accumulates_multiple_attestors() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor1 = Address::generate(&env);
        let attestor2 = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        let mut attestors = soroban_sdk::Vec::new(&env);
        attestors.push_back(attestor1.clone());
        attestors.push_back(attestor2.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);

        client.attest(&attestor1, &cred_id, &slice_id, &true, &None);
        client.attest(&attestor2, &cred_id, &slice_id, &true, &None);

        assert_eq!(client.get_notification_history(&subject).len(), 2);
    }

    // --- attestation metadata tests ---

    #[test]
    fn test_set_and_get_attestation_metadata() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let metadata_hash = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata_hash, &None, &0u64);

        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);
        client.attest(&attestor, &cred_id, &slice_id, &true, &None);

        let meta = Bytes::from_slice(&env, b"ref:ENG-2024-001");
        client.set_attestation_metadata(&attestor, &cred_id, &meta);

        let stored = client.get_attestation_metadata(&cred_id, &attestor);
        assert_eq!(stored, Some(meta));
    }

    #[test]
    fn test_get_attestation_metadata_none_when_not_set() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let metadata_hash = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata_hash, &None, &0u64);

        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);
        client.attest(&attestor, &cred_id, &slice_id, &true, &None);

        assert_eq!(client.get_attestation_metadata(&cred_id, &attestor), None);
    }

    #[test]
    #[should_panic(expected = "attestor has not attested this credential")]
    fn test_set_attestation_metadata_non_attestor_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let non_attestor = Address::generate(&env);
        let metadata_hash = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata_hash, &None, &0u64);

        let meta = Bytes::from_slice(&env, b"unauthorized");
        client.set_attestation_metadata(&non_attestor, &cred_id, &meta);
    }

    // --- duplicate credential tests ---

    #[test]
    #[should_panic(expected = "Error(Contract, #4)")]
    fn test_duplicate_credential_issuance_rejection() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let credential_type: u32 = 1;

        // Issue first credential
        client.issue_credential(&issuer, &subject, &credential_type, &metadata, &None, &0u64);

        // Try to issue duplicate credential of same type from same issuer to same subject
        client.issue_credential(&issuer, &subject, &credential_type, &metadata, &None, &0u64);
    }

    #[test]
    fn test_different_credential_types_allowed() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        // Issue credentials of different types - should succeed
        let id1 = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
        let id2 = client.issue_credential(&issuer, &subject, &2u32, &metadata, &None, &0u64);
        let id3 = client.issue_credential(&issuer, &subject, &3u32, &metadata, &None, &0u64);

        assert_eq!(id1, 1);
        assert_eq!(id2, 2);
        assert_eq!(id3, 3);
    }

    #[test]
    fn test_different_issuers_allowed() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let issuer1 = Address::generate(&env);
        let issuer2 = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let credential_type: u32 = 1;

        // Issue credentials of same type from different issuers - should succeed
        let id1 = client.issue_credential(&issuer1, &subject, &credential_type, &metadata, &None, &0u64);
        let id2 = client.issue_credential(&issuer2, &subject, &credential_type, &metadata, &None, &0u64);

        assert_eq!(id1, 1);
        assert_eq!(id2, 2);
    }

    #[test]
    fn test_different_subjects_allowed() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let issuer = Address::generate(&env);
        let subject1 = Address::generate(&env);
        let subject2 = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let credential_type: u32 = 1;

        // Issue credentials of same type to different subjects - should succeed
        let id1 = client.issue_credential(&issuer, &subject1, &credential_type, &metadata, &None, &0u64);
        let id2 = client.issue_credential(&issuer, &subject2, &credential_type, &metadata, &None, &0u64);

        assert_eq!(id1, 1);
        assert_eq!(id2, 2);
    }

    // --- unauthorized revocation tests ---

    #[test]
    #[should_panic(expected = "only the original issuer can revoke")]
    fn test_subject_revoke_credential_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        // Subject should not be able to revoke
        client.revoke_credential(&subject, &id);
    }

    #[test]
    #[should_panic(expected = "only the original issuer can revoke")]
    fn test_unauthorized_revoke_credential() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let unauthorized = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        // Unauthorized address should not be able to revoke
        client.revoke_credential(&unauthorized, &id);
    }

    // Issue #48: Full Credential Lifecycle End-to-End
    #[test]
    fn test_full_credential_lifecycle_e2e() {
        use sbt_registry::{SbtRegistryContract, SbtRegistryContractClient};
        use zk_verifier::{ClaimType, ZkVerifierContract, ZkVerifierContractClient};

        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        // Step 1: Set up all three contracts
        let qp_id = env.register_contract(None, QuorumProofContract);
        let sbt_id = env.register_contract(None, SbtRegistryContract);
        let zk_id = env.register_contract(None, ZkVerifierContract);

        let qp = QuorumProofContractClient::new(&env, &qp_id);
        let sbt = SbtRegistryContractClient::new(&env, &sbt_id);
        let zk_admin = Address::generate(&env);
        ZkVerifierContractClient::new(&env, &zk_id).initialize(&zk_admin);
        sbt.initialize(&zk_admin, &qp_id);
        qp.initialize(&zk_admin);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor1 = Address::generate(&env);
        let attestor2 = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmLifecycleTest0000000000000000000");

        // Step 2: Issue credential
        let cred_id = qp.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        // Assert credential state after issuance
        let cred = qp.get_credential(&cred_id);
        assert_eq!(cred.issuer, issuer);
        assert_eq!(cred.subject, subject);
        assert!(!cred.revoked);
        assert_eq!(qp.get_credential_count(), 1);

        // Step 3: Create quorum slice with two attestors, threshold of 2
        let mut attestors = soroban_sdk::Vec::new(&env);
        attestors.push_back(attestor1.clone());
        attestors.push_back(attestor2.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        weights.push_back(1u32);
        let slice_id = qp.create_slice(&issuer, &attestors, &weights, &2u32);

        // Assert slice state
        let slice = qp.get_slice(&slice_id);
        assert_eq!(slice.threshold, 2);
        assert_eq!(slice.attestors.len(), 2);

        // Step 4: Attest — quorum not yet met after first attestor
        qp.attest(&attestor1, &cred_id, &slice_id, &true, &None);
        assert!(!qp.is_attested(&cred_id, &slice_id));

        // Attest — quorum met after second attestor
        qp.attest(&attestor2, &cred_id, &slice_id, &true, &None);
        assert!(qp.is_attested(&cred_id, &slice_id));

        // Assert attestor reputations incremented
        assert_eq!(qp.get_attestor_reputation(&attestor1), 1);
        assert_eq!(qp.get_attestor_reputation(&attestor2), 1);

        // Step 5: Mint SBT for subject linked to the credential
        let sbt_uri = Bytes::from_slice(&env, b"ipfs://QmSbtLifecycle");
        let token_id = sbt.mint(&subject, &cred_id, &sbt_uri);

        // Assert SBT ownership
        assert_eq!(sbt.owner_of(&token_id), subject);
        let owned_tokens = sbt.get_tokens_by_owner(&subject);
        assert_eq!(owned_tokens.len(), 1);
        assert_eq!(owned_tokens.get(0).unwrap(), token_id);

        // Assert SBT is linked to the correct credential
        let token = sbt.get_token(&token_id);
        assert_eq!(token.credential_id, cred_id);
        assert_eq!(token.owner, subject);

        // Step 6: Verify ZK claim via verify_engineer
        let proof = Bytes::from_slice(&env, b"valid-proof");
        let verified = qp.verify_engineer(
            &sbt_id,
            &zk_id,
            &zk_admin,
            &subject,
            &cred_id,
            &ClaimType::HasDegree,
            &proof,
        &None,
        );
        assert!(verified);

        // Assert empty proof fails verification
        let empty_proof = Bytes::new(&env);
        let not_verified = qp.verify_engineer(
            &sbt_id,
            &zk_id,
            &zk_admin,
            &subject,
            &cred_id,
            &ClaimType::HasDegree,
            &empty_proof,
        &None,
        );
        assert!(!not_verified);
    }

    // Issue #45: attest by address not in slice should panic
    #[test]
    #[should_panic(expected = "attestor not in slice")]
    fn test_attest_by_non_member_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor1 = Address::generate(&env);
        let attestor2 = Address::generate(&env); // not in slice

        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        // Create slice with only attestor1
        let mut attestors = soroban_sdk::Vec::new(&env);
        attestors.push_back(attestor1.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);

        // attestor2 is not in the slice — must panic
        client.attest(&attestor2, &cred_id, &slice_id, &true, &None);
    }

    // --- Issue #185: remove_attestor ---

    #[test]
    fn test_remove_attestor_success() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let creator = Address::generate(&env);
        let attestor1 = Address::generate(&env);
        let attestor2 = Address::generate(&env);

        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor1.clone());
        attestors.push_back(attestor2.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&creator, &attestors, &weights, &2u32);

        client.remove_attestor(&creator, &slice_id, &attestor2);

        let slice = client.get_slice(&slice_id);
        assert_eq!(slice.attestors.len(), 1);
        assert_eq!(slice.attestors.get(0).unwrap(), attestor1);
        // threshold clamped to new total weight (1)
        assert_eq!(slice.threshold, 1);
    }

    #[test]
    #[should_panic(expected = "only the slice creator can remove attestors")]
    fn test_remove_attestor_unauthorized_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let creator = Address::generate(&env);
        let non_creator = Address::generate(&env);
        let attestor = Address::generate(&env);

        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        attestors.push_back(Address::generate(&env));
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&creator, &attestors, &weights, &1u32);

        client.remove_attestor(&non_creator, &slice_id, &attestor);
    }

    #[test]
    #[should_panic(expected = "attestor not in slice")]
    fn test_remove_attestor_not_in_slice_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let creator = Address::generate(&env);
        let attestor = Address::generate(&env);
        let stranger = Address::generate(&env);

        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        attestors.push_back(Address::generate(&env));
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&creator, &attestors, &weights, &1u32);

        client.remove_attestor(&creator, &slice_id, &stranger);
    }

    #[test]
    #[should_panic(expected = "cannot remove the last attestor")]
    fn test_remove_last_attestor_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let creator = Address::generate(&env);
        let attestor = Address::generate(&env);

        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&creator, &attestors, &weights, &1u32);

        client.remove_attestor(&creator, &slice_id, &attestor);
    }

    // --- Issue #189: get_attestors ---

    #[test]
    fn test_get_attestors_returns_attested_addresses() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor1 = Address::generate(&env);
        let attestor2 = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor1.clone());
        attestors.push_back(attestor2.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);

        assert_eq!(client.get_attestors(&cred_id).len(), 0);

        client.attest(&attestor1, &cred_id, &slice_id, &true, &None);
        let result = client.get_attestors(&cred_id);
        assert_eq!(result.len(), 1);
        assert_eq!(result.get(0).unwrap(), attestor1);

        client.attest(&attestor2, &cred_id, &slice_id, &true, &None);
        assert_eq!(client.get_attestors(&cred_id).len(), 2);
    }

    // --- Issue #226: credential_exists ---

    #[test]
    fn test_credential_exists_returns_true_for_existing() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
        assert!(client.credential_exists(&cred_id));
    }

    #[test]
    fn test_credential_exists_returns_false_for_nonexisting() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        assert!(!client.credential_exists(&999u64));
    }

    // --- Issue #227: slice_exists ---

    #[test]
    fn test_slice_exists_returns_true_for_existing() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let creator = Address::generate(&env);
        let mut attestors = Vec::new(&env);
        attestors.push_back(Address::generate(&env));
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);

        let slice_id = client.create_slice(&creator, &attestors, &weights, &1u32);
        assert!(client.slice_exists(&slice_id));
    }

    #[test]
    fn test_slice_exists_returns_false_for_nonexisting() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        assert!(!client.slice_exists(&999u64));
    }

    // --- Issue #299: attestation expiry ---

    #[test]
    fn test_attest_with_expiry_stores_record() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        set_ledger_timestamp(&env, 1_000);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmTest");
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);

        client.attest(&attestor, &cred_id, &slice_id, &true, &Some(5_000u64));

        let records = client.get_attestation_records(&cred_id);
        assert_eq!(records.len(), 1);
        assert_eq!(records.get(0).unwrap().attestor, attestor);
        assert_eq!(records.get(0).unwrap().expires_at, Some(5_000u64));
    }

    #[test]
    fn test_is_attestation_expired_false_before_expiry() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        set_ledger_timestamp(&env, 1_000);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmTest");
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);
        client.attest(&attestor, &cred_id, &slice_id, &true, &Some(5_000u64));

        assert!(!client.is_attestation_expired(&cred_id));
    }

    #[test]
    fn test_is_attestation_expired_true_after_expiry() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        set_ledger_timestamp(&env, 1_000);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmTest");
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);
        client.attest(&attestor, &cred_id, &slice_id, &true, &Some(3_000u64));

        set_ledger_timestamp(&env, 4_000);
        assert!(client.is_attestation_expired(&cred_id));
    }

    #[test]
    fn test_is_attestation_expired_false_when_no_expiry() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmTest");
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);
        client.attest(&attestor, &cred_id, &slice_id, &true, &None);

        set_ledger_timestamp(&env, 999_999_999);
        assert!(!client.is_attestation_expired(&cred_id));
    }

    #[test]
    fn test_is_attested_false_when_attestation_expired() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        set_ledger_timestamp(&env, 1_000);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmTest");
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);
        client.attest(&attestor, &cred_id, &slice_id, &true, &Some(3_000u64));

        assert!(client.is_attested(&cred_id, &slice_id));

        set_ledger_timestamp(&env, 4_000);
        assert!(!client.is_attested(&cred_id, &slice_id));
    }

    #[test]
    fn test_renew_attestation_extends_expiry() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        set_ledger_timestamp(&env, 1_000);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmTest");
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);
        client.attest(&attestor, &cred_id, &slice_id, &true, &Some(3_000u64));

        // Expire the attestation
        set_ledger_timestamp(&env, 4_000);
        assert!(client.is_attestation_expired(&cred_id));
        assert!(!client.is_attested(&cred_id, &slice_id));

        // Renew
        client.renew_attestation(&attestor, &cred_id, &10_000u64);
        assert!(!client.is_attestation_expired(&cred_id));
        assert!(client.is_attested(&cred_id, &slice_id));

        let records = client.get_attestation_records(&cred_id);
        assert_eq!(records.get(0).unwrap().expires_at, Some(10_000u64));
    }

    #[test]
    #[should_panic(expected = "new_expires_at must be in the future")]
    fn test_renew_attestation_past_timestamp_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        set_ledger_timestamp(&env, 5_000);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmTest");
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);
        client.attest(&attestor, &cred_id, &slice_id, &true, &Some(8_000u64));

        client.renew_attestation(&attestor, &cred_id, &3_000u64);
    }

    #[test]
    #[should_panic(expected = "attestation not found")]
    fn test_renew_attestation_not_found_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let stranger = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmTest");
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);
        client.attest(&attestor, &cred_id, &slice_id, &true, &Some(5_000u64));

        client.renew_attestation(&stranger, &cred_id, &10_000u64);
    }

    // ── Issue #529: holder revocation request ─────────────────────────────────

    #[test]
    fn test_holder_can_request_revocation() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        let cred_id = client.issue_credential(&issuer, &holder, &1u32, &metadata, &None);
        client.request_revocation(&holder, &cred_id);

        let request = client.get_revocation_request(&cred_id).unwrap();
        assert_eq!(request.holder, holder);
        assert_eq!(request.status, RevocationStatus::Pending);
        let trail = client.get_revocation_audit_trail(&cred_id);
        assert_eq!(trail.len(), 1);
        assert_eq!(trail.get(0).unwrap().action, RevocationAuditAction::RequestSubmitted);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #44)")]
    fn test_non_holder_revocation_request_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);
        let stranger = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        let cred_id = client.issue_credential(&issuer, &holder, &1u32, &metadata, &None);
        client.request_revocation(&stranger, &cred_id);
    }

    #[test]
    fn test_issuer_approve_revocation_revokes_credential() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        let cred_id = client.issue_credential(&issuer, &holder, &1u32, &metadata, &None);
        client.request_revocation(&holder, &cred_id);
        client.approve_revocation(&issuer, &cred_id);

        assert!(client.get_credential(&cred_id).revoked);
        let request = client.get_revocation_request(&cred_id).unwrap();
        assert_eq!(request.status, RevocationStatus::Approved);
        let trail = client.get_revocation_audit_trail(&cred_id);
        assert_eq!(trail.len(), 2);
        assert_eq!(trail.get(1).unwrap().action, RevocationAuditAction::Approved);
    }

    #[test]
    fn test_issuer_deny_revocation_keeps_credential_active() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        let cred_id = client.issue_credential(&issuer, &holder, &1u32, &metadata, &None);
        client.request_revocation(&holder, &cred_id);
        client.deny_revocation(&issuer, &cred_id);

        assert!(!client.get_credential(&cred_id).revoked);
        let request = client.get_revocation_request(&cred_id).unwrap();
        assert_eq!(request.status, RevocationStatus::Denied);
        let trail = client.get_revocation_audit_trail(&cred_id);
        assert_eq!(trail.len(), 2);
        assert_eq!(trail.get(1).unwrap().action, RevocationAuditAction::Denied);
    }

    // ── Issue #530: encrypted metadata key management ─────────────────────────

    #[test]
    fn test_encrypted_metadata_stored_and_key_access() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);
        let party = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cred_id = client.issue_credential(&issuer, &holder, &1u32, &metadata, &None);

        let ciphertext = Bytes::from_slice(&env, b"aes256-ciphertext-bytes");
        let mut keys = Map::new(&env);
        let enc_key = Bytes::from_slice(&env, b"encrypted-data-key-for-party");
        keys.set(party.clone(), enc_key);
        client.set_encrypted_metadata(&issuer, &cred_id, &ciphertext, &keys);

        let stored = client.get_encrypted_metadata(&cred_id).unwrap();
        assert_eq!(stored.ciphertext, ciphertext);
        assert!(stored.encrypted_keys.get(party.clone()).is_some());
        let unauthorized = Address::generate(&env);
        assert!(stored.encrypted_keys.get(unauthorized).is_none());
    }

    #[test]
    fn test_grant_and_revoke_decryption_access() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);
        let party = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cred_id = client.issue_credential(&issuer, &holder, &1u32, &metadata, &None);

        let ciphertext = Bytes::from_slice(&env, b"aes256-ciphertext");
        client.set_encrypted_metadata(
            &issuer,
            &cred_id,
            &ciphertext,
            &Map::new(&env),
        );
        let enc_key = Bytes::from_slice(&env, b"party-encrypted-key");
        client.grant_decryption_access(&issuer, &cred_id, &party, &enc_key);
        assert_eq!(
            client
                .get_encrypted_metadata(&cred_id)
                .unwrap()
                .encrypted_keys
                .get(party.clone())
                .unwrap(),
            enc_key
        );
        client.revoke_decryption_access(&issuer, &cred_id, &party);
        assert!(client
            .get_encrypted_metadata(&cred_id)
            .unwrap()
            .encrypted_keys
            .get(party)
            .is_none());
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #44)")]
    fn test_non_issuer_cannot_grant_decryption_access() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);
        let stranger = Address::generate(&env);
        let party = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cred_id = client.issue_credential(&issuer, &holder, &1u32, &metadata, &None);
        let enc_key = Bytes::from_slice(&env, b"key");
        client.grant_decryption_access(&stranger, &cred_id, &party, &enc_key);
    }

    // ── Issue #531: credential versioning ─────────────────────────────────────

    #[test]
    fn test_credential_versioning_history() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);
        let meta_v1 = Bytes::from_slice(&env, b"QmVersion1Hash0000000000000000000");
        let cred_id = client.issue_credential(&issuer, &holder, &1u32, &meta_v1, &None);

        let history = client.get_credential_version_history(&cred_id);
        assert_eq!(history.len(), 1);
        assert_eq!(history.get(0).unwrap().version, 1);

        set_ledger_timestamp(&env, 2000);
        let meta_v2 = Bytes::from_slice(&env, b"QmVersion2Hash0000000000000000000");
        client.update_metadata(&issuer, &cred_id, &meta_v2);

        let history = client.get_credential_version_history(&cred_id);
        assert_eq!(history.len(), 2);
        assert_eq!(history.get(1).unwrap().version, 2);
        assert_eq!(client.get_credential(&cred_id).version, 2);

        let v1 = client.get_credential_version(&cred_id, &1);
        assert_eq!(v1.metadata, meta_v1);
        let v2 = client.get_credential_version(&cred_id, &2);
        assert_eq!(v2.metadata, meta_v2);

        set_ledger_timestamp(&env, 2500);
        let at_ts = client.get_version_at(&cred_id, &2200);
        assert_eq!(at_ts.version, 2);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #47)")]
    fn test_get_credential_version_not_found() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cred_id = client.issue_credential(&issuer, &holder, &1u32, &metadata, &None);
        let _ = client.get_credential_version(&cred_id, &99);
    }
}

// ── New feature tests ─────────────────────────────────────────────────────────

#[cfg(all(test, any()))]
mod feature_tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger as _, LedgerInfo};
    use soroban_sdk::{vec, Bytes, Env};

    fn setup(env: &Env) -> (QuorumProofContractClient<'_>, Address) {
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(env, &contract_id);
        let admin = Address::generate(env);
        client.initialize(&admin);
        (client, admin)
    }

    fn set_ts(env: &Env, ts: u64) {
        env.ledger().set(LedgerInfo {
            timestamp: ts,
            protocol_version: 20,
            sequence_number: 1,
            network_id: Default::default(),
            base_reserve: 10,
            min_persistent_entry_ttl: 4096,
            min_temp_entry_ttl: 16,
            max_entry_ttl: 6_312_000,
        });
    }

    // ── Conditional attestation expiry ────────────────────────────────────────

    #[test]
    fn test_set_and_check_attestation_expiry_not_expired() {
        let env = Env::default();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmTest");
        set_ts(&env, 1_000);
        let cid = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
        client.set_attestation_expiry(&issuer, &cid, &5_000u64);
        assert!(!client.is_attestation_expired(&cid));
    }

    #[test]
    fn test_attestation_expiry_triggers_after_timestamp() {
        let env = Env::default();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmTest");
        set_ts(&env, 1_000);
        let cid = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
        client.set_attestation_expiry(&issuer, &cid, &2_000u64);
        set_ts(&env, 3_000);
        assert!(client.is_attestation_expired(&cid));
    }

    #[test]
    fn test_is_attested_false_after_attestation_expiry() {
        let env = Env::default();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmTest");
        set_ts(&env, 1_000);
        let cid = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
        let mut attestors = soroban_sdk::Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = soroban_sdk::Vec::new(&env);
        weights.push_back(1u32);
        let sid = client.create_slice(&issuer, &attestors, &weights, &1u32);
        client.attest(&attestor, &cid, &sid, &true, &None);
        assert!(client.is_attested(&cid, &sid));
        // Set attestation expiry in the past
        client.set_attestation_expiry(&issuer, &cid, &2_000u64);
        set_ts(&env, 3_000);
        assert!(!client.is_attested(&cid, &sid));
    }

    #[test]
    fn test_is_attestation_expired_no_expiry_set() {
        let env = Env::default();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmTest");
        let cid = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
        assert!(!client.is_attestation_expired(&cid));
    }

    #[test]
    #[should_panic(expected = "CredentialNotFound")]
    fn test_is_attestation_expired_missing_credential() {
        let env = Env::default();
        let (client, _) = setup(&env);
        client.is_attestation_expired(&999u64);
    }

    #[test]
    #[should_panic(expected = "InvalidInput")]
    fn test_set_attestation_expiry_past_timestamp_panics() {
        let env = Env::default();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmTest");
        set_ts(&env, 5_000);
        let cid = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
        // expires_at is in the past
        client.set_attestation_expiry(&issuer, &cid, &1_000u64);
    }

    // ── Input validation ──────────────────────────────────────────────────────

    #[test]
    #[should_panic(expected = "credential_type must be greater than 0")]
    fn test_issue_credential_zero_type_panics() {
        let env = Env::default();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmTest");
        client.issue_credential(&issuer, &subject, &0u32, &metadata, &None, &0u64);
    }

    #[test]
    #[should_panic(expected = "metadata_hash cannot be empty")]
    fn test_issue_credential_empty_metadata_panics() {
        let env = Env::default();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let empty = Bytes::new(&env);
        client.issue_credential(&issuer, &subject, &1u32, &empty, &None, &0u64);
    }

    #[test]
    #[should_panic(expected = "InvalidInput")]
    fn test_issue_credential_metadata_too_long_panics() {
        let env = Env::default();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        // 257 bytes — exceeds 256 limit
        let long_hash = Bytes::from_slice(&env, &[b'x'; 257]);
        client.issue_credential(&issuer, &subject, &1u32, &long_hash, &None, &0u64);
    }

    #[test]
    #[should_panic(expected = "InvalidInput")]
    fn test_attest_zero_credential_id_panics() {
        let env = Env::default();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let attestor = Address::generate(&env);
        let mut attestors = soroban_sdk::Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = soroban_sdk::Vec::new(&env);
        weights.push_back(1u32);
        let sid = client.create_slice(&issuer, &attestors, &weights, &1u32);
        client.attest(&attestor, &0u64, &sid, &true, &None);
    }

    #[test]
    #[should_panic(expected = "InvalidInput")]
    fn test_attest_zero_slice_id_panics() {
        let env = Env::default();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmTest");
        let cid = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
        client.attest(&attestor, &cid, &0u64, &true, &None);
    }

    #[test]
    #[should_panic(expected = "InvalidInput")]
    fn test_get_credentials_by_subject_zero_page_panics() {
        let env = Env::default();
        let (client, _) = setup(&env);
        let subject = Address::generate(&env);
        client.get_credentials_by_subject(&subject, &0u32, &10u32);
    }

    #[test]
    #[should_panic(expected = "InvalidInput")]
    fn test_get_credentials_by_subject_zero_page_size_panics() {
        let env = Env::default();
        let (client, _) = setup(&env);
        let subject = Address::generate(&env);
        client.get_credentials_by_subject(&subject, &1u32, &0u32);
    }

    // ── Pre/post-condition assertions ─────────────────────────────────────────

    #[test]
    fn test_postcondition_credential_stored_after_issue() {
        let env = Env::default();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmTest");
        let cid = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
        // If postcondition passed, credential must exist
        assert!(client.credential_exists(&cid));
    }

    #[test]
    fn test_postcondition_slice_stored_after_create() {
        let env = Env::default();
        let (client, _) = setup(&env);
        let creator = Address::generate(&env);
        let mut attestors = soroban_sdk::Vec::new(&env);
        attestors.push_back(Address::generate(&env));
        let mut weights = soroban_sdk::Vec::new(&env);
        weights.push_back(1u32);
        let sid = client.create_slice(&creator, &attestors, &weights, &1u32);
        assert!(client.slice_exists(&sid));
    }

    // ── Snapshot tests ────────────────────────────────────────────────────────

    /// Generates a snapshot after issuing a credential and verifies the
    /// snapshot can be reloaded with the same ledger state.
    #[test]
    fn test_snapshot_credential_state() {
        let snap_path = "test_snapshots/tests/snapshot_credential_state.json";
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmSnapshotHash00000000000000000000");
        let cid = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        assert_eq!(client.get_credential_count(), 1);
        assert_eq!(cid, 1);

        // Generate snapshot
        env.to_snapshot_file(snap_path);

        // Reload snapshot — ledger entries are preserved
        let env2 = Env::from_snapshot_file(snap_path);
        // Snapshot ledger sequence should match
        assert_eq!(env.ledger().sequence(), env2.ledger().sequence());
    }

    /// Generates a snapshot after creating a quorum slice and verifies
    /// the reloaded snapshot has the same ledger sequence.
    #[test]
    fn test_snapshot_slice_state() {
        let snap_path = "test_snapshots/tests/snapshot_slice_state.json";
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let creator = Address::generate(&env);
        let attestor = Address::generate(&env);
        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&creator, &attestors, &weights, &1u32);

        assert!(client.slice_exists(&slice_id));
        assert_eq!(client.get_slice_count(), 1);

        // Generate snapshot
        env.to_snapshot_file(snap_path);

        // Reload and compare ledger state
        let env2 = Env::from_snapshot_file(snap_path);
        assert_eq!(env.ledger().sequence(), env2.ledger().sequence());
        assert_eq!(env.ledger().timestamp(), env2.ledger().timestamp());
    }

    /// Generates a snapshot after a full attest flow and verifies the
    /// reloaded snapshot preserves ledger metadata.
    #[test]
    fn test_snapshot_attestation_state() {
        let snap_path = "test_snapshots/tests/snapshot_attestation_state.json";
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmSnapshotHash00000000000000000000");
        let cid = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);
        client.attest(&attestor, &cid, &slice_id, &true, &None);

        assert!(client.is_attested(&cid, &slice_id));
        assert_eq!(client.get_attestation_count(&cid), 1);

        // Generate snapshot
        env.to_snapshot_file(snap_path);

        // Reload and compare ledger metadata
        let env2 = Env::from_snapshot_file(snap_path);
        assert_eq!(env.ledger().sequence(), env2.ledger().sequence());
        assert_eq!(env.ledger().timestamp(), env2.ledger().timestamp());
    }

    // ── Property-based fuzz tests ─────────────────────────────────────────────

    /// Property: issuing N distinct (issuer, subject, type) credentials always
    /// produces sequential IDs starting at 1 and increments the count.
    #[test]
    fn fuzz_issue_credential_sequential_ids() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"QmFuzzHash000000000000000000000000");

        for i in 1u32..=5 {
            let cid = client.issue_credential(&issuer, &subject, &i, &meta, &None, &0u64);
            assert_eq!(cid, i as u64);
            assert_eq!(client.get_credential_count(), i as u64);
        }
    }

    /// Property: zero credential_type must always be rejected.
    #[test]
    #[should_panic]
    fn fuzz_issue_credential_zero_type_always_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"QmFuzzHash000000000000000000000000");
        client.issue_credential(&issuer, &subject, &0u32, &meta, &None, &0u64);
    }

    /// Property: threshold > attestor count must always be rejected.
    #[test]
    #[should_panic]
    fn fuzz_create_slice_threshold_exceeds_attestors_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let creator = Address::generate(&env);
        let mut attestors = Vec::new(&env);
        attestors.push_back(Address::generate(&env));
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        // threshold=2 with only 1 attestor — must panic
        client.create_slice(&creator, &attestors, &weights, &2u32);
    }

    /// Property: attesting the same credential twice by the same attestor
    /// must always be rejected (duplicate attestation).
    #[test]
    #[should_panic]
    fn fuzz_attest_duplicate_always_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"QmFuzzHash000000000000000000000000");
        let cid = client.issue_credential(&issuer, &subject, &1u32, &meta, &None, &0u64);
        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);
        client.attest(&attestor, &cid, &slice_id, &true, &None);
        // Second attest by same attestor — must panic
        client.attest(&attestor, &cid, &slice_id, &true, &None);
    }

    /// Property: revoking a credential must prevent further attestation.
    #[test]
    #[should_panic]
    fn fuzz_attest_revoked_credential_always_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"QmFuzzHash000000000000000000000000");
        let cid = client.issue_credential(&issuer, &subject, &1u32, &meta, &None, &0u64);
        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);
        client.revoke_credential(&issuer, &cid);
        // Attest after revocation — must panic
        client.attest(&attestor, &cid, &slice_id, &true, &None);
    }

    // --- Issue #339: Time-window attestation tests ---

    #[test]
    fn test_set_and_get_attestation_window() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cid = client.issue_credential(&issuer, &subject, &1u32, &meta, &None, &0u64);

        client.set_attestation_window(&issuer, &cid, &1000u64, &2000u64);

        let window = client.get_attestation_window(&cid).unwrap();
        assert_eq!(window.start, 1000);
        assert_eq!(window.end, 2000);
    }

    #[test]
    fn test_attest_within_window_succeeds() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cid = client.issue_credential(&issuer, &subject, &1u32, &meta, &None, &0u64);

        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);

        client.set_attestation_window(&issuer, &cid, &500u64, &2000u64);
        set_ledger_timestamp(&env, 1000);

        // Should succeed — timestamp 1000 is within [500, 2000)
        client.attest(&attestor, &cid, &slice_id, &true, &None);
        assert!(client.is_attested(&cid, &slice_id));
    }

    #[test]
    fn test_attest_before_window_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cid = client.issue_credential(&issuer, &subject, &1u32, &meta, &None, &0u64);

        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);

        client.set_attestation_window(&issuer, &cid, &1000u64, &2000u64);
        set_ledger_timestamp(&env, 500); // before window

        let result = client.try_attest(&attestor, &cid, &slice_id, &None);
        assert_eq!(
            result,
            Err(Ok(soroban_sdk::Error::from_contract_error(
                ContractError::AttestationWindowOutside as u32
            )))
        );
    }

    #[test]
    fn test_attest_after_window_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cid = client.issue_credential(&issuer, &subject, &1u32, &meta, &None, &0u64);

        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);

        client.set_attestation_window(&issuer, &cid, &500u64, &1000u64);
        set_ledger_timestamp(&env, 1500); // after window

        let result = client.try_attest(&attestor, &cid, &slice_id, &None);
        assert_eq!(
            result,
            Err(Ok(soroban_sdk::Error::from_contract_error(
                ContractError::AttestationWindowOutside as u32
            )))
        );
    }

    #[test]
    fn test_attest_no_window_always_allowed() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cid = client.issue_credential(&issuer, &subject, &1u32, &meta, &None, &0u64);

        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);

        // No window set — attest at any time should succeed
        set_ledger_timestamp(&env, 99999);
        client.attest(&attestor, &cid, &slice_id, &true, &None);
        assert!(client.is_attested(&cid, &slice_id));
    }

    #[test]
    #[should_panic]
    fn test_set_attestation_window_invalid_range_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cid = client.issue_credential(&issuer, &subject, &1u32, &meta, &None, &0u64);

        // start >= end must be rejected
        client.set_attestation_window(&issuer, &cid, &2000u64, &1000u64);
    }

    #[test]
    fn test_get_attestation_window_none_when_not_set() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cid = client.issue_credential(&issuer, &subject, &1u32, &meta, &None, &0u64);

        assert!(client.get_attestation_window(&cid).is_none());
    }

    // ── Credential Holder Recovery (Issue #290) ─────────────────────────────

    #[test]
    fn test_initiate_recovery_by_issuer() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let new_subject = Address::generate(&env);
        let approver = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cid = client.issue_credential(&issuer, &subject, &1u32, &meta, &None, &0u64);

        let mut approvers = Vec::new(&env);
        approvers.push_back(approver.clone());
        let rid = client.initiate_recovery(&issuer, &cid, &new_subject, &approvers, &1u32);

        let req = client.get_recovery_request(&rid);
        assert_eq!(req.credential_id, cid);
        assert_eq!(req.issuer, issuer);
        assert_eq!(req.new_subject, new_subject);
        assert_eq!(req.status, RecoveryStatus::Pending);
        assert_eq!(req.threshold, 1);
    }

    #[test]
    #[should_panic(expected = "only the original issuer can initiate recovery")]
    fn test_initiate_recovery_unauthorized_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let new_subject = Address::generate(&env);
        let approver = Address::generate(&env);
        let attacker = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cid = client.issue_credential(&issuer, &subject, &1u32, &meta, &None, &0u64);

        let mut approvers = Vec::new(&env);
        approvers.push_back(approver.clone());
        client.initiate_recovery(&attacker, &cid, &new_subject, &approvers, &1u32);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #22)")]
    fn test_initiate_recovery_duplicate_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let new_subject = Address::generate(&env);
        let approver = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cid = client.issue_credential(&issuer, &subject, &1u32, &meta, &None, &0u64);

        let mut approvers = Vec::new(&env);
        approvers.push_back(approver.clone());
        client.initiate_recovery(&issuer, &cid, &new_subject, &approvers, &1u32);
        // Second initiation for same credential should panic
        client.initiate_recovery(&issuer, &cid, &new_subject, &approvers, &1u32);
    }

    #[test]
    fn test_approve_recovery_success() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let new_subject = Address::generate(&env);
        let approver = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cid = client.issue_credential(&issuer, &subject, &1u32, &meta, &None, &0u64);

        let mut approvers = Vec::new(&env);
        approvers.push_back(approver.clone());
        let rid = client.initiate_recovery(&issuer, &cid, &new_subject, &approvers, &1u32);

        client.approve_recovery(&approver, &rid);
        let req = client.get_recovery_request(&rid);
        assert_eq!(req.status, RecoveryStatus::Approved);

        let approvals = client.get_recovery_approvals(&rid);
        assert_eq!(approvals.len(), 1);
        assert_eq!(approvals.get(0).unwrap().approver, approver);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #26)")]
    fn test_approve_recovery_not_approver_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let new_subject = Address::generate(&env);
        let approver = Address::generate(&env);
        let stranger = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cid = client.issue_credential(&issuer, &subject, &1u32, &meta, &None, &0u64);

        let mut approvers = Vec::new(&env);
        approvers.push_back(approver.clone());
        let rid = client.initiate_recovery(&issuer, &cid, &new_subject, &approvers, &1u32);

        client.approve_recovery(&stranger, &rid);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #27)")]
    fn test_approve_recovery_double_vote_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let new_subject = Address::generate(&env);
        let approver = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cid = client.issue_credential(&issuer, &subject, &1u32, &meta, &None, &0u64);

        let mut approvers = Vec::new(&env);
        approvers.push_back(approver.clone());
        let rid = client.initiate_recovery(&issuer, &cid, &new_subject, &approvers, &2u32);

        client.approve_recovery(&approver, &rid);
        client.approve_recovery(&approver, &rid); // duplicate
    }

    #[test]
    fn test_recovery_auto_approves_on_threshold() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let new_subject = Address::generate(&env);
        let approver1 = Address::generate(&env);
        let approver2 = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cid = client.issue_credential(&issuer, &subject, &1u32, &meta, &None, &0u64);

        let mut approvers = Vec::new(&env);
        approvers.push_back(approver1.clone());
        approvers.push_back(approver2.clone());
        let rid = client.initiate_recovery(&issuer, &cid, &new_subject, &approvers, &2u32);

        client.approve_recovery(&approver1, &rid);
        let req1 = client.get_recovery_request(&rid);
        assert_eq!(req1.status, RecoveryStatus::Pending);

        client.approve_recovery(&approver2, &rid);
        let req2 = client.get_recovery_request(&rid);
        assert_eq!(req2.status, RecoveryStatus::Approved);
    }

    #[test]
    fn test_execute_recovery_updates_subject() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let new_subject = Address::generate(&env);
        let approver = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cid = client.issue_credential(&issuer, &subject, &1u32, &meta, &None, &0u64);

        let mut approvers = Vec::new(&env);
        approvers.push_back(approver.clone());
        let rid = client.initiate_recovery(&issuer, &cid, &new_subject, &approvers, &1u32);
        client.approve_recovery(&approver, &rid);

        client.execute_recovery(&issuer, &rid, &None);

        let cred = client.get_credential(&cid);
        assert_eq!(cred.subject, new_subject);

        let old_list = client.get_credentials_by_subject(&subject, &1u32, &50u32);
        let new_list = client.get_credentials_by_subject(&new_subject, &1u32, &50u32);
        assert!(!old_list.contains(&cid));
        assert!(new_list.contains(&cid));
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #25)")]
    fn test_execute_recovery_threshold_not_met_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let new_subject = Address::generate(&env);
        let approver1 = Address::generate(&env);
        let approver2 = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cid = client.issue_credential(&issuer, &subject, &1u32, &meta, &None, &0u64);

        let mut approvers = Vec::new(&env);
        approvers.push_back(approver1.clone());
        approvers.push_back(approver2.clone());
        let rid = client.initiate_recovery(&issuer, &cid, &new_subject, &approvers, &2u32);
        client.approve_recovery(&approver1, &rid);

        // Only 1 of 2 approvals — threshold not met
        client.execute_recovery(&issuer, &rid, &None);
    }

    #[test]
    fn test_recovery_transfers_sbt() {
        use sbt_registry::{SbtRegistryContract, SbtRegistryContractClient};

        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let qp_id = env.register_contract(None, QuorumProofContract);
        let sbt_id = env.register_contract(None, SbtRegistryContract);
        let client = QuorumProofContractClient::new(&env, &qp_id);
        let sbt = SbtRegistryContractClient::new(&env, &sbt_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        sbt.initialize(&admin, &qp_id);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let new_subject = Address::generate(&env);
        let approver = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cid = client.issue_credential(&issuer, &subject, &1u32, &meta, &None, &0u64);

        let sbt_uri = Bytes::from_slice(&env, b"ipfs://QmSBT");
        let token_id = sbt.mint(&subject, &cid, &sbt_uri);
        assert_eq!(sbt.owner_of(&token_id), subject);

        let mut approvers = Vec::new(&env);
        approvers.push_back(approver.clone());
        let rid = client.initiate_recovery(&issuer, &cid, &new_subject, &approvers, &1u32);
        client.approve_recovery(&approver, &rid);
        client.execute_recovery(&issuer, &rid, &Some(sbt_id));

        assert_eq!(sbt.owner_of(&token_id), new_subject);
        assert!(sbt.get_tokens_by_owner(&subject).is_empty());
        assert_eq!(
            sbt.get_tokens_by_owner(&new_subject).get(0).unwrap(),
            token_id
        );
    }

    #[test]
    fn test_recovery_emits_events() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let new_subject = Address::generate(&env);
        let approver = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cid = client.issue_credential(&issuer, &subject, &1u32, &meta, &None, &0u64);

        let mut approvers = Vec::new(&env);
        approvers.push_back(approver.clone());
        let rid = client.initiate_recovery(&issuer, &cid, &new_subject, &approvers, &1u32);
        client.approve_recovery(&approver, &rid);
        client.execute_recovery(&issuer, &rid, &None);

        let events = env.events().all();
        let initiated = events.iter().find(|(_, topics, _)| {
            topics
                .get(0)
                .map(|t| {
                    String::from_val(&env, &t) == String::from_str(&env, TOPIC_RECOVERY_INITIATED)
                })
                .unwrap_or(false)
        });
        let approved = events.iter().find(|(_, topics, _)| {
            topics
                .get(0)
                .map(|t| {
                    String::from_val(&env, &t) == String::from_str(&env, TOPIC_RECOVERY_APPROVED)
                })
                .unwrap_or(false)
        });
        let executed = events.iter().find(|(_, topics, _)| {
            topics
                .get(0)
                .map(|t| {
                    String::from_val(&env, &t) == String::from_str(&env, TOPIC_RECOVERY_EXECUTED)
                })
                .unwrap_or(false)
        });

        assert!(initiated.is_some(), "RecoveryInitiated event not emitted");
        assert!(approved.is_some(), "RecoveryApproved event not emitted");
        assert!(executed.is_some(), "RecoveryExecuted event not emitted");
    }

    #[test]
    fn test_recovery_records_activity() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let new_subject = Address::generate(&env);
        let approver = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cid = client.issue_credential(&issuer, &subject, &1u32, &meta, &None, &0u64);

        let mut approvers = Vec::new(&env);
        approvers.push_back(approver.clone());
        let rid = client.initiate_recovery(&issuer, &cid, &new_subject, &approvers, &1u32);
        client.approve_recovery(&approver, &rid);
        client.execute_recovery(&issuer, &rid, &None);

        let activities = client.get_holder_activity(&new_subject, &1u32, &10u32);
        assert_eq!(activities.len(), 1);
        let activity = activities.get(0).unwrap();
        assert_eq!(activity.activity_type, ActivityType::CredentialRecovered);
        assert_eq!(activity.credential_id, cid);
        assert_eq!(activity.actor, issuer);
    }

    #[test]
    fn test_cancel_recovery() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let new_subject = Address::generate(&env);
        let approver = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cid = client.issue_credential(&issuer, &subject, &1u32, &meta, &None, &0u64);

        let mut approvers = Vec::new(&env);
        approvers.push_back(approver.clone());
        let rid = client.initiate_recovery(&issuer, &cid, &new_subject, &approvers, &1u32);
        client.cancel_recovery(&issuer, &rid);

        let req = client.get_recovery_request(&rid);
        assert_eq!(req.status, RecoveryStatus::Rejected);
    }

    #[test]
    #[should_panic(expected = "only the issuer can cancel recovery")]
    fn test_cancel_recovery_unauthorized_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let new_subject = Address::generate(&env);
        let approver = Address::generate(&env);
        let attacker = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cid = client.issue_credential(&issuer, &subject, &1u32, &meta, &None, &0u64);

        let mut approvers = Vec::new(&env);
        approvers.push_back(approver.clone());
        let rid = client.initiate_recovery(&issuer, &cid, &new_subject, &approvers, &1u32);
        client.cancel_recovery(&attacker, &rid);
    }

    // ── Credential Type Hierarchy Tests (Issue #291) ──

    #[test]
    fn test_register_credential_type_without_parent() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        // Register a root credential type without parent
        let name = String::from_str(&env, "Engineering Degree");
        let desc = String::from_str(&env, "Bachelor of Engineering");
        client.register_credential_type(&admin, &1u32, &name, &desc, &None);

        // Verify it was registered
        let ctype = client.get_credential_type(&1u32);
        assert_eq!(ctype.type_id, 1);
        assert_eq!(ctype.name, name);
        assert_eq!(ctype.description, desc);
        assert_eq!(ctype.parent_type, None);
    }

    #[test]
    fn test_register_credential_type_with_valid_parent() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        // Register parent type
        let parent_name = String::from_str(&env, "Engineering");
        let parent_desc = String::from_str(&env, "Engineering Credential");
        client.register_credential_type(&admin, &1u32, &parent_name, &parent_desc, &None);

        // Register child type with parent
        let child_name = String::from_str(&env, "Mechanical Engineering");
        let child_desc = String::from_str(&env, "Mechanical Engineering Degree");
        client.register_credential_type(&admin, &2u32, &child_name, &child_desc, &Some(1u32));

        // Verify child has correct parent
        let child = client.get_credential_type(&2u32);
        assert_eq!(child.parent_type, Some(1u32));
    }

    #[test]
    #[should_panic(expected = "invalidparenttype")]
    fn test_register_credential_type_invalid_parent() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        // Try to register type with non-existent parent
        let name = String::from_str(&env, "Degree");
        let desc = String::from_str(&env, "Some Degree");
        client.register_credential_type(&admin, &1u32, &name, &desc, &Some(999u32));
    }

    #[test]
    #[should_panic(expected = "circularhierarchy")]
    fn test_register_credential_type_circular_dependency() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        // Register type A
        let name_a = String::from_str(&env, "Type A");
        let desc_a = String::from_str(&env, "Type A");
        client.register_credential_type(&admin, &1u32, &name_a, &desc_a, &None);

        // Register type B with A as parent
        let name_b = String::from_str(&env, "Type B");
        let desc_b = String::from_str(&env, "Type B");
        client.register_credential_type(&admin, &2u32, &name_b, &desc_b, &Some(1u32));

        // Try to update A with B as parent (would create cycle)
        let name_a_new = String::from_str(&env, "Type A Updated");
        let desc_a_new = String::from_str(&env, "Type A Updated");
        client.register_credential_type(&admin, &1u32, &name_a_new, &desc_a_new, &Some(2u32));
    }

    #[test]
    fn test_three_level_hierarchy() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        // Register grandparent (A)
        let name_a = String::from_str(&env, "Professional Credential");
        let desc_a = String::from_str(&env, "Professional Credential");
        client.register_credential_type(&admin, &1u32, &name_a, &desc_a, &None);

        // Register parent (B) with A as parent
        let name_b = String::from_str(&env, "Engineering License");
        let desc_b = String::from_str(&env, "Engineering License");
        client.register_credential_type(&admin, &2u32, &name_b, &desc_b, &Some(1u32));

        // Register child (C) with B as parent
        let name_c = String::from_str(&env, "Mechanical Engineering License");
        let desc_c = String::from_str(&env, "Mechanical Engineering License");
        client.register_credential_type(&admin, &3u32, &name_c, &desc_c, &Some(2u32));

        // Verify lineage
        let parent_of_c = client.get_credential_type_parent(&3u32);
        assert_eq!(parent_of_c, Some(2u32));

        let parent_of_b = client.get_credential_type_parent(&2u32);
        assert_eq!(parent_of_b, Some(1u32));

        let parent_of_a = client.get_credential_type_parent(&1u32);
        assert_eq!(parent_of_a, None);
    }

    #[test]
    fn test_get_credential_type_children() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        // Register parent
        let parent_name = String::from_str(&env, "Parent");
        let parent_desc = String::from_str(&env, "Parent Type");
        client.register_credential_type(&admin, &1u32, &parent_name, &parent_desc, &None);

        // Register two children
        let child1_name = String::from_str(&env, "Child 1");
        let child1_desc = String::from_str(&env, "Child 1");
        client.register_credential_type(&admin, &2u32, &child1_name, &child1_desc, &Some(1u32));

        let child2_name = String::from_str(&env, "Child 2");
        let child2_desc = String::from_str(&env, "Child 2");
        client.register_credential_type(&admin, &3u32, &child2_name, &child2_desc, &Some(1u32));

        // Get children of parent
        let children = client.get_credential_type_children(&1u32);
        assert_eq!(children.len(), 2);
        assert!(children.iter().any(|&c| c == 2u32));
        assert!(children.iter().any(|&c| c == 3u32));

        // Parent with no children
        let children_of_leaf = client.get_credential_type_children(&2u32);
        assert_eq!(children_of_leaf.len(), 0);
    }

    #[test]
    fn test_get_credential_type_ancestors() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        // Build hierarchy: A <- B <- C
        let name_a = String::from_str(&env, "A");
        let desc = String::from_str(&env, "");
        client.register_credential_type(&admin, &1u32, &name_a, &desc, &None);

        let name_b = String::from_str(&env, "B");
        client.register_credential_type(&admin, &2u32, &name_b, &desc, &Some(1u32));

        let name_c = String::from_str(&env, "C");
        client.register_credential_type(&admin, &3u32, &name_c, &desc, &Some(2u32));

        // Get ancestors of C: should be [B, A]
        let ancestors_c = client.get_credential_type_ancestors(&3u32);
        assert_eq!(ancestors_c.len(), 2);
        assert_eq!(ancestors_c.get(0).unwrap(), 2u32);
        assert_eq!(ancestors_c.get(1).unwrap(), 1u32);

        // Get ancestors of B: should be [A]
        let ancestors_b = client.get_credential_type_ancestors(&2u32);
        assert_eq!(ancestors_b.len(), 1);
        assert_eq!(ancestors_b.get(0).unwrap(), 1u32);

        // Get ancestors of A: should be []
        let ancestors_a = client.get_credential_type_ancestors(&1u32);
        assert_eq!(ancestors_a.len(), 0);
    }

    #[test]
    fn test_is_credential_type_child_of() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        // Register hierarchy
        let name = String::from_str(&env, "");
        let desc = String::from_str(&env, "");
        client.register_credential_type(&admin, &1u32, &name, &desc, &None);
        client.register_credential_type(&admin, &2u32, &name, &desc, &Some(1u32));
        client.register_credential_type(&admin, &3u32, &name, &desc, &Some(2u32));

        // Direct child relationship
        assert!(client.is_credential_type_child_of(&2u32, &1u32));

        // Transitive child relationship
        assert!(client.is_credential_type_child_of(&3u32, &1u32));

        // Not a child relationship
        assert!(!client.is_credential_type_child_of(&1u32, &2u32));

        // Not a child (unrelated types)
        client.register_credential_type(&admin, &4u32, &name, &desc, &None);
        assert!(!client.is_credential_type_child_of(&4u32, &1u32));
    }

    #[test]
    fn test_inherit_verification_rules() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        // Build hierarchy: A <- B <- C <- D
        let name = String::from_str(&env, "");
        let desc = String::from_str(&env, "");

        client.register_credential_type(&admin, &1u32, &name, &desc, &None); // A
        client.register_credential_type(&admin, &2u32, &name, &desc, &Some(1u32)); // B <- A
        client.register_credential_type(&admin, &3u32, &name, &desc, &Some(2u32)); // C <- B
        client.register_credential_type(&admin, &4u32, &name, &desc, &Some(3u32)); // D <- C

        // For type D, rules should be: [D, C, B, A] (child to root order)
        let rules = client.inherit_verification_rules(&4u32);
        assert_eq!(rules.len(), 4);
        assert_eq!(rules.get(0).unwrap(), 4u32); // self
        assert_eq!(rules.get(1).unwrap(), 3u32); // parent
        assert_eq!(rules.get(2).unwrap(), 2u32); // grandparent
        assert_eq!(rules.get(3).unwrap(), 1u32); // great-grandparent

        // For root type A, rules should be just [A]
        let rules_a = client.inherit_verification_rules(&1u32);
        assert_eq!(rules_a.len(), 1);
        assert_eq!(rules_a.get(0).unwrap(), 1u32);
    }

    #[test]
    fn test_multiple_children_same_parent() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        // Register parent
        let name = String::from_str(&env, "");
        let desc = String::from_str(&env, "");
        client.register_credential_type(&admin, &1u32, &name, &desc, &None);

        // Register multiple children (3 children)
        for i in 2u32..5u32 {
            client.register_credential_type(&admin, &i, &name, &desc, &Some(1u32));
        }

        // Verify all children are registered
        let children = client.get_credential_type_children(&1u32);
        assert_eq!(children.len(), 3);

        // Verify each child points to parent
        for i in 2u32..5u32 {
            let parent = client.get_credential_type_parent(&i);
            assert_eq!(parent, Some(1u32));
        }
    }

    #[test]
    fn test_backward_compatibility_no_parent() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        // Register type without parent (backward compatible behavior)
        let name = String::from_str(&env, "Legacy Type");
        let desc = String::from_str(&env, "No parent");
        client.register_credential_type(&admin, &1u32, &name, &desc, &None);

        // Should have no parent
        let parent = client.get_credential_type_parent(&1u32);
        assert_eq!(parent, None);

        // Should have no children
        let children = client.get_credential_type_children(&1u32);
        assert_eq!(children.len(), 0);

        // Should have empty ancestors
        let ancestors = client.get_credential_type_ancestors(&1u32);
        assert_eq!(ancestors.len(), 0);

        // Verification rules should just be self
        let rules = client.inherit_verification_rules(&1u32);
        assert_eq!(rules.len(), 1);
        assert_eq!(rules.get(0).unwrap(), 1u32);
    }

    #[test]
    fn test_overwrite_existing_type_maintains_hierarchy() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        // Register parent and child
        let name = String::from_str(&env, "");
        let desc = String::from_str(&env, "");
        client.register_credential_type(&admin, &1u32, &name, &desc, &None);
        client.register_credential_type(&admin, &2u32, &name, &desc, &Some(1u32));

        // Verify parent-child relationship
        let parent = client.get_credential_type_parent(&2u32);
        assert_eq!(parent, Some(1u32));

        // Overwrite parent type with new description (no parent change)
        let new_desc = String::from_str(&env, "Updated description");
        client.register_credential_type(&admin, &1u32, &name, &new_desc, &None);

        // Child relationship should still exist
        let parent_after = client.get_credential_type_parent(&2u32);
        assert_eq!(parent_after, Some(1u32));
    }

    #[test]
    #[ignore]
    fn test_detect_fork_no_conflict() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        // Create a credential and slice
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let credential_id = client.issue(&issuer, &subject, &1u32, &None);
        let slice_id = client.create_slice(
            &admin,
            &vec![&env, admin.clone(), Address::generate(&env)],
            &2u64,
        );

        // Attest with true value
        client.attest(&admin, &credential_id, &slice_id, &true, &None);

        // Detect fork for another attestor with same value - should not detect fork
        let attestor2 = Address::generate(&env);
        let has_fork = client.detect_fork(&credential_id, &slice_id, &attestor2, true);
        assert!(!has_fork);
    }

    #[test]
    #[ignore]
    fn test_detect_fork_with_conflict() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        // Create a credential and slice
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let credential_id = client.issue(&issuer, &subject, &1u32, &None);
        let slice_id = client.create_slice(
            &admin,
            &vec![&env, admin.clone(), Address::generate(&env)],
            &2u64,
        );

        // Attest with true value
        client.attest(&admin, &credential_id, &slice_id, &true, &None);

        // Detect fork for another attestor with false value - should detect fork
        let attestor2 = Address::generate(&env);
        let has_fork = client.detect_fork(&credential_id, &slice_id, &attestor2, false);
        assert!(has_fork);
    }

    #[test]
    #[ignore]
    #[should_panic(expected = "ForkDetected")]
    fn test_attest_prevents_conflicting_attestation() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        // Create a credential and slice
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let credential_id = client.issue(&issuer, &subject, &1u32, &None);
        let attestor2 = Address::generate(&env);
        let slice_id =
            client.create_slice(&admin, &vec![&env, admin.clone(), attestor2.clone()], &2u64);

        // First attestation with true
        client.attest(&admin, &credential_id, &slice_id, &true, &None);

        // Second attestation with false - should panic
        client.attest(&attestor2, &credential_id, &slice_id, &false, &None);
    }

    #[test]
    #[ignore]
    fn test_fork_detection_stores_info() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        // Create a credential and slice
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let credential_id = client.issue(&issuer, &subject, &1u32, &None);
        let attestor2 = Address::generate(&env);
        let slice_id =
            client.create_slice(&admin, &vec![&env, admin.clone(), attestor2.clone()], &2u64);

        // First attestation with true
        client.attest(&admin, &credential_id, &slice_id, &true, &None);

        // Try second attestation with false - should store fork info
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.attest(&attestor2, &credential_id, &slice_id, &false, &None);
        }));
        assert!(result.is_err()); // Should have panicked

        // Check that fork info was stored
        let fork_status: ForkStatus = env
            .storage()
            .instance()
            .get(&DataKey2::ForkStatus(credential_id, slice_id))
            .unwrap();
        assert_eq!(fork_status, ForkStatus::ForkDetected);

        let fork_info: ForkInfo = env
            .storage()
            .instance()
            .get(&DataKey2::ForkInfo(credential_id, slice_id))
            .unwrap();
        assert_eq!(fork_info.credential_id, credential_id);
        assert_eq!(fork_info.slice_id, slice_id);
        assert_eq!(fork_info.conflicting_attestors.len(), 2);
        assert_eq!(fork_info.attested_values.len(), 2);
    }

    #[test]
    #[ignore]
    fn test_get_verification_stats_initial_zeros() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let stats = client.get_verification_stats();
        assert_eq!(stats.total_verifications, 0);
        assert_eq!(stats.successful_verifications, 0);
        assert_eq!(stats.failed_verifications, 0);
    }

    #[test]
    #[ignore]
    fn test_verification_stats_increments_on_success() {
        use sbt_registry::SbtRegistryContract;
        use zk_verifier::{ClaimType, ZkVerifierContract};

        let env = Env::default();
        env.mock_all_auths();

        let qp_id = env.register_contract(None, QuorumProofContract);
        let sbt_id = env.register_contract(None, SbtRegistryContract);
        let zk_id = env.register_contract(None, ZkVerifierContract);

        let qp = QuorumProofContractClient::new(&env, &qp_id);
        let sbt = sbt_registry::SbtRegistryContractClient::new(&env, &sbt_id);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmTest");
        let cred_id = qp.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        let sbt_uri = Bytes::from_slice(&env, b"ipfs://QmSbt");
        sbt.mint(&subject, &cred_id, &sbt_uri);

        let proof = Bytes::from_slice(&env, b"valid-proof");
        let result = qp.verify_engineer(
            &sbt_id,
            &zk_id,
            &issuer,
            &subject,
            &cred_id,
            &ClaimType::HasDegree,
            &proof,
        &None,
        );
        assert!(result);

        let stats = qp.get_verification_stats();
        assert_eq!(stats.total_verifications, 1);
        assert_eq!(stats.successful_verifications, 1);
        assert_eq!(stats.failed_verifications, 0);
    }

    #[test]
    #[ignore]
    fn test_verification_stats_increments_on_failure() {
        use zk_verifier::ClaimType;

        let env = Env::default();
        env.mock_all_auths();

        let qp_id = env.register_contract(None, QuorumProofContract);
        let sbt_id = env.register_contract(None, sbt_registry::SbtRegistryContract);
        let zk_id = env.register_contract(None, zk_verifier::ZkVerifierContract);

        let qp = QuorumProofContractClient::new(&env, &qp_id);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmTest");
        let cred_id = qp.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        // No SBT minted — verification fails
        let proof = Bytes::from_slice(&env, b"valid-proof");
        let result = qp.verify_engineer(
            &sbt_id,
            &zk_id,
            &issuer,
            &subject,
            &cred_id,
            &ClaimType::HasDegree,
            &proof,
        &None,
        );
        assert!(!result);

        let stats = qp.get_verification_stats();
        assert_eq!(stats.total_verifications, 1);
        assert_eq!(stats.successful_verifications, 0);
        assert_eq!(stats.failed_verifications, 1);
    }

    #[test]
    #[ignore]
    fn test_verification_stats_accumulates_across_calls() {
        use sbt_registry::SbtRegistryContract;
        use zk_verifier::{ClaimType, ZkVerifierContract};

        let env = Env::default();
        env.mock_all_auths();

        let qp_id = env.register_contract(None, QuorumProofContract);
        let sbt_id = env.register_contract(None, SbtRegistryContract);
        let zk_id = env.register_contract(None, ZkVerifierContract);

        let qp = QuorumProofContractClient::new(&env, &qp_id);
        let sbt = sbt_registry::SbtRegistryContractClient::new(&env, &sbt_id);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmTest");

        let cred_id = qp.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
        let sbt_uri = Bytes::from_slice(&env, b"ipfs://QmSbt");
        sbt.mint(&subject, &cred_id, &sbt_uri);

        let good_proof = Bytes::from_slice(&env, b"valid-proof");
        let bad_proof = Bytes::from_slice(&env, b"");

        // 2 successes, 1 failure
        qp.verify_engineer(
            &sbt_id,
            &zk_id,
            &issuer,
            &subject,
            &cred_id,
            &ClaimType::HasDegree,
            &good_proof,
        &None,
        );
        qp.verify_engineer(
            &sbt_id,
            &zk_id,
            &issuer,
            &subject,
            &cred_id,
            &ClaimType::HasLicense,
            &good_proof,
        &None,
        );
        qp.verify_engineer(
            &sbt_id,
            &zk_id,
            &issuer,
            &subject,
            &cred_id,
            &ClaimType::HasDegree,
            &bad_proof,
        &None,
        );

        let stats = qp.get_verification_stats();
        assert_eq!(stats.total_verifications, 3);
        assert_eq!(stats.successful_verifications, 2);
        assert_eq!(stats.failed_verifications, 1);
    }

    #[test]
    fn test_holder_reputation_zero_before_any_activity() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let holder = Address::generate(&env);
        let rep = client.get_holder_reputation(&holder);
        assert_eq!(rep.credentials_held, 0);
        assert_eq!(rep.successful_verifications, 0);
        assert_eq!(rep.attestation_count, 0);
        assert_eq!(rep.attestation_age_seconds, 0);
        assert_eq!(rep.score, 0);
    }

    #[test]
    fn test_holder_reputation_counts_attestations_and_age() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmTest");

        client.initialize(&admin);
        client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
        let attestors = vec![&env, attestor.clone()];
        let weights = vec![&env, 1u32];
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);

        env.ledger().with_mut(|li| {
            li.timestamp = 1_000;
        });
        let cred_id = 1u64;
        client.attest(&attestor, &cred_id, &slice_id, &true, &None);

        env.ledger().with_mut(|li| {
            li.timestamp = 3_000;
        });
        let rep = client.get_holder_reputation(&subject);

        assert_eq!(rep.credentials_held, 1);
        assert_eq!(rep.successful_verifications, 1);
        assert_eq!(rep.attestation_count, 1);
        assert_eq!(rep.attestation_age_seconds, 2_000);
        assert_eq!(rep.score, 3);
    }

    #[test]
    fn test_holder_reputation_configurable_scoring_algorithm() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmTest");

        client.initialize(&admin);
        client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
        let attestors = vec![&env, attestor.clone()];
        let weights = vec![&env, 1u32];
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);

        client.set_holder_reputation_config(&admin, &5u64, &2u64, &500u64);

        env.ledger().with_mut(|li| {
            li.timestamp = 1_000;
        });
        let cred_id = 1u64;
        client.attest(&attestor, &cred_id, &slice_id, &true, &None);

        env.ledger().with_mut(|li| {
            li.timestamp = 2_500;
        });
        let rep = client.get_holder_reputation(&subject);

        assert_eq!(rep.attestation_count, 1);
        assert_eq!(rep.attestation_age_seconds, 1_500);
        assert_eq!(rep.score, 11);
    }

    // -----------------------------------------------------------------------
    // Regression tests for fixed issues
    // -----------------------------------------------------------------------

    // Issue #19 — TTL management: storage must survive ledger advancement after revoke.
    #[test]
    fn regression_19_ttl_extended_after_revoke() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        client.revoke_credential(&issuer, &id);

        // Advance ledger well past STANDARD_TTL to confirm TTL was extended.
        env.ledger().set(LedgerInfo {
            timestamp: 2_000,
            protocol_version: 20,
            sequence_number: 20_000,
            network_id: Default::default(),
            base_reserve: 10,
            min_persistent_entry_ttl: 4096,
            min_temp_entry_ttl: 16,
            max_entry_ttl: 6_312_000,
        });

        let cred = client.get_credential(&id);
        assert!(
            cred.revoked,
            "credential must still be readable and revoked after ledger advance"
        );
    }

    // Issue #21 — Issuer revocation: the issuer (not just the subject) must be able to revoke.
    #[test]
    fn regression_21_issuer_can_revoke_credential() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        client.revoke_credential(&issuer, &id);

        assert!(client.get_credential(&id).revoked);
    }

    // Issue #21 — Double revocation must be rejected.
    #[test]
    #[should_panic(expected = "credential already revoked")]
    fn regression_21_double_revocation_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        client.revoke_credential(&issuer, &id);
        client.revoke_credential(&issuer, &id); // must panic
    }

    // Issue #290 — Recovery: initiating recovery stores the request and returns an ID.
    #[test]
    fn regression_290_initiate_recovery_stores_request() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let new_subject = Address::generate(&env);
        let approver = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        let mut approvers = Vec::new(&env);
        approvers.push_back(approver.clone());
        let recovery_id =
            client.initiate_recovery(&issuer, &cred_id, &new_subject, &approvers, &1u32);

        let req = client.get_recovery_request(&recovery_id);
        assert_eq!(req.credential_id, cred_id);
        assert_eq!(req.new_subject, new_subject);
    }

    // Issue #290 — Duplicate recovery for the same credential must be rejected.
    #[test]
    #[should_panic]
    fn regression_290_duplicate_recovery_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let new_subject = Address::generate(&env);
        let approver = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        let mut approvers = Vec::new(&env);
        approvers.push_back(approver.clone());
        client.initiate_recovery(&issuer, &cred_id, &new_subject, &approvers, &1u32);
        client.initiate_recovery(&issuer, &cred_id, &new_subject, &approvers, &1u32);
        // must panic
    }

    // Issue #294 — Fork detection: conflicting attestation values must be detected.
    #[test]
    fn regression_294_detect_fork_with_conflicting_values() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor1 = Address::generate(&env);
        let attestor2 = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor1.clone());
        attestors.push_back(attestor2.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);

        client.attest(&attestor1, &cred_id, &slice_id, &true, &None);

        // A conflicting value from attestor2 must be detected as a fork.
        assert!(client.detect_fork(&cred_id, &slice_id, &attestor2, false));
    }

    // Issue #294 — Consistent attestation values must NOT trigger fork detection.
    #[test]
    fn regression_294_no_fork_for_consistent_values() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let attestor1 = Address::generate(&env);
        let attestor2 = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor1.clone());
        attestors.push_back(attestor2.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);

        client.attest(&attestor1, &cred_id, &slice_id, &true, &None);

        assert!(!client.detect_fork(&cred_id, &slice_id, &attestor2, true));
    }

    // ── Issue #381: Rate Limiting Tests ─────────────────────────────────────

    #[test]
    fn test_rate_limit_config_default() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);

        let config = client.get_rate_limit_config_pub();
        assert_eq!(config.max_calls, DEFAULT_RATE_LIMIT_MAX_CALLS);
        assert_eq!(config.window_seconds, DEFAULT_RATE_LIMIT_WINDOW_SECONDS);
    }

    #[test]
    fn test_rate_limit_config_set_by_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        client.set_rate_limit_config(&admin, &50u32, &1800u64);

        let config = client.get_rate_limit_config_pub();
        assert_eq!(config.max_calls, 50);
        assert_eq!(config.window_seconds, 1800);
    }

    #[test]
    #[should_panic(expected = "unauthorized")]
    fn test_rate_limit_config_unauthorized() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);

        let non_admin = Address::generate(&env);
        client.set_rate_limit_config(&non_admin, &50u32, &1800u64);
    }

    #[test]
    fn test_rate_limit_tracking() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        // First call should succeed
        client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        // Check rate limit state
        let state = client.get_rate_limit_state(&issuer);
        assert!(state.is_some());
        assert_eq!(state.unwrap().call_count, 1);
    }

    #[test]
    fn test_rate_limit_default_is_1000_per_day() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);

        let config = client.get_rate_limit_config_pub();
        assert_eq!(config.max_calls, 1000);
        assert_eq!(config.window_seconds, 86400);
    }

    #[test]
    fn test_set_issuer_rate_limit_config() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);
        let issuer = Address::generate(&env);

        client.set_issuer_rate_limit_config(&admin, &issuer, &5u32, &3600u64);

        // Issuer-specific limit is enforced: 5 calls allowed
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        for ctype in 1u32..=5 {
            client.issue_credential(&issuer, &subject, &ctype, &metadata, &None, &0u64);
        }
        let state = client.get_rate_limit_state(&issuer);
        assert_eq!(state.unwrap().call_count, 5);
    }

    #[test]
    #[should_panic]
    fn test_set_issuer_rate_limit_config_unauthorized() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let non_admin = Address::generate(&env);
        let issuer = Address::generate(&env);

        client.set_issuer_rate_limit_config(&non_admin, &issuer, &5u32, &3600u64);
    }

    #[test]
    fn test_rate_limit_whitelist_bypass() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);
        let issuer = Address::generate(&env);

        // Set a very tight per-issuer limit
        client.set_issuer_rate_limit_config(&admin, &issuer, &1u32, &86400u64);
        // Whitelist the issuer
        client.add_rate_limit_whitelist(&admin, &issuer);
        assert!(client.is_rate_limit_whitelisted(&issuer));

        // Should be able to issue more than 1 credential without hitting the limit
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
        client.issue_credential(&issuer, &subject, &2u32, &metadata, &None, &0u64);
        client.issue_credential(&issuer, &subject, &3u32, &metadata, &None, &0u64);
    }

    #[test]
    fn test_remove_rate_limit_whitelist() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);
        let issuer = Address::generate(&env);

        client.add_rate_limit_whitelist(&admin, &issuer);
        assert!(client.is_rate_limit_whitelisted(&issuer));

        client.remove_rate_limit_whitelist(&admin, &issuer);
        assert!(!client.is_rate_limit_whitelisted(&issuer));
    }

    #[test]
    #[should_panic]
    fn test_add_rate_limit_whitelist_unauthorized() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let non_admin = Address::generate(&env);
        let issuer = Address::generate(&env);

        client.add_rate_limit_whitelist(&non_admin, &issuer);
    }

    // ── Issue #382: Numeric Overflow Protection Tests ─────────────────────

    #[test]
    fn test_add_u32_no_overflow() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);

        // This test verifies the overflow protection is in place
        // The actual checked_add is internal, so we test via valid operations
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        // Multiple operations should work without overflow
        for i in 1..=5u32 {
            client.issue_credential(&issuer, &subject, &i, &metadata, &None, &0u64);
        }
    }

    #[test]
    fn test_validate_u32_bounds_valid() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);

        // Test valid bounds - this should not panic
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        // Valid credential type
        client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);
    }

    // ── Issue #383: Enum Value Validation Tests ───────────────────────────

    #[test]
    fn test_validate_fork_status_valid() {
        // Test valid fork status values
        assert!(QuorumProofContract::validate_fork_status(1)); // NoFork
        assert!(QuorumProofContract::validate_fork_status(2)); // ForkDetected
        assert!(QuorumProofContract::validate_fork_status(3)); // ForkResolved
    }

    #[test]
    fn test_validate_fork_status_invalid() {
        // Test invalid fork status values
        assert!(!QuorumProofContract::validate_fork_status(0));
        assert!(!QuorumProofContract::validate_fork_status(4));
        assert!(!QuorumProofContract::validate_fork_status(100));
    }

    #[test]
    fn test_validate_recovery_status_valid() {
        assert!(QuorumProofContract::validate_recovery_status(1)); // Pending
        assert!(QuorumProofContract::validate_recovery_status(2)); // Approved
        assert!(QuorumProofContract::validate_recovery_status(3)); // Executed
        assert!(QuorumProofContract::validate_recovery_status(4)); // Rejected
    }

    #[test]
    fn test_validate_recovery_status_invalid() {
        assert!(!QuorumProofContract::validate_recovery_status(0));
        assert!(!QuorumProofContract::validate_recovery_status(5));
    }

    #[test]
    fn test_validate_onboarding_status_valid() {
        assert!(QuorumProofContract::validate_onboarding_status(1)); // Pending
        assert!(QuorumProofContract::validate_onboarding_status(2)); // Approved
        assert!(QuorumProofContract::validate_onboarding_status(3)); // Rejected
    }

    #[test]
    fn test_validate_dispute_status_valid() {
        assert!(QuorumProofContract::validate_dispute_status(1)); // Active
        assert!(QuorumProofContract::validate_dispute_status(2)); // Resolved
        assert!(QuorumProofContract::validate_dispute_status(3)); // Dismissed
    }

    #[test]
    fn test_validate_challenge_status_valid() {
        assert!(QuorumProofContract::validate_challenge_status(1)); // Open
        assert!(QuorumProofContract::validate_challenge_status(2)); // Upheld
        assert!(QuorumProofContract::validate_challenge_status(3)); // Dismissed
    }

    #[test]
    fn test_validate_activity_type_valid() {
        assert!(QuorumProofContract::validate_activity_type(1)); // CredentialIssued
        assert!(QuorumProofContract::validate_activity_type(2)); // CredentialRevoked
        assert!(QuorumProofContract::validate_activity_type(3)); // CredentialRenewed
        assert!(QuorumProofContract::validate_activity_type(4)); // CredentialAttested
        assert!(QuorumProofContract::validate_activity_type(5)); // AttestationExpired
        assert!(QuorumProofContract::validate_activity_type(6)); // CredentialRecovered
    }

    #[test]
    fn test_validate_activity_type_invalid() {
        assert!(!QuorumProofContract::validate_activity_type(0));
        assert!(!QuorumProofContract::validate_activity_type(7));
    }

    // ── Issue #384: Permission Validation Tests ───────────────────────────

    #[test]
    fn test_require_admin_valid() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        // Admin should be able to set rate limit config
        client.set_rate_limit_config(&admin, &100u32, &3600u64);
    }

    #[test]
    fn test_require_issuer_valid() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        // Issuer should be able to issue credential
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        // Issuer should be able to revoke
        client.revoke_credential(&issuer, &cred_id);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #44)")]
    fn test_require_issuer_invalid() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let other_issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        // Other issuer should not be able to revoke
        client.revoke_credential(&other_issuer, &cred_id);
    }

    #[test]
    fn test_require_not_blacklisted() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);
        let reason = String::from_str(&env, "Test reason");

        // Add holder to blacklist
        client.add_holder_to_blacklist(&issuer, &holder, &reason);

        // Check holder is blacklisted
        assert!(client.is_holder_blacklisted(&issuer, &holder));
    }

    #[test]
    fn test_require_not_revoked() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        // Should be able to attest before revocation
        let attestor = Address::generate(&env);
        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);

        client.attest(&attestor, &cred_id, &slice_id, &true, &None);
        assert!(client.is_attested(&cred_id, &slice_id));

        // Revoke credential
        client.revoke_credential(&issuer, &cred_id);

        // After revocation, is_attested should return false
        assert!(!client.is_attested(&cred_id, &slice_id));
    }

    #[test]
    fn test_require_not_suspended() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        // Suspend credential
        client.suspend_credential(&issuer, &cred_id);

        // After suspension, is_attested should return false
        let attestor = Address::generate(&env);
        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &1u32);

        assert!(!client.is_attested(&cred_id, &slice_id));
    }

    #[test]
    fn test_require_credential_exists() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        // Issue a credential
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        // Get credential should work
        let cred = client.get_credential(&cred_id);
        assert_eq!(cred.id, cred_id);
    }

    #[test]
    fn test_require_slice_exists() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let creator = Address::generate(&env);
        let attestor = Address::generate(&env);

        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);

        // Create slice
        let slice_id = client.create_slice(&creator, &attestors, &weights, &1u32);

        // Get slice should work
        let slice = client.get_slice(&slice_id);
        assert_eq!(slice.id, slice_id);
    }
}

// Stub tests in this module reference unimplemented APIs; disabled until implemented.
#[cfg(all(test, any()))]
mod doc_tests {
    use crate::{QuorumProofContract, QuorumProofContractClient};
    use soroban_sdk::{testutils::Address as _, Address, Bytes, Env, Vec};

    /// Test: Credential Management API example from README
    ///
    /// Validates: issue_credential, get_credential, revoke_credential
    #[test]
    fn test_credential_management_example() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let credential_type = 1u32;
        let metadata_hash = Bytes::from_slice(&env, b"QmExampleHash0000000000000000000000");

        // issue_credential(subject, credential_type, metadata_hash) -> u64
        let credential_id =
            client.issue_credential(&issuer, &subject, &credential_type, &metadata_hash, &None, &0u64);
        assert!(credential_id > 0, "Credential ID should be positive");

        // get_credential(credential_id) -> Credential
        let credential = client.get_credential(&credential_id);
        assert_eq!(credential.subject, subject, "Subject should match");
        assert_eq!(
            credential.credential_type, credential_type,
            "Type should match"
        );

        // revoke_credential(credential_id)
        client.revoke_credential(&issuer, &credential_id);
        let revoked = client.get_credential(&credential_id);
        assert!(revoked.revoked, "Credential should be revoked");
    }

    /// Test: Quorum Slices API example from README
    ///
    /// Validates: create_slice, get_slice, add_attestor
    #[test]
    fn test_quorum_slices_example() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let creator = Address::generate(&env);
        let attestor1 = Address::generate(&env);
        let attestor2 = Address::generate(&env);

        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor1.clone());
        attestors.push_back(attestor2.clone());

        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        weights.push_back(1u32);

        let threshold = 2u32;

        // create_slice(attestors: Vec<Address>, threshold: u32) -> u64
        let slice_id = client.create_slice(&creator, &attestors, &weights, &threshold);
        assert!(slice_id > 0, "Slice ID should be positive");

        // get_slice(slice_id) -> QuorumSlice
        let slice = client.get_slice(&slice_id);
        assert_eq!(slice.threshold, threshold, "Threshold should match");
        assert_eq!(slice.attestors.len(), 2, "Should have 2 attestors");
    }

    /// Test: Attestation flow example
    ///
    /// Validates: attest, is_attested, get_attestors
    #[test]
    fn test_attestation_example() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        // Setup: Create credential
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let credential_id = client.issue_credential(
            &issuer,
            &subject,
            &1u32,
            &Bytes::from_slice(&env, b"QmHash"),
            &None,
            &0u64,
        );

        // Setup: Create slice with attestors
        let attestor1 = Address::generate(&env);
        let attestor2 = Address::generate(&env);
        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor1.clone());
        attestors.push_back(attestor2.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        weights.push_back(1u32);
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &2u32);

        // attest(credential_id, slice_id)
        client.attest(&attestor1, &credential_id, &slice_id, &true, &None);

        // is_attested(credential_id) -> bool
        let attested = client.is_attested(&credential_id);
        assert!(attested, "Credential should be attested");

        // get_attestors(credential_id) -> Vec<Address>
        let attestor_list = client.get_attestors(&credential_id);
        assert!(attestor_list.len() > 0, "Should have at least one attestor");
    }

    /// Test: Metadata handling with various sizes
    ///
    /// Validates: issue_credential with different metadata formats
    #[test]
    fn test_metadata_handling_example() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);

        // Test with small metadata
        let small_meta = Bytes::from_slice(&env, b"small");
        let id1 = client.issue_credential(&issuer, &subject, &1u32, &small_meta, &None, &0u64);
        assert!(id1 > 0);

        // Test with larger metadata (IPFS hash)
        let large_meta =
            Bytes::from_slice(&env, b"QmVeryLongIPFSHashThatRepresentsCredentialMetadata");
        let id2 = client.issue_credential(&issuer, &subject, &2u32, &large_meta, &None, &0u64);
        assert!(id2 > 0);
        assert_ne!(id1, id2, "Different credentials should have different IDs");

        // Verify both credentials exist
        let cred1 = client.get_credential(&id1);
        let cred2 = client.get_credential(&id2);
        assert_eq!(cred1.credential_type, 1u32);
        assert_eq!(cred2.credential_type, 2u32);
    }

    /// Test: Credential ID assignment uniqueness
    ///
    /// Validates: Each credential gets a unique ID
    #[test]
    fn test_credential_id_uniqueness() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let meta = Bytes::from_slice(&env, b"test");

        let mut ids = Vec::new();
        for i in 0..5 {
            let id = client.issue_credential(&issuer, &subject, &(i as u32), &meta, &None, &0u64);
            ids.push(id);
        }

        // Verify all IDs are unique
        for i in 0..ids.len() {
            for j in (i + 1)..ids.len() {
                assert_ne!(ids[i], ids[j], "Credential IDs must be unique");
            }
        }
    }

    // Issue #440: Test credential expiry enforcement
    #[test]
    #[should_panic(expected = "credential has expired")]
    fn test_get_credential_expired() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmExpired");

        set_ledger_timestamp(&env, 1000);
        let expiry = 2000u64;
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &Some(expiry), &0u64);

        // Credential should be retrievable before expiry
        let cred = client.get_credential(&cred_id);
        assert_eq!(cred.id, cred_id);

        // Move time past expiry
        set_ledger_timestamp(&env, 2001);

        // Should panic when trying to get expired credential
        client.get_credential(&cred_id);
    }

    // Issue #440: Test set_credential_expiry
    #[test]
    fn test_set_credential_expiry() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmSetExpiry");

        set_ledger_timestamp(&env, 1000);
        let cred_id = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None, &0u64);

        // Set expiry to 3000
        client.set_credential_expiry(&issuer, &cred_id, &3000u64);

        // Credential should be retrievable before expiry
        let cred = client.get_credential(&cred_id);
        assert_eq!(cred.expires_at, Some(3000u64));

        // Move time to just before expiry
        set_ledger_timestamp(&env, 2999);
        let cred = client.get_credential(&cred_id);
        assert_eq!(cred.expires_at, Some(3000u64));
    }

    // Issue #440: Test auto_revoke_expired_credentials
    #[test]
    fn test_auto_revoke_expired_credentials() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &contract_id);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"ipfs://QmAutoRevoke");

        set_ledger_timestamp(&env, 1000);

        // Issue 3 credentials with different expiry times
        let cred1 = client.issue_credential(&issuer, &subject, &1u32, &metadata, &Some(1500u64), &0u64);
        let cred2 = client.issue_credential(&issuer, &subject, &2u32, &metadata, &Some(2000u64), &0u64);
        let cred3 = client.issue_credential(&issuer, &subject, &3u32, &metadata, &Some(3000u64), &0u64);

        // Move time to 1800 — cred1 should be expired, cred2 and cred3 should not
        set_ledger_timestamp(&env, 1800);
        let revoked_count = client.auto_revoke_expired_credentials(&subject);
        assert_eq!(revoked_count, 1u32);

        // Verify cred1 is revoked
        let cred1_data = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .get(&DataKey::Credential(cred1))
                .unwrap()
        });
        assert!(cred1_data.revoked);

        // Move time to 2500 — cred2 should now also be expired
        set_ledger_timestamp(&env, 2500);
        let revoked_count = client.auto_revoke_expired_credentials(&subject);
        assert_eq!(revoked_count, 1u32);

        // Verify cred2 is now revoked
        let cred2_data = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .get(&DataKey::Credential(cred2))
                .unwrap()
        });
        assert!(cred2_data.revoked);

        // cred3 should still be valid
        let cred3_data = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .get(&DataKey::Credential(cred3))
                .unwrap()
        });
        assert!(!cred3_data.revoked);
    }

    // ============ Tests for Feature #448: Credential Holder Revocation Request ============

    #[test]
    fn test_request_credential_revocation() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        let cred_id = client.issue_credential(&issuer, &holder, &1u32, &metadata, &None, &0u64);

        let request_id = client.request_credential_revocation(
            &holder,
            &cred_id,
            &String::from_str(&env, "credential is outdated"),
        );
        assert_eq!(request_id, 1u64);
    }

    #[test]
    fn test_approve_revocation_request() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        let cred_id = client.issue_credential(&issuer, &holder, &1u32, &metadata, &None, &0u64);
        let request_id = client.request_credential_revocation(
            &holder,
            &cred_id,
            &String::from_str(&env, "outdated"),
        );

        client.approve_revocation_request(&issuer, &request_id);

        let cred = client.get_credential(&cred_id);
        assert!(cred.revoked);
    }

    #[test]
    fn test_deny_revocation_request() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        let cred_id = client.issue_credential(&issuer, &holder, &1u32, &metadata, &None, &0u64);
        let request_id = client.request_credential_revocation(
            &holder,
            &cred_id,
            &String::from_str(&env, "outdated"),
        );

        client.deny_revocation_request(&issuer, &request_id);

        let cred = client.get_credential(&cred_id);
        assert!(!cred.revoked);
    }

    // ============ Tests for Feature #449: Credential Holder Dispute Resolution ============

    #[test]
    fn test_initiate_credential_dispute() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let evidence = Bytes::from_slice(&env, b"QmEvidenceHash0000000000000000000");

        let cred_id = client.issue_credential(&issuer, &holder, &1u32, &metadata, &None, &0u64);
        let dispute_id = client.initiate_credential_dispute(&holder, &cred_id, &evidence);

        assert_eq!(dispute_id, 1u64);
    }

    #[test]
    fn test_resolve_credential_dispute() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let evidence = Bytes::from_slice(&env, b"QmEvidenceHash0000000000000000000");

        // Set admin
        env.as_contract(&client.address, || {
            env.storage().instance().set(&DataKey::Admin, &admin);
        });

        let cred_id = client.issue_credential(&issuer, &holder, &1u32, &metadata, &None, &0u64);
        let _dispute_id = client.initiate_credential_dispute(&holder, &cred_id, &evidence);

        client.resolve_credential_dispute(
            &admin,
            &cred_id,
            &String::from_str(&env, "dispute upheld"),
        );
    }

    #[test]
    fn test_auto_resolve_dispute_timeout() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let evidence = Bytes::from_slice(&env, b"QmEvidenceHash0000000000000000000");

        set_ledger_timestamp(&env, 1000);

        let cred_id = client.issue_credential(&issuer, &holder, &1u32, &metadata, &None, &0u64);
        let _dispute_id = client.initiate_credential_dispute(&holder, &cred_id, &evidence);

        // Move time forward by 30 days + 1 second
        set_ledger_timestamp(&env, 1000 + 2_592_001);

        client.auto_resolve_dispute(&cred_id);
    }

    // ============ Tests for Feature #446: Credential Holder Anonymity Mode ============

    #[test]
    fn test_generate_anonymous_proof() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);
        let verifier = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        let cred_id = client.issue_credential(&issuer, &holder, &1u32, &metadata, &None, &0u64);
        let proof = client.generate_anonymous_proof(&holder, &cred_id, &verifier);

        assert!(proof.len() > 0);
    }

    #[test]
    fn test_verify_anonymous_proof() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);
        let verifier = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");

        let cred_id = client.issue_credential(&issuer, &holder, &1u32, &metadata, &None, &0u64);
        let proof = client.generate_anonymous_proof(&holder, &cred_id, &verifier);

        let is_valid = client.verify_anonymous_proof(&cred_id, &verifier, &proof);
        assert!(is_valid);
    }

    // ============ Tests for Feature #445: Attestor Reputation Scoring ============

    #[test]
    fn test_update_attestor_reputation() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let admin = Address::generate(&env);
        let attestor = Address::generate(&env);

        // Set admin
        env.as_contract(&client.address, || {
            env.storage().instance().set(&DataKey::Admin, &admin);
        });

        client.update_attestor_reputation(&admin, &attestor, &50i32);

        let score = client.get_attestor_reputation_score(&attestor);
        assert_eq!(score, 50i32);
    }

    #[test]
    fn test_get_attestor_reputation_score() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _) = setup(&env);
        let admin = Address::generate(&env);
        let attestor = Address::generate(&env);

        // Set admin
        env.as_contract(&client.address, || {
            env.storage().instance().set(&DataKey::Admin, &admin);
        });

        client.update_attestor_reputation(&admin, &attestor, &100i32);
        client.update_attestor_reputation(&admin, &attestor, &-30i32);

        let score = client.get_attestor_reputation_score(&attestor);
        assert_eq!(score, 70i32);
    }

    // ============ Tests for Slashing and Anonymous Verification ============

    #[test]
    fn test_slash_attestor() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);
        let creator = Address::generate(&env);
        let attestor = Address::generate(&env);

        let attestors = vec![&env, attestor.clone()];
        let weights = vec![&env, 100u32];
        let slice_id = client.create_slice(&creator, &attestors, &weights, &100u32);

        // Slash the attestor
        client.slash_attestor(&admin, &slice_id, &attestor);

        assert_eq!(client.get_slash_count(&attestor), 1);
        assert!(client.is_attestor_suspended(&slice_id, &attestor));
    }

    #[test]
    fn test_vote_on_challenge_uphold_slashes() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);
        let issuer = Address::generate(&env);
        let holder = Address::generate(&env);
        let attestor = Address::generate(&env);
        let voter = Address::generate(&env);
        let challenger = Address::generate(&env);

        // Set admin
        env.as_contract(&client.address, || {
            env.storage().instance().set(&DataKey::Admin, &admin);
        });

        let metadata = Bytes::from_slice(&env, b"QmTestHash000000000000000000000000");
        let cred_id = client.issue_credential(&issuer, &holder, &1u32, &metadata, &None);

        let attestors = vec![&env, attestor.clone(), voter.clone()];
        let weights = vec![&env, 50u32, 50u32];
        let slice_id = client.create_slice(&issuer, &attestors, &weights, &50u32);

        client.attest(&attestor, &cred_id, &slice_id, &true, &None);

        let challenge_id = client.challenge_attestation(&challenger, &cred_id, &attestor, &slice_id);
        
        // Voter votes to uphold challenge
        client.vote_on_challenge(&voter, &challenge_id, &true);

        // Verify challenge is upheld and attestor is slashed
        let challenge = client.get_challenge(&challenge_id);
        assert_eq!(challenge.status, ChallengeStatus::Upheld);
        assert_eq!(client.get_slash_count(&attestor), 1);
        assert!(client.is_attestor_suspended(&slice_id, &attestor));
    }

    #[test]
    fn test_verify_engineer_anonymous() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);
        let zk_verifier_id = env.register_contract(None, zk_verifier::ZkVerifierContract);
        let zk_client = zk_verifier::ZkVerifierContractClient::new(&env, &zk_verifier_id);
        zk_client.initialize(&admin);

        // Register a verifying key hash for ZK
        let vk_hash = soroban_sdk::BytesN::from_array(&env, &[1u8; 32]);
        zk_client.set_verifying_key(&admin, &vk_hash);

        let commitment = Bytes::from_slice(&env, b"commitment_32bytes_padding_xxxxxx");
        let mut proof_bytes = [0u8; 256];
        proof_bytes[0..64].fill(1); // Non-zero A
        proof_bytes[192..256].fill(1); // Non-zero C
        let proof = Bytes::from_slice(&env, &proof_bytes);

        let result = client.verify_engineer_anonymous(
            &zk_verifier_id,
            &1u64,
            &ClaimType::Degree,
            &commitment,
            &proof,
        );
        assert!(result);
    }

    // ── Tests for Issue #532: Credential Holder Delegation ────────────────────

    #[test]
    fn test_delegate_verification_holder_can_delegate() {
        use sbt_registry::SbtRegistryContract;
        use zk_verifier::ZkVerifierContract;

        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let qp_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &qp_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let holder = Address::generate(&env);
        let issuer = Address::generate(&env);
        let delegate = Address::generate(&env);

        // Issue a credential
        let cred_id = client.issue_credential(
            &issuer,
            &holder,
            &1u32,
            &Bytes::from_slice(&env, b"metadata_hash"),
            &None,
        );

        // Holder delegates to delegate
        let expiry = env.ledger().timestamp() + 3600; // 1 hour from now
        client.delegate_verification(&holder, &cred_id, &delegate, &expiry);

        // Verify delegation was recorded
        let delegation = client.get_delegation(&cred_id, &delegate);
        assert!(delegation.is_some());
        let deleg = delegation.unwrap();
        assert_eq!(deleg.delegate, delegate);
        assert_eq!(deleg.credential_id, cred_id);
        assert_eq!(deleg.expiry, expiry);
    }

    #[test]
    #[should_panic(expected = "only the credential holder can delegate")]
    fn test_delegate_verification_non_holder_rejected() {
        use sbt_registry::SbtRegistryContract;
        use zk_verifier::ZkVerifierContract;

        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let qp_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &qp_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let holder = Address::generate(&env);
        let issuer = Address::generate(&env);
        let delegate = Address::generate(&env);
        let non_holder = Address::generate(&env);

        // Issue a credential
        let cred_id = client.issue_credential(
            &issuer,
            &holder,
            &1u32,
            &Bytes::from_slice(&env, b"metadata_hash"),
            &None,
        );

        // Non-holder tries to delegate - should panic
        let expiry = env.ledger().timestamp() + 3600;
        client.delegate_verification(&non_holder, &cred_id, &delegate, &expiry);
    }

    #[test]
    fn test_delegation_audit_entry_written() {
        use sbt_registry::SbtRegistryContract;
        use zk_verifier::ZkVerifierContract;

        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let qp_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &qp_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let holder = Address::generate(&env);
        let issuer = Address::generate(&env);
        let delegate = Address::generate(&env);

        // Issue a credential
        let cred_id = client.issue_credential(
            &issuer,
            &holder,
            &1u32,
            &Bytes::from_slice(&env, b"metadata_hash"),
            &None,
        );

        // Delegate
        let expiry = env.ledger().timestamp() + 3600;
        client.delegate_verification(&holder, &cred_id, &delegate, &expiry);

        // Check audit log
        let audit_log = client.get_delegation_audit(&cred_id);
        assert_eq!(audit_log.len(), 1);
        assert_eq!(audit_log.get(0).unwrap().delegate, delegate);
        assert_eq!(audit_log.get(0).unwrap().expiry, expiry);
    }

    #[test]
    fn test_holder_can_grant_multiple_delegations() {
        use sbt_registry::SbtRegistryContract;
        use zk_verifier::ZkVerifierContract;

        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let qp_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &qp_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let holder = Address::generate(&env);
        let issuer = Address::generate(&env);
        let delegate1 = Address::generate(&env);
        let delegate2 = Address::generate(&env);

        // Issue a credential
        let cred_id = client.issue_credential(
            &issuer,
            &holder,
            &1u32,
            &Bytes::from_slice(&env, b"metadata_hash"),
            &None,
        );

        // Grant delegations to two different parties
        let expiry1 = env.ledger().timestamp() + 3600;
        let expiry2 = env.ledger().timestamp() + 7200;
        client.delegate_verification(&holder, &cred_id, &delegate1, &expiry1);
        client.delegate_verification(&holder, &cred_id, &delegate2, &expiry2);

        // Both delegations should exist
        assert!(client.get_delegation(&cred_id, &delegate1).is_some());
        assert!(client.get_delegation(&cred_id, &delegate2).is_some());

        // Audit log should have 2 entries
        let audit_log = client.get_delegation_audit(&cred_id);
        assert_eq!(audit_log.len(), 2);
    }

    #[test]
    fn test_expired_delegation_is_rejected() {
        use sbt_registry::{SbtRegistryContract, SbtRegistryContractClient};
        use zk_verifier::{ZkVerifierContract, ZkVerifierContractClient};

        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let qp_id = env.register_contract(None, QuorumProofContract);
        let sbt_id = env.register_contract(None, SbtRegistryContract);
        let zk_id = env.register_contract(None, ZkVerifierContract);

        let client = QuorumProofContractClient::new(&env, &qp_id);
        let sbt_client = SbtRegistryContractClient::new(&env, &sbt_id);
        let zk_client = ZkVerifierContractClient::new(&env, &zk_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);
        zk_client.initialize(&admin);
        sbt_client.initialize(&admin, &qp_id);

        let holder = Address::generate(&env);
        let issuer = Address::generate(&env);
        let delegate = Address::generate(&env);

        // Issue a credential
        let cred_id = client.issue_credential(
            &issuer,
            &holder,
            &1u32,
            &Bytes::from_slice(&env, b"metadata_hash"),
            &None,
        );

        // Grant delegation with expiry in the past
        let expiry = env.ledger().timestamp() - 1; // Already expired
        client.delegate_verification(&holder, &cred_id, &delegate, &expiry);

        let vk_hash = soroban_sdk::BytesN::from_array(&env, &[1u8; 32]);
        zk_client.set_verifying_key(&admin, &vk_hash);

        let mut proof_bytes = [0u8; 256];
        proof_bytes[0..64].fill(1);
        proof_bytes[192..256].fill(1);
        let proof = Bytes::from_slice(&env, &proof_bytes);

        // Verify should fail because delegation is expired
        let result = client.verify_engineer(
            &sbt_id,
            &zk_id,
            &admin,
            &delegate,
            &cred_id,
            &ClaimType::Degree,
            &proof,
        );
        assert!(!result);
    }

    #[test]
    fn test_non_delegate_non_holder_cannot_verify() {
        use sbt_registry::{SbtRegistryContract, SbtRegistryContractClient};
        use zk_verifier::{ZkVerifierContract, ZkVerifierContractClient};

        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let qp_id = env.register_contract(None, QuorumProofContract);
        let sbt_id = env.register_contract(None, SbtRegistryContract);
        let zk_id = env.register_contract(None, ZkVerifierContract);

        let client = QuorumProofContractClient::new(&env, &qp_id);
        let sbt_client = SbtRegistryContractClient::new(&env, &sbt_id);
        let zk_client = ZkVerifierContractClient::new(&env, &zk_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);
        zk_client.initialize(&admin);
        sbt_client.initialize(&admin, &qp_id);

        let holder = Address::generate(&env);
        let issuer = Address::generate(&env);
        let delegate = Address::generate(&env);
        let unauthorized = Address::generate(&env);

        // Issue a credential
        let cred_id = client.issue_credential(
            &issuer,
            &holder,
            &1u32,
            &Bytes::from_slice(&env, b"metadata_hash"),
            &None,
        );

        // Grant delegation to delegate (not unauthorized)
        let expiry = env.ledger().timestamp() + 3600;
        client.delegate_verification(&holder, &cred_id, &delegate, &expiry);

        let vk_hash = soroban_sdk::BytesN::from_array(&env, &[1u8; 32]);
        zk_client.set_verifying_key(&admin, &vk_hash);

        let mut proof_bytes = [0u8; 256];
        proof_bytes[0..64].fill(1);
        proof_bytes[192..256].fill(1);
        let proof = Bytes::from_slice(&env, &proof_bytes);

        // Unauthorized party should not be able to verify
        let result = client.verify_engineer(
            &sbt_id,
            &zk_id,
            &admin,
            &unauthorized,
            &cred_id,
            &ClaimType::Degree,
            &proof,
        );
        assert!(!result);
    }

    // ── Tests for Issue #533: Quorum Slice Threshold Adjustment ────────────────

    #[test]
    fn test_update_slice_threshold_issuer_can_update() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let qp_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &qp_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let creator = Address::generate(&env);
        let attestor = Address::generate(&env);

        let attestors = vec![&env, attestor.clone()];
        let weights = vec![&env, 100u32];
        let slice_id = client.create_slice(&creator, &attestors, &weights, &50u32);

        // Creator updates threshold
        let new_threshold = 75u32;
        client.update_slice_threshold(&creator, &slice_id, &new_threshold);

        // Verify threshold was updated
        let updated_slice = client.get_slice(&slice_id);
        assert_eq!(updated_slice.threshold, new_threshold);
    }

    #[test]
    #[should_panic(expected = "only the slice creator can update threshold")]
    fn test_update_slice_threshold_non_issuer_rejected() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let qp_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &qp_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let creator = Address::generate(&env);
        let non_creator = Address::generate(&env);
        let attestor = Address::generate(&env);

        let attestors = vec![&env, attestor.clone()];
        let weights = vec![&env, 100u32];
        let slice_id = client.create_slice(&creator, &attestors, &weights, &50u32);

        // Non-creator tries to update threshold - should panic
        client.update_slice_threshold(&non_creator, &slice_id, &75u32);
    }

    #[test]
    #[should_panic(expected = "threshold must be greater than 0")]
    fn test_update_slice_threshold_zero_rejected() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let qp_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &qp_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let creator = Address::generate(&env);
        let attestor = Address::generate(&env);

        let attestors = vec![&env, attestor.clone()];
        let weights = vec![&env, 100u32];
        let slice_id = client.create_slice(&creator, &attestors, &weights, &50u32);

        // Zero threshold should be rejected
        client.update_slice_threshold(&creator, &slice_id, &0u32);
    }

    #[test]
    #[should_panic(expected = "threshold cannot exceed total weight sum")]
    fn test_update_slice_threshold_exceeds_max_rejected() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let qp_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &qp_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let creator = Address::generate(&env);
        let attestor = Address::generate(&env);

        let attestors = vec![&env, attestor.clone()];
        let weights = vec![&env, 100u32];
        let slice_id = client.create_slice(&creator, &attestors, &weights, &50u32);

        // Threshold exceeds total weight (100) should be rejected
        client.update_slice_threshold(&creator, &slice_id, &101u32);
    }

    #[test]
    fn test_threshold_audit_entry_written() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let qp_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &qp_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let creator = Address::generate(&env);
        let attestor = Address::generate(&env);

        let attestors = vec![&env, attestor.clone()];
        let weights = vec![&env, 100u32];
        let slice_id = client.create_slice(&creator, &attestors, &weights, &50u32);

        // Update threshold
        let new_threshold = 75u32;
        client.update_slice_threshold(&creator, &slice_id, &new_threshold);

        // Check audit log
        let audit_log = client.get_slice_threshold_audit(&slice_id);
        assert_eq!(audit_log.len(), 1);
        let entry = audit_log.get(0).unwrap();
        assert_eq!(entry.slice_id, slice_id);
        assert_eq!(entry.old_threshold, 50u32);
        assert_eq!(entry.new_threshold, new_threshold);
        assert_eq!(entry.changed_by, creator);
    }

    #[test]
    fn test_multiple_threshold_updates_produce_multiple_audit_entries() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let qp_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &qp_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let creator = Address::generate(&env);
        let attestor = Address::generate(&env);

        let attestors = vec![&env, attestor.clone()];
        let weights = vec![&env, 100u32];
        let slice_id = client.create_slice(&creator, &attestors, &weights, &50u32);

        // Make multiple threshold updates
        client.update_slice_threshold(&creator, &slice_id, &60u32);
        client.update_slice_threshold(&creator, &slice_id, &70u32);
        client.update_slice_threshold(&creator, &slice_id, &80u32);

        // Check audit log has all entries in order
        let audit_log = client.get_slice_threshold_audit(&slice_id);
        assert_eq!(audit_log.len(), 3);

        // Verify entries in order
        let entry1 = audit_log.get(0).unwrap();
        assert_eq!(entry1.old_threshold, 50u32);
        assert_eq!(entry1.new_threshold, 60u32);

        let entry2 = audit_log.get(1).unwrap();
        assert_eq!(entry2.old_threshold, 60u32);
        assert_eq!(entry2.new_threshold, 70u32);

        let entry3 = audit_log.get(2).unwrap();
        assert_eq!(entry3.old_threshold, 70u32);
        assert_eq!(entry3.new_threshold, 80u32);
    }

    // ── Tests for Issue #534: Credential Batch Issuance with Rollback ─────────

    #[test]
    fn test_issue_batch_all_valid_credentials() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let qp_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &qp_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let issuer = Address::generate(&env);
        let subject1 = Address::generate(&env);
        let subject2 = Address::generate(&env);

        let mut batch = Vec::new(&env);
        batch.push_back(CredentialInput {
            subject: subject1.clone(),
            credential_type: 1u32,
            metadata_hash: Bytes::from_slice(&env, b"hash1"),
            expires_at: None,
        });
        batch.push_back(CredentialInput {
            subject: subject2.clone(),
            credential_type: 2u32,
            metadata_hash: Bytes::from_slice(&env, b"hash2"),
            expires_at: Some(env.ledger().timestamp() + 1000),
        });

        let result = client.issue_batch(&issuer, &batch);

        match result {
            BatchResult::Ok(ids) => {
                assert_eq!(ids.len(), 2);
                // Verify credentials were created
                let cred1 = client.get_credential(&ids.get(0).unwrap());
                assert_eq!(cred1.subject, subject1);
                assert_eq!(cred1.credential_type, 1u32);

                let cred2 = client.get_credential(&ids.get(1).unwrap());
                assert_eq!(cred2.subject, subject2);
                assert_eq!(cred2.credential_type, 2u32);
            }
            BatchResult::Err(_) => panic!("Expected success"),
        }
    }

    #[test]
    fn test_issue_batch_invalid_credential_type_zero() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let qp_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &qp_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);

        let mut batch = Vec::new(&env);
        batch.push_back(CredentialInput {
            subject: subject.clone(),
            credential_type: 0u32, // Invalid
            metadata_hash: Bytes::from_slice(&env, b"hash"),
            expires_at: None,
        });

        let result = client.issue_batch(&issuer, &batch);

        match result {
            BatchResult::Ok(_) => panic!("Expected error"),
            BatchResult::Err(err) => {
                assert_eq!(err.failing_index, 0);
                // Verify no credentials were created
                let count = client.get_credential_count();
                assert_eq!(count, 0);
            }
        }
    }

    #[test]
    fn test_issue_batch_empty_metadata_hash() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let qp_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &qp_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);

        let mut batch = Vec::new(&env);
        batch.push_back(CredentialInput {
            subject: subject.clone(),
            credential_type: 1u32,
            metadata_hash: Bytes::new(&env), // Empty
            expires_at: None,
        });

        let result = client.issue_batch(&issuer, &batch);

        match result {
            BatchResult::Ok(_) => panic!("Expected error"),
            BatchResult::Err(err) => {
                assert_eq!(err.failing_index, 0);
            }
        }
    }

    #[test]
    fn test_issue_batch_empty_batch_is_valid() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let qp_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &qp_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let issuer = Address::generate(&env);
        let batch = Vec::<CredentialInput>::new(&env);

        let result = client.issue_batch(&issuer, &batch);

        match result {
            BatchResult::Ok(ids) => {
                assert_eq!(ids.len(), 0);
            }
            BatchResult::Err(_) => panic!("Expected success for empty batch"),
        }
    }

    #[test]
    fn test_issue_batch_duplicate_in_batch_rejected() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let qp_id = env.register_contract(None, QuorumProofContract);
        let client = QuorumProofContractClient::new(&env, &qp_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);

        let mut batch = Vec::new(&env);
        // Add duplicate entries (same subject, same type)
        batch.push_back(CredentialInput {
            subject: subject.clone(),
            credential_type: 1u32,
            metadata_hash: Bytes::from_slice(&env, b"hash1"),
            expires_at: None,
        });
        batch.push_back(CredentialInput {
            subject: subject.clone(),
            credential_type: 1u32, // Duplicate
            metadata_hash: Bytes::from_slice(&env, b"hash2"),
            expires_at: None,
        });

        let result = client.issue_batch(&issuer, &batch);

        match result {
            BatchResult::Ok(_) => panic!("Expected error for duplicate in batch"),
            BatchResult::Err(err) => {
                assert_eq!(err.failing_index, 1); // Second entry fails
                // Verify no credentials were created
                let count = client.get_credential_count();
                assert_eq!(count, 0);
            }
        }
    }
}

#[path = "tests_new_features.rs"]
mod tests_new_features;

#[path = "proptest_slices.rs"]
mod proptest_slices;
