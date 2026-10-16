use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, Bytes, Vec, String};

/// Represents a credential branch for version control
#[contracttype]
#[derive(Clone)]
pub struct CredentialBranch {
    /// Unique branch identifier
    pub id: u64,
    /// Original credential ID
    pub credential_id: u64,
    /// Branch name (e.g., "main", "dev", "feature-xyz")
    pub name: String,
    /// Current metadata hash on this branch
    pub metadata_hash: Bytes,
    /// Parent branch ID (for branch hierarchy)
    pub parent_branch_id: Option<u64>,
    /// Timestamp when branch was created
    pub created_at: u64,
    /// Address that created the branch
    pub created_by: Address,
    /// Whether this is the main/default branch
    pub is_default: bool,
    /// Current branch version number
    pub version: u32,
}

/// Represents a commit on a branch
#[contracttype]
#[derive(Clone)]
pub struct BranchCommit {
    /// Unique commit ID
    pub id: u64,
    /// Branch ID this commit belongs to
    pub branch_id: u64,
    /// Credential ID
    pub credential_id: u64,
    /// New metadata hash after this commit
    pub metadata_hash: Bytes,
    /// Previous metadata hash (parent commit)
    pub parent_commit_id: Option<u64>,
    /// Commit message/description
    pub message: String,
    /// Address that created the commit
    pub committed_by: Address,
    /// Timestamp of commit
    pub committed_at: u64,
    /// Number of attestations at time of commit
    pub attestation_count: u64,
}

/// Represents a branch merge operation
#[contracttype]
#[derive(Clone)]
pub struct BranchMerge {
    /// Unique merge ID
    pub id: u64,
    /// Source branch ID
    pub source_branch_id: u64,
    /// Target branch ID
    pub target_branch_id: u64,
    /// Credential ID
    pub credential_id: u64,
    /// Final metadata hash after merge
    pub merged_metadata_hash: Bytes,
    /// Address that performed merge
    pub merged_by: Address,
    /// Timestamp of merge
    pub merged_at: u64,
    /// Merge strategy used (0=manual, 1=ours, 2=theirs, 3=automatic)
    pub merge_strategy: u32,
    /// Whether merge completed successfully
    pub success: bool,
}

/// Branch merge conflict information
#[contracttype]
#[derive(Clone)]
pub struct MergeConflict {
    /// Merge ID with conflict
    pub merge_id: u64,
    /// Source branch version
    pub source_version: u32,
    /// Target branch version
    pub target_version: u32,
    /// Conflicting metadata hash from source
    pub source_metadata: Bytes,
    /// Conflicting metadata hash from target
    pub target_metadata: Bytes,
    /// Timestamp conflict was detected
    pub detected_at: u64,
}

/// Branch metadata and history tracking
#[contracttype]
#[derive(Clone)]
pub struct BranchMetadata {
    /// Branch ID
    pub branch_id: u64,
    /// Total commits on this branch
    pub commit_count: u64,
    /// Total merges from this branch
    pub merge_count: u64,
    /// Last commit timestamp
    pub last_commit_at: u64,
    /// Number of active collaborators
    pub collaborator_count: u32,
    /// Whether branch is locked from merging
    pub locked: bool,
}

/// Event emitted when branch is created
#[contracttype]
#[derive(Clone)]
pub struct BranchCreatedEventData {
    pub branch_id: u64,
    pub credential_id: u64,
    pub branch_name: String,
    pub created_at: u64,
}

/// Event emitted when commit is made
#[contracttype]
#[derive(Clone)]
pub struct CommitEventData {
    pub commit_id: u64,
    pub branch_id: u64,
    pub credential_id: u64,
    pub message: String,
    pub committed_at: u64,
}

/// Event emitted when branch merge occurs
#[contracttype]
#[derive(Clone)]
pub struct BranchMergedEventData {
    pub merge_id: u64,
    pub source_branch_id: u64,
    pub target_branch_id: u64,
    pub credential_id: u64,
    pub success: bool,
    pub merged_at: u64,
}

/// Branching error types
#[contracterror]
#[repr(u32)]
pub enum BranchError {
    BranchNotFound = 1,
    BranchAlreadyExists = 2,
    InvalidBranchName = 3,
    CommitNotFound = 4,
    MergeConflict = 5,
    BranchLocked = 6,
    CannotDeleteDefaultBranch = 7,
    InvalidMergeStrategy = 8,
}
