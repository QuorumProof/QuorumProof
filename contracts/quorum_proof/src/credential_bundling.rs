/// Credential Bundling Module - Issue #1596
/// Enables bundling of multiple credentials for discounted verification
/// Reduces verification costs and improves efficiency for batch operations

use soroban_sdk::{contracttype, Address, Bytes, Env, Vec};

/// Pricing tier for credential bundles
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum BundlePricingTier {
    /// Single credential (no bundle discount)
    Single = 1,
    /// 2-5 credentials (10% discount)
    Small = 2,
    /// 6-15 credentials (25% discount)
    Medium = 3,
    /// 16-50 credentials (40% discount)
    Large = 4,
    /// 50+ credentials (50% discount)
    VeryLarge = 5,
}

/// Credential bundle combining multiple credentials for discounted verification
#[contracttype]
#[derive(Clone)]
pub struct CredentialBundle {
    /// Unique bundle ID
    pub id: u64,
    /// Array of credential IDs in this bundle
    pub credential_ids: Vec<u64>,
    /// The issuer creating the bundle
    pub issuer: Address,
    /// The subject holding the bundle
    pub subject: Address,
    /// Pricing tier for discount calculation
    pub pricing_tier: BundlePricingTier,
    /// Base cost per verification
    pub base_cost_per_credential: u64,
    /// Applied discount percentage (0-100)
    pub discount_percentage: u32,
    /// Effective cost after discount per credential
    pub effective_cost_per_credential: u64,
    /// Whether the bundle is active
    pub active: bool,
    /// Creation timestamp
    pub created_at: u64,
    /// Expiration timestamp (optional)
    pub expires_at: Option<u64>,
}

/// Bundle verification request
#[contracttype]
#[derive(Clone)]
pub struct BundleVerificationRequest {
    pub bundle_id: u64,
    pub credential_ids: Vec<u64>,
    pub verifier: Address,
    pub requested_at: u64,
}

/// Bundle verification result
#[contracttype]
#[derive(Clone)]
pub struct BundleVerificationResult {
    pub bundle_id: u64,
    /// Number of successfully verified credentials
    pub verified_count: u32,
    /// Total credentials in bundle
    pub total_count: u32,
    /// Verification passed (all credentials valid)
    pub all_valid: bool,
    /// Total cost with discount applied
    pub total_cost: u64,
    /// Discount amount saved
    pub discount_amount: u64,
    /// Verification timestamp
    pub verified_at: u64,
}

/// Bundle analytics data
#[contracttype]
#[derive(Clone)]
pub struct BundleAnalytics {
    pub bundle_id: u64,
    /// Total number of verifications
    pub verification_count: u32,
    /// Total cost savings from bundling
    pub total_savings: u64,
    /// Average verification time (milliseconds)
    pub avg_verification_time_ms: u64,
    /// Success rate (0-10000 basis points)
    pub success_rate_bps: u32,
    /// Last updated timestamp
    pub updated_at: u64,
}

/// Bundle event data
#[contracttype]
#[derive(Clone)]
pub struct BundleCreatedEventData {
    pub bundle_id: u64,
    pub issuer: Address,
    pub subject: Address,
    pub credential_count: u32,
    pub pricing_tier: u32,
}

/// Bundle verification event data
#[contracttype]
#[derive(Clone)]
pub struct BundleVerifiedEventData {
    pub bundle_id: u64,
    pub verified_count: u32,
    pub total_count: u32,
    pub cost_savings: u64,
}
