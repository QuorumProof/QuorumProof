//! Slice enhancements module covering:
//! - Issue #1235: Threshold Signature Verification
//! - Issue #1236: Performance Metrics Tracking
//! - Issue #1237: Slice Migration for Schema Changes
//! - Issue #1238: Consensus Analytics

use soroban_sdk::{contracttype, Address, Bytes, Env, Vec};

// ═══════════════════════════════════════════════════════════════════════════════
// Issue #1235: Threshold Signature Verification for Slices
// ═══════════════════════════════════════════════════════════════════════════════

/// BLS aggregated signature for threshold verification
#[contracttype]
#[derive(Clone)]
pub struct AggregatedSignature {
    /// The aggregated BLS signature combining multiple co-signatures
    pub signature: Bytes,
    /// Bitmap indicating which attestors contributed to the signature
    pub signer_bitmap: u64,
    /// Number of attestors who signed (must meet threshold)
    pub signature_count: u32,
    /// Timestamp when aggregation was completed
    pub aggregated_at: u64,
}

/// Result of threshold signature verification
#[contracttype]
#[derive(Clone)]
pub struct ThresholdVerificationResult {
    /// Whether threshold signature is valid
    pub is_valid: bool,
    /// Number of signatures present in aggregation
    pub signatures_present: u32,
    /// Quorum threshold that needed to be met
    pub threshold_required: u32,
    /// Addresses of signatories identified from bitmap
    pub signatories: Vec<Address>,
    /// Verification timestamp
    pub verified_at: u64,
}

// ═══════════════════════════════════════════════════════════════════════════════
// Issue #1236: Slice Performance Metrics Tracking
// ═══════════════════════════════════════════════════════════════════════════════

/// Performance metrics for a single attestor
#[contracttype]
#[derive(Clone)]
pub struct AttestorMetrics {
    /// Average response time in milliseconds
    pub avg_response_time_ms: u64,
    /// Total number of attestations
    pub total_attestations: u32,
    /// Number of times attestor was unavailable
    pub unavailability_count: u32,
    /// Total uptime percentage (basis points: 0-10000)
    pub uptime_bps: u32,
    /// Last attestation timestamp
    pub last_attestation_at: u64,
    /// Last health check timestamp
    pub last_health_check_at: u64,
}

/// Slice-level performance metrics
#[contracttype]
#[derive(Clone)]
pub struct SlicePerformanceMetrics {
    pub slice_id: u64,
    /// Average attestation time across all attestors (ms)
    pub avg_attestation_time_ms: u64,
    /// Overall quorum health (0-10000 basis points)
    pub quorum_health_bps: u32,
    /// Number of healthy attestors in slice
    pub healthy_attestor_count: u32,
    /// Total attestors in slice
    pub total_attestors: u32,
    /// Last metrics update timestamp
    pub updated_at: u64,
}

/// Single attestor health observation
#[contracttype]
#[derive(Clone)]
pub struct AttestorHealthObservation {
    pub attestor: Address,
    pub response_time_ms: u64,
    pub is_healthy: bool,
    pub observed_at: u64,
}

// ═══════════════════════════════════════════════════════════════════════════════
// Issue #1237: Slice Migration for Schema Changes
// ═══════════════════════════════════════════════════════════════════════════════

/// Tracks slice schema versions
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum SliceSchemaVersion {
    V1 = 1,
    V2 = 2,
}

/// Record of a slice migration operation
#[contracttype]
#[derive(Clone)]
pub struct SliceMigrationRecord {
    pub slice_id: u64,
    pub from_version: u32,
    pub to_version: u32,
    pub migrated_at: u64,
    pub migrated_by: Address,
    /// Hash of migration data for verification
    pub migration_hash: Bytes,
    /// Whether migration was successful
    pub success: bool,
}

/// Slice schema definition for version tracking
#[contracttype]
#[derive(Clone)]
pub struct SliceSchema {
    pub version: u32,
    /// Hash identifying this schema
    pub schema_hash: Bytes,
    /// Description of schema changes
    pub description: Bytes,
    pub created_at: u64,
}

// ═══════════════════════════════════════════════════════════════════════════════
// Issue #1238: Slice Consensus Analytics
// ═══════════════════════════════════════════════════════════════════════════════

/// Single attestor's consensus position
#[contracttype]
#[derive(Clone)]
pub struct AttestorConsensusPosition {
    pub attestor: Address,
    /// True if voted for, false if voted against
    pub position: bool,
    /// Weight of this attestor's vote
    pub weight: u32,
    /// Timestamp of attestation
    pub attested_at: u64,
}

/// Consensus analytics for a credential
#[contracttype]
#[derive(Clone)]
pub struct ConsensusAnalytics {
    pub credential_id: u64,
    /// Total weight voting for the credential
    pub agreeing_weight: u32,
    /// Total weight voting against
    pub disagreeing_weight: u32,
    /// Total weight in the quorum
    pub total_weight: u32,
    /// Agreement percentage (basis points: 0-10000)
    pub agreement_percentage_bps: u32,
    /// List of dissenting attestors
    pub dissenting_attestors: Vec<Address>,
    /// Total number of attestors who participated
    pub total_attestors: u32,
    /// Timestamp of latest attestation
    pub last_updated_at: u64,
}

/// Individual consensus metric point
#[contracttype]
#[derive(Clone)]
pub struct ConsensusMetricPoint {
    pub credential_id: u64,
    pub slice_id: u64,
    pub agreement_percentage_bps: u32,
    pub recorded_at: u64,
}
