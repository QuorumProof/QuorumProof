//! Issue #987: Integration tests for credential holder earnings / access tracking.
//!
//! These tests are intentionally self-contained: instead of deploying the real
//! `quorum_proof` contract (which the inline unit tests use), they deploy a tiny
//! mock that implements only the `is_revoked(credential_id) -> bool` entrypoint
//! that `sbt_registry` cross-calls. This keeps the access-tracking tests runnable
//! and isolated from the rest of the workspace.

#![cfg(test)]

use soroban_sdk::{
    contract, contractimpl, contracttype, testutils::Address as _, Address, Bytes, Env,
};

use sbt_registry::{SbtRegistryContract, SbtRegistryContractClient};

// ── Minimal mock quorum_proof, exposing just `is_revoked` ────────────────────

#[contracttype]
enum MockKey {
    Revoked(u64),
}

#[contract]
pub struct MockQuorumProof;

#[contractimpl]
impl MockQuorumProof {
    /// Mark a credential as revoked / not revoked.
    pub fn set_revoked(env: Env, credential_id: u64, revoked: bool) {
        env.storage()
            .persistent()
            .set(&MockKey::Revoked(credential_id), &revoked);
    }

    /// Mirrors quorum_proof::is_revoked — defaults to `false` (not revoked).
    pub fn is_revoked(env: Env, credential_id: u64) -> bool {
        env.storage()
            .persistent()
            .get(&MockKey::Revoked(credential_id))
            .unwrap_or(false)
    }
}

fn setup(env: &Env) -> (SbtRegistryContractClient<'static>, Address, Address) {
    env.mock_all_auths();

    let qp_id = env.register_contract(None, MockQuorumProof);

    let sbt_id = env.register_contract(None, SbtRegistryContract);
    let client = SbtRegistryContractClient::new(env, &sbt_id);
    let admin = Address::generate(env);
    client.initialize(&admin, &qp_id);

    (client, admin, qp_id)
}

/// Mint an SBT for a fresh owner against `credential_id`, returning the owner.
fn mint_for(env: &Env, client: &SbtRegistryContractClient, credential_id: u64) -> Address {
    let owner = Address::generate(env);
    let uri = Bytes::from_slice(env, b"ipfs://QmSBT");
    client.mint(&owner, &credential_id, &uri);
    owner
}

#[test]
fn access_log_empty_by_default() {
    let env = Env::default();
    let (client, _admin, _qp) = setup(&env);

    assert_eq!(client.get_credential_access_log(&1u64).len(), 0);
}

#[test]
fn track_credential_access_records_entry() {
    let env = Env::default();
    let (client, _admin, _qp) = setup(&env);

    let cred_id = 1u64;
    let _owner = mint_for(&env, &client, cred_id);

    let verifier = Address::generate(&env);
    client.track_credential_access(&cred_id, &verifier);

    let log = client.get_credential_access_log(&cred_id);
    assert_eq!(log.len(), 1);
    let entry = log.get(0).unwrap();
    assert_eq!(entry.accessor, verifier);
    // Micropayment is stubbed at zero for now.
    assert_eq!(entry.payment, 0i128);
}

#[test]
fn track_credential_access_appends_multiple() {
    let env = Env::default();
    let (client, _admin, _qp) = setup(&env);

    let cred_id = 7u64;
    let _owner = mint_for(&env, &client, cred_id);

    let v1 = Address::generate(&env);
    let v2 = Address::generate(&env);
    client.track_credential_access(&cred_id, &v1);
    client.track_credential_access(&cred_id, &v2);

    let log = client.get_credential_access_log(&cred_id);
    assert_eq!(log.len(), 2);
    assert_eq!(log.get(0).unwrap().accessor, v1);
    assert_eq!(log.get(1).unwrap().accessor, v2);
}

#[test]
fn track_credential_access_is_per_credential() {
    let env = Env::default();
    let (client, _admin, _qp) = setup(&env);

    let cred_a = 10u64;
    let cred_b = 20u64;
    let _oa = mint_for(&env, &client, cred_a);
    let _ob = mint_for(&env, &client, cred_b);

    let verifier = Address::generate(&env);
    client.track_credential_access(&cred_a, &verifier);

    assert_eq!(client.get_credential_access_log(&cred_a).len(), 1);
    // An access on credential A must not appear under credential B.
    assert_eq!(client.get_credential_access_log(&cred_b).len(), 0);
}

#[test]
#[should_panic(expected = "credential is revoked")]
fn track_credential_access_revoked_panics() {
    let env = Env::default();
    let (client, _admin, qp_id) = setup(&env);

    let cred_id = 3u64;
    let _owner = mint_for(&env, &client, cred_id);

    // Revoke the credential in the mock, then attempt to log access.
    let qp = MockQuorumProofClient::new(&env, &qp_id);
    qp.set_revoked(&cred_id, &true);

    let verifier = Address::generate(&env);
    client.track_credential_access(&cred_id, &verifier);
}

#[test]
#[should_panic]
fn track_credential_access_unauthorized_panics() {
    let env = Env::default();
    let (client, _admin, _qp) = setup(&env);

    let cred_id = 5u64;
    let _owner = mint_for(&env, &client, cred_id);

    // Clear all mocked authorizations: the verifier has NOT authorized this call,
    // so the verifier-only require_auth must reject it.
    env.set_auths(&[]);
    let verifier = Address::generate(&env);
    client.track_credential_access(&cred_id, &verifier);
}
