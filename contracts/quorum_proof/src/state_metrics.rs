//! Operator-facing contract health metrics (issue: "Operators can't see contract
//! health").
//!
//! Soroban contracts have no built-in notion of "storage usage" or "active vs.
//! revoked credentials" that an off-chain exporter can scrape directly — every
//! number has to be assembled from whatever counters the contract already
//! maintains. This module centralizes that assembly into a single read-only
//! call (`QuorumProofContract::get_state_metrics`) so the exporter, dashboards
//! and alerting rules all agree on one definition of each figure instead of
//! each re-deriving it independently.
//!
//! All fields here are read from existing instance-storage counters (no new
//! iteration over unbounded collections), so this call stays cheap regardless
//! of how large the deployment has grown.

use soroban_sdk::{contracttype, Env, Map, String};

use crate::{DataKey, EXTENDED_TTL, STANDARD_TTL};

/// Snapshot of contract-level health indicators, returned by
/// `get_state_metrics`. Every field is O(1) to compute from existing
/// instance-storage counters.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContractStateMetrics {
    /// Total credentials ever issued (includes revoked ones).
    pub credentials_issued_total: u64,
    /// Total credentials revoked to date.
    pub credentials_revoked_total: u64,
    /// `credentials_issued_total - credentials_revoked_total`. The primary
    /// "active credentials" figure operators care about.
    pub credentials_active: u64,
    /// Total slices created (0 if the slice feature has never been used).
    pub slices_total: u64,
    /// Total DID documents registered (0 if the DID feature has never been used).
    pub dids_total: u64,
    /// Whether the contract is currently paused.
    pub paused: bool,
    /// Current on-chain state/schema version, for correlating metrics with
    /// deployed contract versions during rollouts.
    pub state_version: u32,
    /// Coarse storage-usage proxy: the sum of every counter this struct
    /// tracks. Not a byte count (Soroban does not expose one to contract
    /// code) — a monotonically-increasing proxy operators can chart to spot
    /// abnormal growth or a stalled counter.
    pub storage_entries_estimate: u64,
}

/// Assemble the current `ContractStateMetrics` snapshot from instance storage.
/// Unauthenticated and side-effect free — safe to poll on every exporter scrape.
pub fn collect(env: &Env) -> ContractStateMetrics {
    let storage = env.storage().instance();

    let credentials_issued_total: u64 = storage.get(&DataKey::CredentialCount).unwrap_or(0u64);
    let credentials_revoked_total: u64 = storage
        .get(&DataKey::RevokedCredentialCount)
        .unwrap_or(0u64);
    let slices_total: u64 = storage.get(&DataKey::SliceCount).unwrap_or(0u64);
    let dids_total: u64 = storage
        .get(&crate::DataKey7::DidCount)
        .unwrap_or(0u64);
    let paused: bool = storage.get(&DataKey::Paused).unwrap_or(false);
    let state_version: u32 = storage.get(&DataKey::StateVersion).unwrap_or(0u32);

    let credentials_active = credentials_issued_total.saturating_sub(credentials_revoked_total);
    let storage_entries_estimate =
        credentials_issued_total + slices_total + dids_total;

    ContractStateMetrics {
        credentials_issued_total,
        credentials_revoked_total,
        credentials_active,
        slices_total,
        dids_total,
        paused,
        state_version,
        storage_entries_estimate,
    }
}

/// Storage key for the per-action credential lifecycle counters (issue #1390).
/// Kept separate from `DataKey` so the counters can grow new action labels
/// without touching the contract's main key enum.
#[contracttype]
#[derive(Clone)]
pub enum CredentialMetricsKey {
    /// Single map of `action label -> event count`. One instance entry
    /// regardless of how many labels the lifecycle paths report.
    ActionCounts,
}

/// Increment the counter for one credential lifecycle `action` (e.g.
/// `"credential"` for an issuance, `"revocation"` for a revocation).
pub fn record_credential_action(env: &Env, action: &String) {
    let mut counts = get_credential_action_counts(env);
    let next = counts.get(action.clone()).unwrap_or(0u64).saturating_add(1);
    counts.set(action.clone(), next);
    env.storage()
        .instance()
        .set(&CredentialMetricsKey::ActionCounts, &counts);
    env.storage()
        .instance()
        .extend_ttl(STANDARD_TTL, EXTENDED_TTL);
}

/// Read the per-action credential lifecycle counters. Empty until the first
/// lifecycle event is recorded.
pub fn get_credential_action_counts(env: &Env) -> Map<String, u64> {
    env.storage()
        .instance()
        .get(&CredentialMetricsKey::ActionCounts)
        .unwrap_or(Map::new(env))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::QuorumProofContract;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::Address;

    #[test]
    fn credential_action_counts_accumulate_per_action() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register_contract(None, QuorumProofContract);
        crate::QuorumProofContractClient::new(&env, &contract_id).initialize(&admin);

        env.as_contract(&contract_id, || {
            let issuance = String::from_str(&env, "credential");
            let revocation = String::from_str(&env, "revocation");

            assert_eq!(get_credential_action_counts(&env).len(), 0);

            record_credential_action(&env, &issuance);
            record_credential_action(&env, &issuance);
            record_credential_action(&env, &revocation);

            let counts = get_credential_action_counts(&env);
            assert_eq!(counts.get(issuance).unwrap(), 2u64);
            assert_eq!(counts.get(revocation).unwrap(), 1u64);
        });
    }
}
