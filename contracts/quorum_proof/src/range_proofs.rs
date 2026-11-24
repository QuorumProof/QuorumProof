//! Range Proof Implementation for Age Privacy
//!
//! This module implements zero-knowledge range proofs to enable
//! privacy-preserving age verification without revealing exact age.
//! Uses Bulletproof-inspired commitments for efficient range proofs.

use soroban_sdk::{contracttype, Bytes, Env, Vec};

/// Represents a zero-knowledge range proof for a credential attribute.
/// Proves that a value lies within a specified range without revealing the exact value.
#[contracttype]
#[derive(Clone)]
pub struct RangeProof {
    /// The commitment to the value being proven (e.g., Pedersen commitment)
    pub commitment: Bytes,
    /// The proof bytes (aggregated Bulletproof-style proof)
    pub proof_bytes: Bytes,
    /// Minimum value of the range (inclusive)
    pub min_value: u64,
    /// Maximum value of the range (inclusive)
    pub max_value: u64,
    /// Hash of the attribute being proven (e.g., "age")
    pub attribute_hash: Bytes,
}

/// Configuration for range proof verification
#[contracttype]
#[derive(Clone)]
pub struct RangeProofConfig {
    /// Minimum allowed range size (prevents trivial proofs)
    pub min_range_size: u64,
    /// Maximum allowed range size
    pub max_range_size: u64,
    /// Whether to cache verification results
    pub enable_cache: bool,
    /// Time-to-live for cached verification results (in ledger seconds)
    pub cache_ttl_seconds: u32,
}

/// Cache entry for a verified range proof
#[contracttype]
#[derive(Clone)]
pub struct RangeProofCacheEntry {
    /// The range proof that was verified
    pub proof: RangeProof,
    /// Result of verification (true = valid, false = invalid)
    pub is_valid: bool,
    /// Ledger timestamp when this entry was cached
    pub cached_at: u64,
}

/// Represents an age-range verification request
#[contracttype]
#[derive(Clone)]
pub struct AgeRangeVerificationRequest {
    /// Credential ID being verified
    pub credential_id: u64,
    /// Minimum age (inclusive)
    pub min_age: u64,
    /// Maximum age (inclusive)
    pub max_age: u64,
    /// The range proof from the holder
    pub proof: RangeProof,
}

/// Helper function to validate age range parameters
pub fn validate_age_range(min_age: u64, max_age: u64, config: &RangeProofConfig) -> Result<(), &'static str> {
    if min_age > max_age {
        return Err("min_age must be less than or equal to max_age");
    }

    let range_size = max_age.saturating_sub(min_age);
    if range_size < config.min_range_size {
        return Err("range is too small");
    }
    if range_size > config.max_range_size {
        return Err("range is too large");
    }

    Ok(())
}

/// Generate a commitment to an age value
/// In a real implementation, this would use cryptographic commitments (Pedersen)
/// For now, this is a placeholder that demonstrates the structure
pub fn generate_age_commitment(_env: &Env, _age: u64, _randomness: &Bytes) -> Bytes {
    // This would be implemented with actual Pedersen commitment logic
    // C = g^v · h^r (where v is age, r is randomness)
    Bytes::new(_env)
}

/// Create a range proof for an age attribute.
///
/// Gated behind `#[cfg(test)]`: this helper does not yet generate real
/// Bulletproof bytes, so the returned `RangeProof` carries *empty*
/// `commitment`, `proof_bytes` and `attribute_hash` fields.  A proof that is
/// structurally valid but carries no cryptographic material would be
/// indistinguishable from a real one to callers, so the helper is kept
/// test-only until a real prover exists.  The verification boundary
/// ([`verify_age_range_proof`]) rejects any proof whose `proof_bytes`
/// (or commitment/attribute hash) is empty, so a placeholder proof can never
/// be accepted.
#[cfg(test)]
pub fn create_age_range_proof(
    _env: &Env,
    age: u64,
    min_age: u64,
    max_age: u64,
    _randomness: &Bytes,
    config: &RangeProofConfig,
) -> Result<RangeProof, &'static str> {
    validate_age_range(min_age, max_age, config)?;

    if age < min_age || age > max_age {
        return Err("age is outside the specified range");
    }

    // In production, this would use actual Bulletproof generation.
    // For now, we structure the proof correctly; the empty cryptographic fields
    // are rejected by `verify_age_range_proof` at the boundary.
    Ok(RangeProof {
        commitment: Bytes::new(_env),
        proof_bytes: Bytes::new(_env),
        min_value: min_age,
        max_value: max_age,
        attribute_hash: Bytes::new(_env),
    })
}

/// Verify a range proof without revealing the actual age
/// Returns true if proof is valid, false otherwise
pub fn verify_age_range_proof(
    _env: &Env,
    proof: &RangeProof,
    config: &RangeProofConfig,
) -> Result<bool, &'static str> {
    // Validate range parameters
    validate_age_range(proof.min_value, proof.max_value, config)?;

    // In a real implementation, this would:
    // 1. Check that commitment is a valid elliptic curve point
    // 2. Verify the Bulletproof using the commitment
    // 3. Ensure the proof covers the entire range [min_value, max_value]

    // Structural validation at the verification boundary: a proof that carries
    // no cryptographic material must never be accepted.  This rejects the
    // placeholder proofs produced by the test-only `create_age_range_proof`
    // (whose commitment, proof_bytes and attribute_hash are all empty), so a
    // structurally valid-looking RangeProof that carries no proof can never
    // slip through.
    if proof.commitment.len() == 0 {
        return Err("invalid commitment");
    }
    if proof.proof_bytes.len() == 0 {
        return Err("invalid proof bytes");
    }
    if proof.attribute_hash.len() == 0 {
        return Err("invalid attribute hash");
    }

    Ok(true)
}

/// Check if a value falls within a range without revealing the value
pub fn check_value_in_range(
    proof: &RangeProof,
    test_value: u64,
) -> bool {
    test_value >= proof.min_value && test_value <= proof.max_value
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::Env;

    #[test]
    fn test_validate_age_range() {
        let config = RangeProofConfig {
            min_range_size: 1,
            max_range_size: 100,
            enable_cache: true,
            cache_ttl_seconds: 3600,
        };

        // Valid ranges
        assert!(validate_age_range(18, 65, &config).is_ok());
        assert!(validate_age_range(21, 30, &config).is_ok());
        assert!(validate_age_range(0, 100, &config).is_ok());

        // Invalid: min > max
        assert!(validate_age_range(65, 18, &config).is_err());

        // Range too large
        let config_small = RangeProofConfig {
            min_range_size: 1,
            max_range_size: 10,
            enable_cache: true,
            cache_ttl_seconds: 3600,
        };
        assert!(validate_age_range(0, 100, &config_small).is_err());
    }

    #[test]
    fn test_check_value_in_range() {
        let proof = RangeProof {
            commitment: Bytes::new(&Env::default()),
            proof_bytes: Bytes::new(&Env::default()),
            min_value: 18,
            max_value: 65,
            attribute_hash: Bytes::new(&Env::default()),
        };

        assert!(check_value_in_range(&proof, 18));
        assert!(check_value_in_range(&proof, 40));
        assert!(check_value_in_range(&proof, 65));
        assert!(!check_value_in_range(&proof, 17));
        assert!(!check_value_in_range(&proof, 66));
    }

    fn proof_config() -> RangeProofConfig {
        RangeProofConfig {
            min_range_size: 1,
            max_range_size: 100,
            enable_cache: true,
            cache_ttl_seconds: 3600,
        }
    }

    // Issue #1944: `create_age_range_proof` must not be able to mint proofs that
    // look structurally valid but carry no proof. The helper is test-only and
    // the verification boundary rejects empty cryptographic fields.
    #[test]
    fn test_verify_age_range_proof_rejects_empty_proof_bytes() {
        let env = Env::default();
        let config = proof_config();

        // A fully empty proof is rejected (empty commitment).
        let empty_proof = RangeProof {
            commitment: Bytes::new(&env),
            proof_bytes: Bytes::new(&env),
            min_value: 18,
            max_value: 65,
            attribute_hash: Bytes::new(&env),
        };
        assert!(verify_age_range_proof(&env, &empty_proof, &config).is_err());

        // Non-empty commitment but empty proof_bytes: still rejected at the
        // boundary because the proof carries no actual proof bytes.
        let no_proof_bytes = RangeProof {
            commitment: Bytes::from_slice(&env, b"commitment"),
            proof_bytes: Bytes::new(&env),
            min_value: 18,
            max_value: 65,
            attribute_hash: Bytes::from_slice(&env, b"age"),
        };
        let res = verify_age_range_proof(&env, &no_proof_bytes, &config);
        assert!(
            res.is_err(),
            "empty proof_bytes must be rejected at the verification boundary"
        );

        // Non-empty commitment and proof_bytes but empty attribute_hash: rejected.
        let no_attribute_hash = RangeProof {
            commitment: Bytes::from_slice(&env, b"commitment"),
            proof_bytes: Bytes::from_slice(&env, b"proof"),
            min_value: 18,
            max_value: 65,
            attribute_hash: Bytes::new(&env),
        };
        assert!(verify_age_range_proof(&env, &no_attribute_hash, &config).is_err());
    }

    // Issue #1944: `create_age_range_proof` is gated behind #[cfg(test)] and only
    // produces placeholder (empty) proof bytes, which the boundary rejects.
    #[test]
    fn test_create_age_range_proof_is_test_only_and_unverifiable() {
        let env = Env::default();
        let config = proof_config();
        let randomness = Bytes::new(&env);

        // Out-of-range age is rejected before any proof is produced.
        assert!(create_age_range_proof(&env, 200, 18, 65, &randomness, &config).is_err());

        // In-range age produces a structurally valid RangeProof whose proof bytes
        // are empty, so verification must reject it.
        let proof = create_age_range_proof(&env, 40, 18, 65, &randomness, &config).unwrap();
        assert_eq!(proof.min_value, 18);
        assert_eq!(proof.max_value, 65);
        assert_eq!(proof.proof_bytes.len(), 0);
        assert!(
            verify_age_range_proof(&env, &proof, &config).is_err(),
            "placeholder (empty) proof must be rejected at the boundary"
        );
    }
}
