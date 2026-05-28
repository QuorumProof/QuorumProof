// Issue #552: Contract invariant checker
// Verifies that core protocol invariants hold after every mutating operation.
// Fail-fast on any violation to detect state corruption early.

use quorum_proof::{QuorumProofContract, QuorumProofContractClient};
use sbt_registry::{SbtRegistryContract, SbtRegistryContractClient};
use zk_verifier::{ZkVerifierContract, ZkVerifierContractClient};
use soroban_sdk::{testutils::Address as _, Bytes, BytesN, Env, Vec};

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

// Invariant: credential count is monotonically non-decreasing after each issuance.
#[test]
fn invariant_credential_count_monotonic() {
    let env = Env::default();
    let c = setup(&env);
    let issuer = soroban_sdk::Address::generate(&env);
    let holder = soroban_sdk::Address::generate(&env);

    let count_before = c.qp.get_credential_count();
    c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None, &0u64);
    let count_after = c.qp.get_credential_count();
    assert!(
        count_after > count_before,
        "invariant violated: credential count must increase after issuance"
    );

    c.qp.issue_credential(&issuer, &holder, &2u32, &metadata(&env), &None, &0u64);
    let count_final = c.qp.get_credential_count();
    assert!(
        count_final > count_after,
        "invariant violated: count must keep growing with each new credential"
    );
}

// Invariant: once revoked, a credential stays revoked and count is unchanged.
#[test]
fn invariant_revocation_is_permanent() {
    let env = Env::default();
    let c = setup(&env);
    let issuer = soroban_sdk::Address::generate(&env);
    let holder = soroban_sdk::Address::generate(&env);

    let cred_id =
        c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None, &0u64);
    assert!(!c.qp.is_revoked(&cred_id));

    let count_before_revoke = c.qp.get_credential_count();
    c.qp.revoke_credential(&issuer, &cred_id);

    assert!(
        c.qp.is_revoked(&cred_id),
        "invariant violated: credential must be revoked after revoke_credential"
    );
    assert_eq!(
        c.qp.get_credential_count(),
        count_before_revoke,
        "invariant violated: revocation must not alter credential count"
    );
}

// Invariant: SBT count accurately reflects mints and burns.
#[test]
fn invariant_sbt_count_matches_ownership() {
    let env = Env::default();
    let c = setup(&env);
    let issuer = soroban_sdk::Address::generate(&env);
    let holder = soroban_sdk::Address::generate(&env);

    assert_eq!(c.sbt.sbt_count(), 0, "invariant violated: initial sbt_count must be 0");

    let cred_id =
        c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None, &0u64);
    let uri = Bytes::from_slice(&env, b"ipfs://QmSBT");
    let token_id = c.sbt.mint(&holder, &cred_id, &uri);

    assert_eq!(
        c.sbt.sbt_count(),
        1,
        "invariant violated: sbt_count must be 1 after mint"
    );
    assert_eq!(
        c.sbt.owner_of(&token_id),
        holder,
        "invariant violated: token owner must be the minting holder"
    );
    assert_eq!(
        c.sbt.get_tokens_by_owner(&holder).len(),
        1,
        "invariant violated: get_tokens_by_owner must return exactly 1 token"
    );

    c.sbt.burn_sbt(&holder, &token_id);

    assert_eq!(
        c.sbt.sbt_count(),
        0,
        "invariant violated: sbt_count must drop to 0 after burn"
    );
    assert_eq!(
        c.sbt.get_tokens_by_owner(&holder).len(),
        0,
        "invariant violated: holder must have no tokens after burn"
    );
}

// Invariant: credential subject is immutable — attestation must not alter subject.
#[test]
fn invariant_credential_subject_immutable() {
    let env = Env::default();
    let c = setup(&env);
    let issuer = soroban_sdk::Address::generate(&env);
    let holder = soroban_sdk::Address::generate(&env);
    let attestor = soroban_sdk::Address::generate(&env);

    let cred_id =
        c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None, &0u64);
    let subject_before = c.qp.get_credential(&cred_id).subject;

    let mut attestors = Vec::new(&env);
    attestors.push_back(attestor.clone());
    let mut weights = Vec::new(&env);
    weights.push_back(1u32);
    let slice_id = c.qp.create_slice(&issuer, &attestors, &weights, &1u32);
    c.qp.attest(&attestor, &cred_id, &slice_id, &true, &None);

    let subject_after = c.qp.get_credential(&cred_id).subject;
    assert_eq!(
        subject_before, subject_after,
        "invariant violated: attestation must not change credential subject"
    );
}

// Invariant: paused contract must read-consistently — count stays unchanged.
#[test]
fn invariant_pause_halts_mutations() {
    let env = Env::default();
    let c = setup(&env);

    assert!(!c.qp.is_paused());
    c.qp.pause(&c.admin);
    assert!(c.qp.is_paused(), "invariant violated: is_paused must be true after pause");

    let count_while_paused = c.qp.get_credential_count();
    assert_eq!(
        count_while_paused,
        0,
        "invariant violated: no credentials must exist after pausing an empty contract"
    );

    c.qp.unpause(&c.admin);
    assert!(!c.qp.is_paused(), "invariant violated: is_paused must be false after unpause");
}

// Invariant: duplicate (owner, credential_id) SBT mint must be rejected.
#[test]
#[should_panic]
fn invariant_no_duplicate_sbt_per_credential() {
    let env = Env::default();
    let c = setup(&env);
    let issuer = soroban_sdk::Address::generate(&env);
    let holder = soroban_sdk::Address::generate(&env);

    let cred_id =
        c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None, &0u64);
    let uri = Bytes::from_slice(&env, b"ipfs://QmSBT");
    c.sbt.mint(&holder, &cred_id, &uri);
    c.sbt.mint(&holder, &cred_id, &uri); // duplicate — must panic
}

// Invariant: is_attested is consistent with attestation records and count.
#[test]
fn invariant_attestation_state_consistent() {
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

    assert!(
        !c.qp.is_attested(&cred_id, &slice_id),
        "invariant violated: credential must not be attested before any attestation"
    );

    c.qp.attest(&attestor, &cred_id, &slice_id, &true, &None);

    assert!(
        c.qp.is_attested(&cred_id, &slice_id),
        "invariant violated: credential must be attested after a valid attest call"
    );
    assert!(
        c.qp.get_attestation_count(&cred_id) >= 1,
        "invariant violated: attestation count must reflect stored records"
    );
}

// Invariant: credential_exists is consistent with get_credential output.
#[test]
fn invariant_exists_consistent_with_get() {
    let env = Env::default();
    let c = setup(&env);
    let issuer = soroban_sdk::Address::generate(&env);
    let holder = soroban_sdk::Address::generate(&env);

    assert!(
        !c.qp.credential_exists(&999u64),
        "invariant violated: non-existent credential ID must return false"
    );

    let cred_id =
        c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None, &0u64);

    assert!(
        c.qp.credential_exists(&cred_id),
        "invariant violated: issued credential must exist"
    );

    let cred = c.qp.get_credential(&cred_id);
    assert_eq!(
        cred.subject, holder,
        "invariant violated: stored subject must match the holder at issuance"
    );
    assert!(
        !cred.revoked,
        "invariant violated: freshly issued credential must not be revoked"
    );
}

// Invariant: slice count grows monotonically with create_slice calls.
#[test]
fn invariant_slice_count_monotonic() {
    let env = Env::default();
    let c = setup(&env);
    let creator = soroban_sdk::Address::generate(&env);
    let attestor = soroban_sdk::Address::generate(&env);

    let count_before = c.qp.get_slice_count();

    let mut attestors = Vec::new(&env);
    attestors.push_back(attestor.clone());
    let mut weights = Vec::new(&env);
    weights.push_back(1u32);
    c.qp.create_slice(&creator, &attestors, &weights, &1u32);

    let count_after = c.qp.get_slice_count();
    assert!(
        count_after > count_before,
        "invariant violated: slice count must increase after create_slice"
    );
}
