#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Bytes, Env, String};

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

/// Metadata stored alongside a submitted proof.
#[contracttype]
#[derive(Clone)]
pub struct ProofMetadata {
    pub credential_id: u64,
    pub claim_type: ClaimType,
    pub proof_hash: Bytes,
    pub submitted_at: u64,
    pub description: String,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    ProofMetadata(u64, u32), // (credential_id, claim_type_index)
}

fn claim_type_index(claim_type: &ClaimType) -> u32 {
    match claim_type {
        ClaimType::HasDegree => 0,
        ClaimType::HasLicense => 1,
        ClaimType::HasEmploymentHistory => 2,
    }
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

    /// Store metadata alongside a proof submission.
    pub fn store_proof_metadata(
        env: Env,
        credential_id: u64,
        claim_type: ClaimType,
        proof_hash: Bytes,
        description: String,
    ) {
        let key = DataKey::ProofMetadata(credential_id, claim_type_index(&claim_type));
        let metadata = ProofMetadata {
            credential_id,
            claim_type,
            proof_hash,
            submitted_at: env.ledger().timestamp(),
            description,
        };
        env.storage().instance().set(&key, &metadata);
    }

    /// Retrieve stored metadata for a proof. Panics if not found.
    pub fn get_proof_metadata(env: Env, credential_id: u64, claim_type: ClaimType) -> ProofMetadata {
        let key = DataKey::ProofMetadata(credential_id, claim_type_index(&claim_type));
        env.storage()
            .instance()
            .get(&key)
            .expect("proof metadata not found")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{Bytes, Env, String};

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

    #[test]
    fn test_store_and_get_proof_metadata() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let proof_hash = Bytes::from_slice(&env, b"sha256:abc123");
        let description = String::from_str(&env, "Degree proof for MIT 2020");

        client.store_proof_metadata(&1u64, &ClaimType::HasDegree, &proof_hash, &description);

        let meta = client.get_proof_metadata(&1u64, &ClaimType::HasDegree);
        assert_eq!(meta.credential_id, 1);
        assert_eq!(meta.proof_hash, proof_hash);
        assert_eq!(meta.description, description);
        assert_eq!(meta.claim_type, ClaimType::HasDegree);
    }

    #[test]
    fn test_metadata_isolated_per_claim_type() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let hash_degree = Bytes::from_slice(&env, b"hash-degree");
        let hash_license = Bytes::from_slice(&env, b"hash-license");
        let desc_degree = String::from_str(&env, "degree desc");
        let desc_license = String::from_str(&env, "license desc");

        client.store_proof_metadata(&1u64, &ClaimType::HasDegree, &hash_degree, &desc_degree);
        client.store_proof_metadata(&1u64, &ClaimType::HasLicense, &hash_license, &desc_license);

        let meta_d = client.get_proof_metadata(&1u64, &ClaimType::HasDegree);
        let meta_l = client.get_proof_metadata(&1u64, &ClaimType::HasLicense);

        assert_eq!(meta_d.proof_hash, hash_degree);
        assert_eq!(meta_l.proof_hash, hash_license);
    }

    #[test]
    fn test_metadata_isolated_per_credential() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let hash1 = Bytes::from_slice(&env, b"hash-cred-1");
        let hash2 = Bytes::from_slice(&env, b"hash-cred-2");
        let desc = String::from_str(&env, "desc");

        client.store_proof_metadata(&1u64, &ClaimType::HasDegree, &hash1, &desc);
        client.store_proof_metadata(&2u64, &ClaimType::HasDegree, &hash2, &desc);

        assert_eq!(client.get_proof_metadata(&1u64, &ClaimType::HasDegree).proof_hash, hash1);
        assert_eq!(client.get_proof_metadata(&2u64, &ClaimType::HasDegree).proof_hash, hash2);
    }

    #[test]
    #[should_panic(expected = "proof metadata not found")]
    fn test_get_proof_metadata_not_found_panics() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        client.get_proof_metadata(&99u64, &ClaimType::HasLicense);
    }
}
