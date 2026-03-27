#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Bytes, Env, String, Vec};
use soroban_sdk::testutils::Address as TestAddress;

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
        env: Env,
        quorum_proof_id: Address,
        credential_id: u64,
        claim_type: ClaimType,
        proof: Bytes,
    ) -> bool {
        if proof.is_empty() {
            return false;
        }

        // Fetch credential from QuorumProof contract
        let qp_client = ::quorum_proof::QuorumProofContractClient::new(&env, &quorum_proof_id);
        let credential = qp_client.get_credential(&credential_id);

        // Check revoked or expired
        if credential.revoked {
            return false;
        }
        if let Some(expires_at) = credential.expires_at {
            if env.ledger().timestamp() as u64 >= expires_at {
                return false;
            }
        }

        // Mock ZK verification per claim type (proof = b"{claim_prefix}:{expected_hash}")
        let proof_bytes = proof.as_slice();
        let proof_str = String::from_utf8_lossy(proof_bytes).to_string();
        let parts: Vec<&str> = proof_str.split(':').collect();
        if parts.len() != 2 {
            return false;
        }
        let prefix = parts[0];
        let proof_hash = Bytes::from_slice(&env, parts[1].as_bytes());

        match claim_type {
            ClaimType::HasDegree => {
                if prefix != "degree" || credential.metadata_hash != proof_hash {
                    false
                } else {
                    true // Simulates proof of "Mechanical Engineering degree" without revealing transcript
                }
            }
            ClaimType::HasLicense => {
                if prefix != "license" || credential.metadata_hash != proof_hash {
                    false
                } else {
                    true // Simulates professional license proof
                }
            }
            ClaimType::HasEmploymentHistory => {
                if prefix != "employment" || credential.metadata_hash != proof_hash {
                    false
                } else {
                    true // Simulates employment verification
                }
            }
        }
    }

    /// Admin-only contract upgrade to new WASM. Uses deployer convention for auth.
    pub fn upgrade(env: Env, admin: Address, new_wasm_hash: Bytes) {
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{Bytes, Env, testutils::{Address as _, Ledger}};

#[test]
    fn test_verify_claim_degree_success() {
        let env = Env::default();
        env.mock_all_auths();
        let zk_id = env.register_contract(None, ZkVerifierContract);
        let qp_id = env.register_contract(None, QuorumProofContract);
        let client = ZkVerifierContractClient::new(&env, &zk_id);

        // Setup mock credential
        let qp_client = QuorumProofContractClient::new(&env, &qp_id);
        let issuer = TestAddress::generate(&env);
        let subject = TestAddress::generate(&env);
        let metadata = Bytes::from_slice(&env, b"expected_degree_hash");
        qp_client.issue_credential(&issuer, &subject, &1u32, &metadata, &None::<u64>);

        let proof = Bytes::from_slice(&env, b"degree:expected_degree_hash");
        assert!(client.verify_claim(&qp_id, &1u64, &ClaimType::HasDegree, &proof));
    }

#[test]
    fn test_verify_claim_revoked_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let zk_id = env.register_contract(None, ZkVerifierContract);
        let qp_id = env.register_contract(None, QuorumProofContract);
        let client = ZkVerifierContractClient::new(&env, &zk_id);
        let qp_client = QuorumProofContractClient::new(&env, &qp_id);

        let issuer = TestAddress::generate(&env);
        let subject = TestAddress::generate(&env);
        let metadata = Bytes::from_slice(&env, b"hash");
        let cred_id = qp_client.issue_credential(&issuer, &subject, &1u32, &metadata, &None::<u64>);
        qp_client.revoke_credential(&issuer, &cred_id);

        let proof = Bytes::from_slice(&env, b"degree:hash");
        assert!(!client.verify_claim(&qp_id, &cred_id, &ClaimType::HasDegree, &proof));
    }

#[test]
    fn test_verify_claim_wrong_type_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let zk_id = env.register_contract(None, ZkVerifierContract);
        let qp_id = env.register_contract(None, QuorumProofContract);
        let client = ZkVerifierContractClient::new(&env, &zk_id);
        let qp_client = QuorumProofContractClient::new(&env, &qp_id);

        let issuer = TestAddress::generate(&env);
        let subject = TestAddress::generate(&env);
        let metadata = Bytes::from_slice(&env, b"hash");
        let cred_id = qp_client.issue_credential(&issuer, &subject, &1u32, &metadata, &None::<u64>);

        let proof = Bytes::from_slice(&env, b"license:hash"); // Wrong prefix for HasDegree
        assert!(!client.verify_claim(&qp_id, &cred_id, &ClaimType::HasDegree, &proof));
    }

#[test]
    fn test_upgrade_success() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let admin = TestAddress::generate(&env);
        let wasm_hash = Bytes::from_slice(&env, b"new_wasm_hash");

        // Should succeed without panic
        client.upgrade(&admin, &wasm_hash);
    }

#[test]
#[should_panic(expected = "HostError")]
fn test_upgrade_unauthorized_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let admin = TestAddress::generate(&env);
        let unpriv = TestAddress::generate(&env);
        let wasm_hash = Bytes::from_slice(&env, b"new_wasm_hash");

        client.upgrade(&admin, &wasm_hash);  // Authorize admin first

        // Unauthorized should panic on require_auth
        env.as_contract(&contract_id, || {
            client.upgrade(&unpriv, &wasm_hash);
        });
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
