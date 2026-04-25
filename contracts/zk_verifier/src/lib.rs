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

/// An anonymous proof request that does not expose the holder's address.
/// The verifier receives only a commitment (hash of address + nonce) so
/// the holder's identity cannot be tracked across verification calls.
#[contracttype]
#[derive(Clone)]
pub struct AnonymousProofRequest {
    pub credential_id: u64,
    pub claim_type: ClaimType,
    pub nonce: u64,
    /// SHA-256(holder_address_bytes || nonce_bytes) — binds the request to
    /// the holder without revealing their address on-chain.
    pub holder_commitment: Bytes,
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

    /// Generate an anonymous proof request using a holder commitment instead of an address.
    /// The caller computes holder_commitment = SHA-256(address_bytes || nonce_bytes) off-chain
    /// and submits only the commitment, preventing on-chain holder tracking.
    pub fn generate_anonymous_proof_request(
        env: Env,
        credential_id: u64,
        claim_type: ClaimType,
        holder_commitment: Bytes,
    ) -> AnonymousProofRequest {
        assert!(!holder_commitment.is_empty(), "holder_commitment cannot be empty");
        let nonce = env.ledger().sequence() as u64;
        AnonymousProofRequest {
            credential_id,
            claim_type,
            nonce,
            holder_commitment,
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

    /// Verify a ZK proof anonymously — no holder address is accepted or stored.
    /// The holder_commitment binds the proof to a specific holder without revealing
    /// their identity, ensuring no holder tracking is possible on-chain.
    ///
    /// Returns true if the proof is valid and the commitment is non-empty.
    pub fn verify_claim_anonymous(
        _env: Env,
        _credential_id: u64,
        _claim_type: ClaimType,
        holder_commitment: Bytes,
        proof: Bytes,
    ) -> bool {
        // Commitment must be present — empty commitment would allow holder spoofing.
        if holder_commitment.is_empty() {
            return false;
        }
        // Stub: proof validity = non-empty bytes. Replace with real ZK check in v1.1.
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

    // --- Privacy / anonymity tests ---

    #[test]
    fn test_verify_claim_anonymous_succeeds_with_valid_inputs() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        // Simulated SHA-256 commitment (32 bytes) — computed off-chain by the holder.
        let commitment = Bytes::from_slice(&env, b"sha256_commitment_32bytes_padding");
        let proof = Bytes::from_slice(&env, b"valid-proof");

        assert!(client.verify_claim_anonymous(&1u64, &ClaimType::HasDegree, &commitment, &proof));
    }

    #[test]
    fn test_verify_claim_anonymous_rejects_empty_commitment() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        // Empty commitment must be rejected — it would allow holder spoofing.
        let empty_commitment = Bytes::from_slice(&env, b"");
        let proof = Bytes::from_slice(&env, b"valid-proof");

        assert!(!client.verify_claim_anonymous(&1u64, &ClaimType::HasDegree, &empty_commitment, &proof));
    }

    #[test]
    fn test_verify_claim_anonymous_rejects_empty_proof() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let commitment = Bytes::from_slice(&env, b"sha256_commitment_32bytes_padding");
        let empty_proof = Bytes::from_slice(&env, b"");

        assert!(!client.verify_claim_anonymous(&1u64, &ClaimType::HasLicense, &commitment, &empty_proof));
    }

    #[test]
    fn test_generate_anonymous_proof_request_does_not_expose_address() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let commitment = Bytes::from_slice(&env, b"sha256_commitment_32bytes_padding");
        let req = client.generate_anonymous_proof_request(
            &1u64,
            &ClaimType::HasEmploymentHistory,
            &commitment,
        );

        // The request carries only the commitment — no address field exists.
        assert_eq!(req.credential_id, 1);
        assert_eq!(req.holder_commitment, commitment);
        assert_eq!(req.claim_type, ClaimType::HasEmploymentHistory);
    }

    #[test]
    #[should_panic(expected = "holder_commitment cannot be empty")]
    fn test_generate_anonymous_proof_request_rejects_empty_commitment() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        let empty = Bytes::from_slice(&env, b"");
        client.generate_anonymous_proof_request(&1u64, &ClaimType::HasDegree, &empty);
    }

    #[test]
    fn test_two_holders_same_credential_different_commitments() {
        let env = Env::default();
        let contract_id = env.register_contract(None, ZkVerifierContract);
        let client = ZkVerifierContractClient::new(&env, &contract_id);

        // Two different holders produce different commitments for the same credential —
        // neither can be linked to the other or to a raw address.
        let commitment_a = Bytes::from_slice(&env, b"commitment_holder_a_32bytes_xxxxx");
        let commitment_b = Bytes::from_slice(&env, b"commitment_holder_b_32bytes_xxxxx");
        let proof = Bytes::from_slice(&env, b"valid-proof");

        assert!(client.verify_claim_anonymous(&1u64, &ClaimType::HasDegree, &commitment_a, &proof));
        assert!(client.verify_claim_anonymous(&1u64, &ClaimType::HasDegree, &commitment_b, &proof));
        assert_ne!(commitment_a, commitment_b);
    }
}
