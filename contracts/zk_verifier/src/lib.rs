#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Bytes, Env};

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

    /// Verify a ZK proof for a claim.
    /// Stub: returns true if proof is non-empty. Replace with real ZK logic in v1.1.
    pub fn verify_claim(
        _env: Env,
        _quorum_proof_id: Address,
        _credential_id: u64,
        _claim_type: ClaimType,
        proof: Bytes,
    ) -> bool {
        !proof.is_empty()
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

    #[test]
    fn test_verify_claim_degree_success() {
        let env = Env::default();
        env.mock_all_auths();
        let zk_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &zk_id);
        let qp_id = Address::generate(&env);

        let proof = Bytes::from_slice(&env, b"valid-proof");
        assert!(client.verify_claim(&qp_id, &1u64, &ClaimType::HasDegree, &proof));
    }

    #[test]
    fn test_verify_claim_revoked_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let zk_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &zk_id);
        let qp_id = Address::generate(&env);

        let proof = Bytes::new(&env);
        assert!(!client.verify_claim(&qp_id, &1u64, &ClaimType::HasDegree, &proof));
    }

    #[test]
    fn test_verify_claim_wrong_type_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let zk_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &zk_id);
        let qp_id = Address::generate(&env);

        let proof = Bytes::new(&env);
        assert!(!client.verify_claim(&qp_id, &1u64, &ClaimType::HasLicense, &proof));
    }

    #[test]
    fn test_upgrade_success() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let wasm_hash = soroban_sdk::BytesN::from_array(&env, &[0u8; 32]);
        client.upgrade(&admin, &wasm_hash);
    }

    #[test]
    fn test_generate_proof_request() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);
        let req = client.generate_proof_request(&42u64, &ClaimType::HasEmploymentHistory);
        assert_eq!(req.credential_id, 42u64);
    }
}
