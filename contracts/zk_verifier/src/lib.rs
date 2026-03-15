#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Bytes, Env};

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
        ProofRequest {
            credential_id,
            claim_type,
            nonce,
        }
    }

    /// Verify a ZK proof for a claim.
    /// Stub: accepts a proof bytes blob and returns true if non-empty.
    /// Replace with real ZK verification logic in v1.1.
    pub fn verify_claim(
        _env: Env,
        _credential_id: u64,
        _claim_type: ClaimType,
        proof: Bytes,
    ) -> bool {
        !proof.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{Bytes, Env};

    #[test]
    fn test_verify_claim_stub() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let proof = Bytes::from_slice(&env, b"mock_proof");
        assert!(client.verify_claim(&1u64, &ClaimType::HasDegree, &proof));

        let empty = Bytes::from_slice(&env, b"");
        assert!(!client.verify_claim(&1u64, &ClaimType::HasDegree, &empty));
    }

    #[test]
    fn test_generate_proof_request() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let req = client.generate_proof_request(&1u64, &ClaimType::HasLicense);
        assert_eq!(req.credential_id, 1);
    }
}
