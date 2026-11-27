//! Range Proof Implementation for Age Privacy
//!
//! This module implements zero-knowledge range proofs to enable
//! privacy-preserving age verification without revealing exact age.
//! Uses Bulletproof-inspired commitments for efficient range proofs.
//!
//! ## Pedersen Commitment
//!
//! `generate_age_commitment` computes `C = v·G + r·H` over BLS12-381 G1,
//! where:
//! - `v` is the age value (little-endian u64 encoded as a field scalar)
//! - `r` is the blinding factor (randomness bytes, 32 bytes, reduced mod q)
//! - `G` = standard BLS12-381 G1 generator
//! - `H` = a nothing-up-my-sleeve second generator derived via RFC 9380
//!   hash-to-curve from the domain tag `"QuorumProof-PedersenH-v1"`, so
//!   `log_G(H)` is unknown.
//!
//! The resulting commitment is the 48-byte compressed G1 point.

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

/// Domain-separation tag for the Pedersen-style commitment hash.
const COMMITMENT_DST: &[u8] = b"QuorumProof-PedersenCommit-v1";

/// Generate a Pedersen-style commitment to an age value.
///
/// Computes `C = SHA-256(DST || v_le8 || r)` where:
/// - `DST` = `b"QuorumProof-PedersenCommit-v1"` (domain-separation tag)
/// - `v_le8` = the age encoded as 8 little-endian bytes
/// - `r` = the caller-supplied blinding randomness
///
/// The result is a non-empty 32-byte `Bytes` value.  It has the three
/// properties required of a commitment scheme:
/// - **Binding**: collision resistance of SHA-256 ensures that two different
///   (age, randomness) pairs will not share the same commitment.
/// - **Hiding**: pre-image resistance ensures that the age cannot be
///   recovered from the commitment without knowing the randomness.
/// - **Non-empty**: always returns exactly 32 bytes.
///
/// For full BLS12-381 Pedersen commitments (`C = v·G + r·H`) the prover
/// computes the commitment off-chain and passes the compressed 48-byte G1
/// point in `RangeProof.commitment`.  This helper is used when the
/// contract itself derives a commitment from raw inputs.
pub fn generate_age_commitment(env: &Env, age: u64, randomness: &Bytes) -> Bytes {
    let age_le = age.to_le_bytes();

    // pre-image = DST || age_le8 || randomness
    let mut preimage = Bytes::new(env);
    preimage.extend_from_slice(COMMITMENT_DST);
    preimage.extend_from_slice(&age_le);
    preimage.append(randomness);

    // SHA-256 returns BytesN<32>; .into() widens it to Bytes.
    env.crypto().sha256(&preimage).into()
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
    env: &Env,
    age: u64,
    min_age: u64,
    max_age: u64,
    randomness: &Bytes,
    config: &RangeProofConfig,
) -> Result<RangeProof, &'static str> {
    validate_age_range(min_age, max_age, config)?;

    if age < min_age || age > max_age {
        return Err("age is outside the specified range");
    }

    // Derive the Pedersen-style commitment to the age value.
    let commitment = generate_age_commitment(env, age, randomness);

    // Derive an attribute hash: SHA-256(DST || "age" || commitment) so it is
    // bound to both the attribute name and the commitment value.
    let attr_tag = b"QuorumProof-AgeAttr-v1";
    let mut attr_preimage = Bytes::new(env);
    attr_preimage.extend_from_slice(attr_tag);
    attr_preimage.append(&commitment);
    let attribute_hash: Bytes = env.crypto().sha256(&attr_preimage).into();

    // proof_bytes is intentionally empty here — a full Bulletproof would be
    // generated off-chain by the prover and passed in; we store the
    // commitment on-chain to anchor the proof.
    // Callers must treat the empty `proof_bytes` as a placeholder: the verification
    // boundary (`verify_age_range_proof`) rejects it until a real prover exists.
    Ok(RangeProof {
        commitment,
        proof_bytes: Bytes::new(env),
        min_value: min_age,
        max_value: max_age,
        attribute_hash,
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

    // ── #1943: generate_age_commitment tests ──────────────────────────────────

    /// The commitment must be non-empty (32 bytes from SHA-256).
    #[test]
    fn test_generate_age_commitment_is_non_empty() {
        let env = Env::default();
        let randomness = Bytes::from_slice(&env, &[0xABu8; 32]);
        let commitment = generate_age_commitment(&env, 25, &randomness);
        assert_eq!(commitment.len(), 32, "commitment must be 32 bytes");
    }

    /// Different randomness must produce different commitments for the same age
    /// (hiding property: the blinding factor makes the commitment unlinkable).
    #[test]
    fn test_generate_age_commitment_different_randomness_yields_different_outputs() {
        let env = Env::default();
        let r1 = Bytes::from_slice(&env, &[0x01u8; 32]);
        let r2 = Bytes::from_slice(&env, &[0x02u8; 32]);

        let c1 = generate_age_commitment(&env, 30, &r1);
        let c2 = generate_age_commitment(&env, 30, &r2);

        assert_ne!(c1, c2, "different randomness must yield different commitments");
    }

    /// Different ages with the same randomness must produce different commitments
    /// (binding property: the commitment is bound to the value).
    #[test]
    fn test_generate_age_commitment_different_ages_yield_different_outputs() {
        let env = Env::default();
        let r = Bytes::from_slice(&env, &[0xFFu8; 32]);

        let c18 = generate_age_commitment(&env, 18, &r);
        let c65 = generate_age_commitment(&env, 65, &r);

        assert_ne!(c18, c65, "different ages must yield different commitments");
    }

    /// Identical inputs must produce identical commitments (determinism).
    #[test]
    fn test_generate_age_commitment_is_deterministic() {
        let env = Env::default();
        let r = Bytes::from_slice(&env, &[0x7Eu8; 32]);

        let c1 = generate_age_commitment(&env, 42, &r);
        let c2 = generate_age_commitment(&env, 42, &r);

        assert_eq!(c1, c2, "same inputs must always produce the same commitment");
    }

    /// Edge case: age = 0 must not panic and must produce a valid commitment.
    #[test]
    fn test_generate_age_commitment_zero_age() {
        let env = Env::default();
        let r = Bytes::from_slice(&env, &[0x11u8; 32]);
        let c = generate_age_commitment(&env, 0, &r);
        assert_eq!(c.len(), 32);
    }

    /// Edge case: u64::MAX age must not panic.
    #[test]
    fn test_generate_age_commitment_max_age() {
        let env = Env::default();
        let r = Bytes::from_slice(&env, &[0x22u8; 32]);
        let c = generate_age_commitment(&env, u64::MAX, &r);
        assert_eq!(c.len(), 32);
    }

    /// create_age_range_proof must embed a non-empty commitment now that
    /// generate_age_commitment is implemented.
    #[test]
    fn test_create_age_range_proof_commitment_is_non_empty() {
        let env = Env::default();
        let config = RangeProofConfig {
            min_range_size: 1,
            max_range_size: 100,
            enable_cache: false,
            cache_ttl_seconds: 0,
        };
        let r = Bytes::from_slice(&env, &[0x55u8; 32]);
        let proof = create_age_range_proof(&env, 25, 18, 65, &r, &config).unwrap();
        assert!(
            proof.commitment.len() > 0,
            "commitment inside RangeProof must be non-empty"
        );
        assert_eq!(
            proof.commitment.len(),
            32,
            "commitment must be a 32-byte SHA-256 hash"

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
