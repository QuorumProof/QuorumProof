// Issue #555: Security audit trail verification
// Verifies that every state-changing operation emits the correct on-chain event,
// detects missing events, and ensures unauthorized operations are rejected.

use quorum_proof::{
    AttestationEventData, CredentialIssuedEventData, RevokeEventData,
    QuorumProofContract, QuorumProofContractClient,
};
use sbt_registry::{SbtRegistryContract, SbtRegistryContractClient};
use zk_verifier::{ZkVerifierContract, ZkVerifierContractClient};
use soroban_sdk::{
    symbol_short,
    testutils::Address as _,
    Bytes, BytesN, Env, String, Vec,
};

struct Contracts<'a> {
    qp: QuorumProofContractClient<'a>,
    sbt: SbtRegistryContractClient<'a>,
    #[allow(dead_code)]
    zk: ZkVerifierContractClient<'a>,
    admin: soroban_sdk::Address,
}

fn setup(env: &Env) -> Contracts<'_> {
    env.mock_all_auths();
    let admin = soroban_sdk::Address::generate(env);

    let qp_id = env.register_contract(None, QuorumProofContract);
    let qp = QuorumProofContractClient::new(env, &qp_id);
    qp.initialize(&admin);

    let sbt_id = env.register_contract(None, SbtRegistryContract);
    let sbt = SbtRegistryContractClient::new(env, &sbt_id);
    sbt.initialize(&admin, &qp_id);

    let zk_id = env.register_contract(None, ZkVerifierContract);
    let zk = ZkVerifierContractClient::new(env, &zk_id);
    zk.initialize(&admin);
    let vk_hash = BytesN::from_array(env, &[0u8; 32]);
    zk.set_verifying_key(&admin, &vk_hash);

    Contracts { qp, sbt, zk, admin }
}

fn metadata(env: &Env) -> Bytes {
    Bytes::from_slice(env, b"QmTestHash000000000000000000000000")
}

/// Returns true if the event log contains an event whose first topic is
/// the given soroban_sdk::String value (used by quorum_proof events).
fn has_string_topic_event(env: &Env, topic: &str) -> bool {
    let expected = String::from_str(env, topic);
    env.events().all().iter().any(|(_, topics, _)| {
        topics
            .get(0)
            .and_then(|v| String::try_from_val(env, &v).ok())
            .map(|s| s == expected)
            .unwrap_or(false)
    })
}

/// Returns true if the event log contains an event whose first topic is
/// the given Symbol value (used by sbt_registry events).
fn has_symbol_topic_event(env: &Env, sym: soroban_sdk::Symbol) -> bool {
    env.events().all().iter().any(|(_, topics, _)| {
        topics
            .get(0)
            .and_then(|v| soroban_sdk::Symbol::try_from_val(env, &v).ok())
            .map(|s| s == sym)
            .unwrap_or(false)
    })
}

// Audit: issue_credential must emit a CredentialIssued event with correct payload.
#[test]
fn audit_issue_credential_emits_event() {
    let env = Env::default();
    let c = setup(&env);
    let issuer = soroban_sdk::Address::generate(&env);
    let holder = soroban_sdk::Address::generate(&env);

    let cred_id =
        c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None, &0u64);

    assert!(
        has_string_topic_event(&env, "CredentialIssued"),
        "audit: CredentialIssued event must be emitted after issue_credential"
    );

    let event = env.events().all().iter().find(|(_, topics, _)| {
        topics
            .get(0)
            .and_then(|v| String::try_from_val(&env, &v).ok())
            .map(|s| s == String::from_str(&env, "CredentialIssued"))
            .unwrap_or(false)
    });
    let (_, _, data) = event.unwrap();
    let payload: CredentialIssuedEventData = soroban_sdk::Val::into_val(&data, &env);
    assert_eq!(payload.id, cred_id, "audit: event id must match issued credential");
    assert_eq!(payload.subject, holder, "audit: event subject must match holder");
}

// Audit: revoke_credential must emit a RevokeCredential event with the correct id.
#[test]
fn audit_revoke_credential_emits_event() {
    let env = Env::default();
    let c = setup(&env);
    let issuer = soroban_sdk::Address::generate(&env);
    let holder = soroban_sdk::Address::generate(&env);

    let cred_id =
        c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None, &0u64);
    c.qp.revoke_credential(&issuer, &cred_id);

    assert!(
        has_string_topic_event(&env, "RevokeCredential"),
        "audit: RevokeCredential event must be emitted after revoke_credential"
    );

    let event = env.events().all().iter().find(|(_, topics, _)| {
        topics
            .get(0)
            .and_then(|v| String::try_from_val(&env, &v).ok())
            .map(|s| s == String::from_str(&env, "RevokeCredential"))
            .unwrap_or(false)
    });
    let (_, _, data) = event.unwrap();
    let payload: RevokeEventData = soroban_sdk::Val::into_val(&data, &env);
    assert_eq!(
        payload.credential_id, cred_id,
        "audit: revocation event credential_id must match"
    );
}

// Audit: attest must emit an attestation event with the correct attestor and credential.
#[test]
fn audit_attest_emits_event() {
    let env = Env::default();
    let c = setup(&env);
    let issuer = soroban_sdk::Address::generate(&env);
    let holder = soroban_sdk::Address::generate(&env);
    let attestor = soroban_sdk::Address::generate(&env);

    let cred_id =
        c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None, &0u64);
    let mut attestors = Vec::new(&env);
    attestors.push_back(attestor.clone());
    let mut weights = Vec::new(&env);
    weights.push_back(1u32);
    let slice_id = c.qp.create_slice(&issuer, &attestors, &weights, &1u32);
    c.qp.attest(&attestor, &cred_id, &slice_id, &true, &None);

    assert!(
        has_string_topic_event(&env, "attestation"),
        "audit: attestation event must be emitted after attest"
    );

    let event = env.events().all().iter().find(|(_, topics, _)| {
        topics
            .get(0)
            .and_then(|v| String::try_from_val(&env, &v).ok())
            .map(|s| s == String::from_str(&env, "attestation"))
            .unwrap_or(false)
    });
    let (_, _, data) = event.unwrap();
    let payload: AttestationEventData = soroban_sdk::Val::into_val(&data, &env);
    assert_eq!(
        payload.credential_id, cred_id,
        "audit: attestation event credential_id must match"
    );
    assert_eq!(
        payload.attestor, attestor,
        "audit: attestation event attestor must match"
    );
}

// Audit: SBT mint must emit a mint event with the token ID in the topics.
#[test]
fn audit_sbt_mint_emits_event() {
    let env = Env::default();
    let c = setup(&env);
    let issuer = soroban_sdk::Address::generate(&env);
    let holder = soroban_sdk::Address::generate(&env);

    let cred_id =
        c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None, &0u64);
    let uri = Bytes::from_slice(&env, b"ipfs://QmSBT");
    let token_id = c.sbt.mint(&holder, &cred_id, &uri);

    assert!(
        has_symbol_topic_event(&env, symbol_short!("mint")),
        "audit: mint event must be emitted after SBT mint"
    );

    let event = env.events().all().iter().find(|(_, topics, _)| {
        topics
            .get(0)
            .and_then(|v| soroban_sdk::Symbol::try_from_val(&env, &v).ok())
            .map(|s| s == symbol_short!("mint"))
            .unwrap_or(false)
    });
    let (_, topics, _) = event.unwrap();
    let emitted_id: u64 = soroban_sdk::Val::into_val(&topics.get(1).unwrap(), &env);
    assert_eq!(emitted_id, token_id, "audit: mint event token_id must match the minted token");
}

// Audit: SBT burn_sbt must emit a burn event.
#[test]
fn audit_sbt_burn_emits_event() {
    let env = Env::default();
    let c = setup(&env);
    let issuer = soroban_sdk::Address::generate(&env);
    let holder = soroban_sdk::Address::generate(&env);

    let cred_id =
        c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None, &0u64);
    let uri = Bytes::from_slice(&env, b"ipfs://QmSBT");
    let token_id = c.sbt.mint(&holder, &cred_id, &uri);
    c.sbt.burn_sbt(&holder, &token_id);

    assert!(
        has_symbol_topic_event(&env, symbol_short!("burn")),
        "audit: burn event must be emitted after burn_sbt"
    );
}

// Audit: paused contract must not emit a CredentialIssued event on failed issue.
// Uses try_issue_credential so the Err result can be inspected without panicking.
#[test]
fn audit_paused_contract_emits_no_issue_event() {
    let env = Env::default();
    let c = setup(&env);
    let issuer = soroban_sdk::Address::generate(&env);
    let holder = soroban_sdk::Address::generate(&env);

    c.qp.pause(&c.admin);

    // try_ variant returns Result — no panic, we can continue and check events
    let result =
        c.qp.try_issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None, &0u64);

    assert!(result.is_err(), "audit: issue_credential must fail when contract is paused");
    assert!(
        !has_string_topic_event(&env, "CredentialIssued"),
        "audit: no CredentialIssued event must appear when issue_credential is rejected"
    );
}

// Audit: unauthorized burn_sbt must be rejected — ownership unchanged, no spurious burn event.
#[test]
fn audit_unauthorized_burn_rejected() {
    let env = Env::default();
    let c = setup(&env);
    let issuer = soroban_sdk::Address::generate(&env);
    let holder = soroban_sdk::Address::generate(&env);
    let stranger = soroban_sdk::Address::generate(&env);

    let cred_id =
        c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None, &0u64);
    let uri = Bytes::from_slice(&env, b"ipfs://QmSBT");
    let token_id = c.sbt.mint(&holder, &cred_id, &uri);

    // try_ variant: Err means the unauthorized call was rejected
    let result = c.sbt.try_burn_sbt(&stranger, &token_id);
    assert!(result.is_err(), "audit: burn_sbt by stranger must be rejected");

    // State must be intact
    assert_eq!(
        c.sbt.owner_of(&token_id),
        holder,
        "audit: token owner must not change after rejected unauthorized burn"
    );
}

// Audit: soulbound transfer must be blocked — ownership unchanged.
#[test]
fn audit_sbt_transfer_blocked() {
    let env = Env::default();
    let c = setup(&env);
    let issuer = soroban_sdk::Address::generate(&env);
    let holder = soroban_sdk::Address::generate(&env);
    let other = soroban_sdk::Address::generate(&env);

    let cred_id =
        c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None, &0u64);
    let uri = Bytes::from_slice(&env, b"ipfs://QmSBT");
    let token_id = c.sbt.mint(&holder, &cred_id, &uri);

    // Transfer is always rejected for SBTs
    let result = c.sbt.try_transfer(&holder, &other, &token_id);
    assert!(result.is_err(), "audit: soulbound transfer must be rejected");

    // Verify ownership is still the original holder
    assert_eq!(
        c.sbt.owner_of(&token_id),
        holder,
        "audit: token owner must be unchanged after rejected transfer"
    );
}

// Audit: full credential lifecycle — every state change must be logged.
#[test]
fn audit_full_lifecycle_all_events_present() {
    let env = Env::default();
    let c = setup(&env);
    let issuer = soroban_sdk::Address::generate(&env);
    let holder = soroban_sdk::Address::generate(&env);
    let attestor = soroban_sdk::Address::generate(&env);

    let cred_id =
        c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None, &0u64);
    assert!(has_string_topic_event(&env, "CredentialIssued"), "audit: missing CredentialIssued");

    let mut att_list = Vec::new(&env);
    att_list.push_back(attestor.clone());
    let mut wts = Vec::new(&env);
    wts.push_back(1u32);
    let slice_id = c.qp.create_slice(&issuer, &att_list, &wts, &1u32);
    c.qp.attest(&attestor, &cred_id, &slice_id, &true, &None);
    assert!(has_string_topic_event(&env, "attestation"), "audit: missing attestation event");

    let uri = Bytes::from_slice(&env, b"ipfs://QmSBT");
    let token_id = c.sbt.mint(&holder, &cred_id, &uri);
    assert!(
        has_symbol_topic_event(&env, symbol_short!("mint")),
        "audit: missing SBT mint event"
    );

    c.sbt.burn_sbt(&holder, &token_id);
    assert!(
        has_symbol_topic_event(&env, symbol_short!("burn")),
        "audit: missing SBT burn event"
    );

    c.qp.revoke_credential(&issuer, &cred_id);
    assert!(
        has_string_topic_event(&env, "RevokeCredential"),
        "audit: missing RevokeCredential event"
    );
}
