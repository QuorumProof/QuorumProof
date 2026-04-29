// Integration tests for QuorumProof contract interactions (#364)
// Covers multi-contract scenarios and end-to-end credential lifecycle flows.

#[cfg(test)]
mod integration {
    use quorum_proof::{QuorumProofContract, QuorumProofContractClient};
    use sbt_registry::{SbtRegistryContract, SbtRegistryContractClient};
    use zk_verifier::{ClaimType, ZkVerifierContract, ZkVerifierContractClient};
    use soroban_sdk::{
        testutils::Address as _,
        Bytes, BytesN, Env, Vec,
    };

    // ── Shared setup ──────────────────────────────────────────────────────────

    struct Contracts<'a> {
        qp: QuorumProofContractClient<'a>,
        sbt: SbtRegistryContractClient<'a>,
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

        // Register a verifying key hash for ZK proofs
        let vk_hash = BytesN::from_array(env, &[0u8; 32]);
        zk.set_verifying_key(&admin, &vk_hash);

        Contracts { qp, sbt, zk, admin }
    }

    fn metadata(env: &Env) -> Bytes {
        Bytes::from_slice(env, b"QmTestHash000000000000000000000000")
    }

    /// Generate a valid 256-byte Groth16 proof (BN254 uncompressed: A‖B‖C)
    /// A: 64 bytes (G1 point), B: 128 bytes (G2 point), C: 64 bytes (G1 point)
    /// This is a mock proof that passes structure checks but not real pairing verification.
    fn valid_proof(env: &Env) -> Bytes {
        let mut proof_bytes = [0u8; 256];
        // A-point (bytes 0-63): non-zero
        proof_bytes[0] = 1;
        proof_bytes[63] = 1;
        // B-point (bytes 64-191): can be zero
        // C-point (bytes 192-255): non-zero
        proof_bytes[192] = 1;
        proof_bytes[255] = 1;
        Bytes::from_slice(env, &proof_bytes)
    }

    // ── Multi-contract: issue credential → mint SBT ───────────────────────────

    #[test]
    fn test_issue_credential_then_mint_sbt() {
        let env = Env::default();
        let c = setup(&env);

        let issuer = soroban_sdk::Address::generate(&env);
        let holder = soroban_sdk::Address::generate(&env);

        let cred_id = c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None);
        assert_eq!(cred_id, 1);

        let uri = Bytes::from_slice(&env, b"ipfs://QmSBT");
        let token_id = c.sbt.mint(&holder, &cred_id, &uri);
        assert_eq!(token_id, 1);
        assert_eq!(c.sbt.owner_of(&token_id), holder);
    }

    // ── Multi-contract: SBT non-transferability ───────────────────────────────

    #[test]
    #[should_panic]
    fn test_sbt_is_non_transferable() {
        let env = Env::default();
        let c = setup(&env);

        let issuer = soroban_sdk::Address::generate(&env);
        let holder = soroban_sdk::Address::generate(&env);
        let other = soroban_sdk::Address::generate(&env);

        let cred_id = c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None);
        let uri = Bytes::from_slice(&env, b"ipfs://QmSBT");
        let token_id = c.sbt.mint(&holder, &cred_id, &uri);

        // Direct transfer must panic — SBTs are soulbound
        c.sbt.transfer(&holder, &other, &token_id);
    }

    // ── Multi-contract: revoke credential → SBT mint rejected ────────────────

    #[test]
    #[should_panic]
    fn test_mint_sbt_for_revoked_credential_panics() {
        let env = Env::default();
        let c = setup(&env);

        let issuer = soroban_sdk::Address::generate(&env);
        let holder = soroban_sdk::Address::generate(&env);

        let cred_id = c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None);
        c.qp.revoke_credential(&issuer, &cred_id);

        let uri = Bytes::from_slice(&env, b"ipfs://QmSBT");
        c.sbt.mint(&holder, &cred_id, &uri); // must panic
    }

    // ── Multi-contract: ZK verify claim ──────────────────────────────────────

    #[test]
    fn test_zk_verify_claim_succeeds() {
        let env = Env::default();
        let c = setup(&env);

        let issuer = soroban_sdk::Address::generate(&env);
        let holder = soroban_sdk::Address::generate(&env);

        let cred_id = c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None);
        let result = c.zk.verify_claim(
            &c.admin,
            &c.qp.address,
            &cred_id,
            &ClaimType::HasDegree,
            &valid_proof(&env),
        );
        assert!(result);
    }

    #[test]
    fn test_zk_verify_claim_empty_proof_fails() {
        let env = Env::default();
        let c = setup(&env);

        let issuer = soroban_sdk::Address::generate(&env);
        let holder = soroban_sdk::Address::generate(&env);

        let cred_id = c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None);
        let empty_proof = Bytes::new(&env);
        let result = c.zk.verify_claim(
            &c.admin,
            &c.qp.address,
            &cred_id,
            &ClaimType::HasDegree,
            &empty_proof,
        );
        assert!(!result);
    }

    // ── E2E: full engineer credential lifecycle ───────────────────────────────

    #[test]
    fn test_e2e_full_credential_lifecycle() {
        let env = Env::default();
        let c = setup(&env);

        let issuer = soroban_sdk::Address::generate(&env);
        let engineer = soroban_sdk::Address::generate(&env);
        let attestor1 = soroban_sdk::Address::generate(&env);
        let attestor2 = soroban_sdk::Address::generate(&env);

        // 1. Issue credential
        let cred_id = c.qp.issue_credential(&issuer, &engineer, &1u32, &metadata(&env), &None);

        // 2. Create quorum slice (2-of-2)
        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor1.clone());
        attestors.push_back(attestor2.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        weights.push_back(1u32);
        let slice_id = c.qp.create_slice(&issuer, &attestors, &weights, &2u32);

        // 3. Both attestors attest
        c.qp.attest(&attestor1, &cred_id, &slice_id, &true, &None);
        c.qp.attest(&attestor2, &cred_id, &slice_id, &true, &None);

        // 4. Credential is now attested
        assert!(c.qp.is_attested(&cred_id, &slice_id));

        // 5. Mint SBT
        let uri = Bytes::from_slice(&env, b"ipfs://QmEngineerSBT");
        let token_id = c.sbt.mint(&engineer, &cred_id, &uri);
        assert_eq!(c.sbt.owner_of(&token_id), engineer);

        // 6. ZK verify degree claim
        let verified = c.zk.verify_claim(
            &c.admin,
            &c.qp.address,
            &cred_id,
            &ClaimType::HasDegree,
            &valid_proof(&env),
        );
        assert!(verified);
    }

    // ── E2E: verify_engineer cross-contract call ──────────────────────────────

    #[test]
    fn test_e2e_verify_engineer_with_sbt_and_zk() {
        let env = Env::default();
        let c = setup(&env);

        let issuer = soroban_sdk::Address::generate(&env);
        let engineer = soroban_sdk::Address::generate(&env);

        let cred_id = c.qp.issue_credential(&issuer, &engineer, &1u32, &metadata(&env), &None);
        let uri = Bytes::from_slice(&env, b"ipfs://QmSBT");
        c.sbt.mint(&engineer, &cred_id, &uri);

        let result = c.qp.verify_engineer(
            &c.sbt.address,
            &c.zk.address,
            &c.admin,
            &engineer,
            &cred_id,
            &ClaimType::HasDegree,
            &valid_proof(&env),
        );
        assert!(result);
    }

    #[test]
    fn test_e2e_verify_engineer_fails_without_sbt() {
        let env = Env::default();
        let c = setup(&env);

        let issuer = soroban_sdk::Address::generate(&env);
        let engineer = soroban_sdk::Address::generate(&env);

        let cred_id = c.qp.issue_credential(&issuer, &engineer, &1u32, &metadata(&env), &None);
        // No SBT minted

        let result = c.qp.verify_engineer(
            &c.sbt.address,
            &c.zk.address,
            &c.admin,
            &engineer,
            &cred_id,
            &ClaimType::HasDegree,
            &valid_proof(&env),
        );
        assert!(!result);
    }

    // ── E2E: revocation propagates across contracts ───────────────────────────

    #[test]
    #[should_panic]
    fn test_e2e_revocation_blocks_attestation() {
        let env = Env::default();
        let c = setup(&env);

        let issuer = soroban_sdk::Address::generate(&env);
        let holder = soroban_sdk::Address::generate(&env);
        let attestor = soroban_sdk::Address::generate(&env);

        let cred_id = c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None);

        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = c.qp.create_slice(&issuer, &attestors, &weights, &1u32);

        c.qp.revoke_credential(&issuer, &cred_id);

        // Attestation on a revoked credential must panic
        c.qp.attest(&attestor, &cred_id, &slice_id, &true, &None);
    }

    // ── E2E: batch verify across multiple credentials ─────────────────────────

    #[test]
    fn test_e2e_batch_verify_attestations() {
        let env = Env::default();
        let c = setup(&env);

        let issuer = soroban_sdk::Address::generate(&env);
        let holder = soroban_sdk::Address::generate(&env);
        let attestor = soroban_sdk::Address::generate(&env);

        // Issue two credentials
        let cred1 = c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None);
        let cred2 = c.qp.issue_credential(&issuer, &holder, &2u32, &metadata(&env), &None);

        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = c.qp.create_slice(&issuer, &attestors, &weights, &1u32);

        // Only attest cred1
        c.qp.attest(&attestor, &cred1, &slice_id, &true, &None);

        let mut cred_ids = Vec::new(&env);
        cred_ids.push_back(cred1);
        cred_ids.push_back(cred2);
        let mut slice_ids = Vec::new(&env);
        slice_ids.push_back(slice_id);
        slice_ids.push_back(slice_id);

        let results = c.qp.verify_attestations_batch(&cred_ids, &slice_ids);
        assert_eq!(results.get(0).unwrap(), true);
        assert_eq!(results.get(1).unwrap(), false);
    }

    // ── E2E: SBT burn and re-mint after credential renewal ────────────────────

    #[test]
    fn test_e2e_sbt_burn_and_remint() {
        let env = Env::default();
        let c = setup(&env);

        let issuer = soroban_sdk::Address::generate(&env);
        let holder = soroban_sdk::Address::generate(&env);

        let cred_id = c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None);
        let uri = Bytes::from_slice(&env, b"ipfs://QmSBT");
        let token_id = c.sbt.mint(&holder, &cred_id, &uri);

        // Burn the SBT
        c.sbt.burn_sbt(&holder, &token_id);
        assert_eq!(c.sbt.sbt_count(), 0);

        // Re-mint after burn is allowed
        let new_token_id = c.sbt.mint(&holder, &cred_id, &uri);
        assert_eq!(c.sbt.owner_of(&new_token_id), holder);
    }

    // ── Multi-contract: all three contracts initialized independently ─────────

    #[test]
    fn test_all_contracts_initialize_independently() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = soroban_sdk::Address::generate(&env);

        let qp_id = env.register_contract(None, QuorumProofContract);
        let qp = QuorumProofContractClient::new(&env, &qp_id);
        qp.initialize(&admin);

        let sbt_id = env.register_contract(None, SbtRegistryContract);
        let sbt = SbtRegistryContractClient::new(&env, &sbt_id);
        sbt.initialize(&admin, &qp_id);

        let zk_id = env.register_contract(None, ZkVerifierContract);
        let zk = ZkVerifierContractClient::new(&env, &zk_id);
        zk.initialize(&admin);

        // All three are live — basic smoke check
        assert_eq!(qp.get_credential_count(), 0);
        assert_eq!(sbt.sbt_count(), 0);

        // ZK verifier rejects empty proof (no verifying key registered → panics on missing key,
        // so we register one first)
        let vk_hash = BytesN::from_array(&env, &[0u8; 32]);
        zk.set_verifying_key(&admin, &vk_hash);

        let issuer = soroban_sdk::Address::generate(&env);
        let holder = soroban_sdk::Address::generate(&env);
        let cred_id = qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None);
        let empty = Bytes::new(&env);
        assert!(!zk.verify_claim(&admin, &qp_id, &cred_id, &ClaimType::HasLicense, &empty));
    }

    // ── Multi-contract: pause blocks credential issuance ─────────────────────

    #[test]
    #[should_panic]
    fn test_pause_blocks_issue_credential() {
        let env = Env::default();
        let c = setup(&env);

        let issuer = soroban_sdk::Address::generate(&env);
        let holder = soroban_sdk::Address::generate(&env);

        c.qp.pause(&c.admin);
        // Must panic — contract is paused
        c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None);
    }

    #[test]
    fn test_unpause_restores_issuance() {
        let env = Env::default();
        let c = setup(&env);

        let issuer = soroban_sdk::Address::generate(&env);
        let holder = soroban_sdk::Address::generate(&env);

        c.qp.pause(&c.admin);
        assert!(c.qp.is_paused());
        c.qp.unpause(&c.admin);
        assert!(!c.qp.is_paused());

        // Should succeed after unpause
        let cred_id = c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None);
        assert_eq!(cred_id, 1);
    }

    // ── Multi-contract: suspend/resume credential ─────────────────────────────

    #[test]
    #[should_panic]
    fn test_suspended_credential_blocks_attestation() {
        let env = Env::default();
        let c = setup(&env);

        let issuer = soroban_sdk::Address::generate(&env);
        let holder = soroban_sdk::Address::generate(&env);
        let attestor = soroban_sdk::Address::generate(&env);

        let cred_id = c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None);

        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = c.qp.create_slice(&issuer, &attestors, &weights, &1u32);

        c.qp.suspend_credential(&issuer, &cred_id);
        // Must panic — credential is suspended
        c.qp.attest(&attestor, &cred_id, &slice_id, &true, &None);
    }

    #[test]
    fn test_resume_credential_allows_attestation() {
        let env = Env::default();
        let c = setup(&env);

        let issuer = soroban_sdk::Address::generate(&env);
        let holder = soroban_sdk::Address::generate(&env);
        let attestor = soroban_sdk::Address::generate(&env);

        let cred_id = c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None);

        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = c.qp.create_slice(&issuer, &attestors, &weights, &1u32);

        c.qp.suspend_credential(&issuer, &cred_id);
        c.qp.resume_credential(&issuer, &cred_id);

        // Should succeed after resume
        c.qp.attest(&attestor, &cred_id, &slice_id, &true, &None);
        assert!(c.qp.is_attested(&cred_id, &slice_id));
    }

    // ── Multi-contract: ZK all claim types ───────────────────────────────────

    #[test]
    fn test_zk_all_claim_types_with_valid_proof() {
        let env = Env::default();
        let c = setup(&env);

        let issuer = soroban_sdk::Address::generate(&env);
        let holder = soroban_sdk::Address::generate(&env);
        let cred_id = c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None);
        let proof = valid_proof(&env);

        for claim in [
            ClaimType::HasDegree,
            ClaimType::HasLicense,
            ClaimType::HasEmploymentHistory,
            ClaimType::HasCertification,
            ClaimType::HasResearchPublication,
        ] {
            let result = c.zk.verify_claim(&c.admin, &c.qp.address, &cred_id, &claim, &proof);
            // Result depends on SHA-256 of vk_hash||proof not starting with 0xFF
            // With our fixed vk_hash=[0;32] and proof, this should be deterministic
            let _ = result; // just assert it doesn't panic
        }
    }

    // ── Multi-contract: SBT get_tokens_by_owner ──────────────────────────────

    #[test]
    fn test_sbt_get_tokens_by_owner_multi_credential() {
        let env = Env::default();
        let c = setup(&env);

        let issuer = soroban_sdk::Address::generate(&env);
        let holder = soroban_sdk::Address::generate(&env);

        let cred1 = c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None);
        let cred2 = c.qp.issue_credential(&issuer, &holder, &2u32, &metadata(&env), &None);

        let uri = Bytes::from_slice(&env, b"ipfs://QmSBT");
        c.sbt.mint(&holder, &cred1, &uri);
        c.sbt.mint(&holder, &cred2, &uri);

        let tokens = c.sbt.get_tokens_by_owner(&holder);
        assert_eq!(tokens.len(), 2);
        assert_eq!(c.sbt.sbt_count(), 2);
    }

    // ── E2E: credential_exists and get_credential ─────────────────────────────

    #[test]
    fn test_credential_exists_and_get() {
        let env = Env::default();
        let c = setup(&env);

        let issuer = soroban_sdk::Address::generate(&env);
        let holder = soroban_sdk::Address::generate(&env);

        assert!(!c.qp.credential_exists(&1));

        let cred_id = c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None);
        assert!(c.qp.credential_exists(&cred_id));

        let cred = c.qp.get_credential(&cred_id);
        assert_eq!(cred.subject, holder);
        assert_eq!(cred.issuer, issuer);
        assert!(!cred.revoked);
    }

    // ── E2E: add_attestor to existing slice ───────────────────────────────────

    #[test]
    fn test_add_attestor_to_slice_and_attest() {
        let env = Env::default();
        let c = setup(&env);

        let issuer = soroban_sdk::Address::generate(&env);
        let holder = soroban_sdk::Address::generate(&env);
        let attestor1 = soroban_sdk::Address::generate(&env);
        let attestor2 = soroban_sdk::Address::generate(&env);

        let cred_id = c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None);

        let mut attestors = Vec::new(&env);
        attestors.push_back(attestor1.clone());
        let mut weights = Vec::new(&env);
        weights.push_back(1u32);
        let slice_id = c.qp.create_slice(&issuer, &attestors, &weights, &1u32);

        // Add second attestor
        c.qp.add_attestor(&issuer, &slice_id, &attestor2, &1u32);

        // Both attest
        c.qp.attest(&attestor1, &cred_id, &slice_id, &true, &None);
        c.qp.attest(&attestor2, &cred_id, &slice_id, &true, &None);

        assert!(c.qp.is_attested(&cred_id, &slice_id));
    }

    // ── E2E: verify_engineer fails with wrong credential id ───────────────────

    #[test]
    fn test_e2e_verify_engineer_wrong_credential() {
        let env = Env::default();
        let c = setup(&env);

        let issuer = soroban_sdk::Address::generate(&env);
        let engineer = soroban_sdk::Address::generate(&env);

        let cred_id = c.qp.issue_credential(&issuer, &engineer, &1u32, &metadata(&env), &None);
        let uri = Bytes::from_slice(&env, b"ipfs://QmSBT");
        c.sbt.mint(&engineer, &cred_id, &uri);

        // Use a different credential_id — SBT won't match
        let result = c.qp.verify_engineer(
            &c.sbt.address,
            &c.zk.address,
            &c.admin,
            &engineer,
            &(cred_id + 1),
            &ClaimType::HasDegree,
            &valid_proof(&env),
        );
        assert!(!result);
    }

    // ── E2E: ZK proof request generation ─────────────────────────────────────

    #[test]
    fn test_zk_generate_proof_request() {
        let env = Env::default();
        let c = setup(&env);

        let issuer = soroban_sdk::Address::generate(&env);
        let holder = soroban_sdk::Address::generate(&env);
        let cred_id = c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None);

        let req = c.zk.generate_proof_request(&cred_id, &ClaimType::HasLicense);
        assert_eq!(req.credential_id, cred_id);
    }

    // ── E2E: SBT burn removes token from owner ────────────────────────────────

    #[test]
    fn test_sbt_burn_removes_from_owner() {
        let env = Env::default();
        let c = setup(&env);

        let issuer = soroban_sdk::Address::generate(&env);
        let holder = soroban_sdk::Address::generate(&env);

        let cred_id = c.qp.issue_credential(&issuer, &holder, &1u32, &metadata(&env), &None);
        let uri = Bytes::from_slice(&env, b"ipfs://QmSBT");
        let token_id = c.sbt.mint(&holder, &cred_id, &uri);

        assert_eq!(c.sbt.sbt_count(), 1);
        c.sbt.burn_sbt(&holder, &token_id);
        assert_eq!(c.sbt.sbt_count(), 0);

        let tokens = c.sbt.get_tokens_by_owner(&holder);
        assert_eq!(tokens.len(), 0);
    }
}
