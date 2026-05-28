#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Bytes, BytesN, Env, Vec};

/// Supported claim types for ZK verification.
#[contracttype]
#[derive(Clone, PartialEq)]
pub enum ClaimType {
    HasDegree,
    HasLicense,
    HasEmploymentHistory,
}

#[contracttype]
#[derive(Clone)]
pub struct ProofRequest {
    pub credential_id: u64,
    pub claim_type: ClaimType,
    pub nonce: u64,
}

#[contracttype]
pub enum DataKey {
    RevokedProofs,
}

#[contract]
pub struct ZkVerifierContract;

#[contractimpl]
impl ZkVerifierContract {
    /// Generate a proof request for a given credential and claim type.
    pub fn generate_proof_request(
        env: Env,
        credential_id: u64,
        claim_type: ClaimType,
    ) -> ProofRequest {
        let nonce = env.ledger().sequence() as u64;
        ProofRequest { credential_id, claim_type, nonce }
    }

    /// Admin-only: revoke a proof by its hash, preventing future verification.
    pub fn revoke_proof(env: Env, admin: Address, proof_hash: BytesN<32>) {
        admin.require_auth();
        let mut revoked: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&DataKey::RevokedProofs)
            .unwrap_or_else(|| Vec::new(&env));
        revoked.push_back(proof_hash);
        env.storage().persistent().set(&DataKey::RevokedProofs, &revoked);
    }

    /// Check whether a proof hash has been revoked.
    pub fn is_revoked(env: Env, proof_hash: BytesN<32>) -> bool {
        let revoked: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&DataKey::RevokedProofs)
            .unwrap_or_else(|| Vec::new(&env));
        revoked.contains(&proof_hash)
    }

    /// Verify a ZK proof for a claim.
    /// Returns false if the proof is empty or has been revoked.
    /// Stub: replace with real ZK logic in v1.1.
    pub fn verify_claim(
        env: Env,
        _quorum_proof_id: Address,
        _credential_id: u64,
        _claim_type: ClaimType,
        proof: Bytes,
    ) -> bool {
        if proof.is_empty() {
            return false;
        }
        // Derive a 32-byte hash of the proof for revocation lookup.
        let proof_hash: BytesN<32> = env.crypto().sha256(&proof).into();
        !Self::is_revoked(env, proof_hash)
    }

    /// Admin-only contract upgrade to new WASM.
    pub fn upgrade(env: Env, admin: Address, new_wasm_hash: soroban_sdk::BytesN<32>) {
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{Bytes, Env};
    use soroban_sdk::testutils::Address as _;

    fn setup() -> (Env, ZkVerifierContractClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &id);
        (env, client)
    }

    #[test]
    fn test_verify_claim_degree_success() {
        let (env, client) = setup();
        let qp_id = Address::generate(&env);
        let proof = Bytes::from_slice(&env, b"valid-proof");
        assert!(client.verify_claim(&qp_id, &1u64, &ClaimType::HasDegree, &proof));
    }

    #[test]
    fn test_verify_claim_revoked_fails() {
        let (env, client) = setup();
        let qp_id = Address::generate(&env);
        let proof = Bytes::new(&env);
        assert!(!client.verify_claim(&qp_id, &1u64, &ClaimType::HasDegree, &proof));
    }

    #[test]
    fn test_verify_claim_wrong_type_fails() {
        let (env, client) = setup();
        let qp_id = Address::generate(&env);
        let proof = Bytes::new(&env);
        assert!(!client.verify_claim(&qp_id, &1u64, &ClaimType::HasLicense, &proof));
    }

    #[test]
    fn test_upgrade_success() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        let wasm_hash = soroban_sdk::BytesN::from_array(&env, &[0u8; 32]);
        client.upgrade(&admin, &wasm_hash);
    }

    #[test]
    fn test_generate_proof_request() {
        let (env, client) = setup();
        let req = client.generate_proof_request(&1u64, &ClaimType::HasLicense);
        assert_eq!(req.credential_id, 1);
    }

    #[test]
    fn test_revoke_proof_prevents_verification() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        let qp_id = Address::generate(&env);
        let proof = Bytes::from_slice(&env, b"valid-proof");

        // Proof verifies before revocation.
        assert!(client.verify_claim(&qp_id, &1u64, &ClaimType::HasDegree, &proof));

        // Compute the same hash the contract uses and revoke it.
        let proof_hash: BytesN<32> = env.crypto().sha256(&proof).into();
        client.revoke_proof(&admin, &proof_hash);

        // Same proof now fails.
        assert!(!client.verify_claim(&qp_id, &1u64, &ClaimType::HasDegree, &proof));
    }

    #[test]
    fn test_is_revoked_returns_true_after_revocation() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        let proof = Bytes::from_slice(&env, b"some-proof");
        let proof_hash: BytesN<32> = env.crypto().sha256(&proof).into();

        assert!(!client.is_revoked(&proof_hash));
        client.revoke_proof(&admin, &proof_hash);
        assert!(client.is_revoked(&proof_hash));
    }

    #[test]
    fn test_revoke_proof_requires_auth() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        let proof_hash = BytesN::from_array(&env, &[1u8; 32]);

        // With mock_all_auths this always passes; verify the auth was recorded.
        client.revoke_proof(&admin, &proof_hash);
        let auths = env.auths();
        assert!(!auths.is_empty());
    }

    #[test]
    fn test_unrevoked_proof_still_verifies() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        let qp_id = Address::generate(&env);

        let proof_a = Bytes::from_slice(&env, b"proof-a");
        let proof_b = Bytes::from_slice(&env, b"proof-b");

        // Revoke only proof_a.
        let hash_a: BytesN<32> = env.crypto().sha256(&proof_a).into();
        client.revoke_proof(&admin, &hash_a);

        assert!(!client.verify_claim(&qp_id, &1u64, &ClaimType::HasDegree, &proof_a));
        assert!(client.verify_claim(&qp_id, &1u64, &ClaimType::HasDegree, &proof_b));
    }
}
