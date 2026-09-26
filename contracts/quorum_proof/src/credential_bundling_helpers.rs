/// Helper functions for credential bundling implementation
/// Issue #1596: Credential Bundling for Discounts

use soroban_sdk::{Address, Env, Vec};
use crate::credential_bundling::{BundlePricingTier, CredentialBundle};

/// Calculate the pricing tier based on bundle size
pub fn calculate_pricing_tier(bundle_size: usize) -> BundlePricingTier {
    match bundle_size {
        1 => BundlePricingTier::Single,
        2..=5 => BundlePricingTier::Small,
        6..=15 => BundlePricingTier::Medium,
        16..=50 => BundlePricingTier::Large,
        _ => BundlePricingTier::VeryLarge,
    }
}

/// Calculate the discount percentage for a given tier
pub fn get_discount_percentage(tier: BundlePricingTier) -> u32 {
    match tier {
        BundlePricingTier::Single => 0,
        BundlePricingTier::Small => 10,
        BundlePricingTier::Medium => 25,
        BundlePricingTier::Large => 40,
        BundlePricingTier::VeryLarge => 50,
    }
}

/// Calculate effective cost after discount
pub fn calculate_effective_cost(
    base_cost: u64,
    discount_percentage: u32,
) -> u64 {
    (base_cost * (100 - discount_percentage as u64)) / 100
}

/// Validate bundle integrity
pub fn validate_bundle(
    env: &Env,
    bundle: &CredentialBundle,
) -> bool {
    // Check that bundle has at least one credential
    if bundle.credential_ids.is_empty() {
        return false;
    }

    // Check that effective cost is less than or equal to base cost
    if bundle.effective_cost_per_credential > bundle.base_cost_per_credential {
        return false;
    }

    // Check that discount percentage is between 0 and 100
    if bundle.discount_percentage > 100 {
        return false;
    }

    // Check that the bundle is not expired
    if let Some(expires_at) = bundle.expires_at {
        let now = env.ledger().timestamp();
        if now > expires_at {
            return false;
        }
    }

    true
}

/// Calculate total savings from bundling
pub fn calculate_total_savings(
    base_cost_per_credential: u64,
    bundle_size: u32,
    discount_percentage: u32,
) -> u64 {
    let total_base_cost = base_cost_per_credential * bundle_size as u64;
    (total_base_cost * discount_percentage as u64) / 100
}

/// Determine if a bundle qualifies for a volume discount
pub fn qualifies_for_additional_discount(
    current_discount: u32,
    historical_bundles: u32,
) -> bool {
    // Grant additional discount if customer has created 5+ bundles
    historical_bundles >= 5
}
