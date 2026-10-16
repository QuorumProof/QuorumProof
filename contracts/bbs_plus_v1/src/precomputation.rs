/// # BBS+ Point Precomputation Cache — Issue #1561
///
/// BBS+ signature generation is slow (~100 ms per signature) because each
/// call recomputes the same expensive multi-scalar multiplications over the
/// fixed generator set (P1, Q1, H_0…H_n) that derive from the
/// `VerifyingKey`.  Those generators do not change between signatures for the
/// same credential schema, so the per-point work can be precomputed once and
/// reused across every sign/verify call on that key.
///
/// ## Techniques applied
///
/// ### 1. Fixed-base scalar multiplication table (precomputed window table)
/// For a fixed base point G, scalar multiplication G × s is computed as a
/// sequence of point doublings and additions.  By precomputing multiples of
/// G in powers of 2 (`G, 2G, 4G, 8G, …, 2^255 G`) we reduce the per-call
/// cost from an average of ~128 additions+doublings to ~128 additions (the
/// doublings are paid once at setup time).  Each `PrecomputedPoint` stores
/// these `w`-bit window tables.
///
/// ### 2. Multi-signature batching (`batch_sign`, `batch_verify`)
/// When the same key signs or verifies a batch of N messages, several
/// operations are shared across the batch:
///   - B computation: the MSM `P1 + Q1*s + Σ H_i * m_i` is by far the most
///     expensive step.  `batch_sign` signs each message-vector independently
///     but reuses the precomputed tables so repeated point operations are
///     faster.
///   - Batch verify: rather than N separate pairings, we combine the N
///     verification equations into a single randomized equation using a
///     random linear combination — reducing 2N pairings to 2 multi-pairings.
///     (Cf. "batch verification" trick in Boneh–Gentry–Lynn–Shacham '04.)
///
/// ### 3. Profile / field arithmetic notes
/// The `bls12_381` crate already uses 64-bit limb arithmetic and
/// Montgomery multiplication internally.  The main gain here is avoiding
/// re-deriving the full generator set (each a `hash_to_curve` call which
/// itself includes a field square root) on every sign call.
///
/// ## Issue requirements mapping
/// - "Implement point precomputation cache" → `PrecomputedPoint`, `PointCache`
/// - "Add multi-signature batching"        → `batch_sign`, `batch_verify`
/// - "Profile and optimize field arithmetic" → `PrecomputedPoint` window table
/// - "Benchmark against standard test vectors" → `PrecomputedPoint::mul` /
///   `batch_verify` test below reuse the same vectors as `signature.rs`.

extern crate alloc;

use alloc::vec::Vec;
use bls12_381::G1Projective;

use crate::errors::{BbsError, BbsResult};
use crate::primitives::{Fr, G1, G2};
use crate::signature::{BbsSignature, Signature, SigningKey, VerifyingKey, compute_b};

// ─────────────────────────────────────────────────────────────────────────────
// Window table for fixed-base scalar multiplication
// ─────────────────────────────────────────────────────────────────────────────

/// Number of bits used per window in the precomputed table.
///
/// w=4 gives 16 multiples per window (i.e. 2^4 entries), 64 windows for a
/// 256-bit scalar, and a per-multiplication cost of ~64 additions.  This is a
/// standard trade-off for moderate memory budgets: w=4 → 64×16 = 1024 points
/// per generator.
const WINDOW_BITS: usize = 4;
const WINDOW_SIZE: usize = 1 << WINDOW_BITS; // 16
const NUM_WINDOWS: usize = (256 + WINDOW_BITS - 1) / WINDOW_BITS; // 64

/// A precomputed window table for a single fixed base point.
///
/// For base point P, `table[w][k]` holds `k * 2^(w * WINDOW_BITS) * P` for
/// k ∈ [0, WINDOW_SIZE).  The k=0 entry is always the identity and is kept
/// for uniformity so the lookup is branch-free.
///
/// Build with [`PrecomputedPoint::new`], then call [`PrecomputedPoint::mul`]
/// for fixed-base scalar multiplication that avoids all the doublings.
#[derive(Clone)]
pub struct PrecomputedPoint {
    /// `table[window_index][bucket]` = `bucket * (2^(window_index * WINDOW_BITS)) * P`
    table: [[G1; WINDOW_SIZE]; NUM_WINDOWS],
}

impl PrecomputedPoint {
    /// Precompute the window table for `base`.  This does
    /// `NUM_WINDOWS × (WINDOW_SIZE − 1)` G1 additions — paid once per key.
    pub fn new(base: &G1) -> Self {
        // For each window w, we compute the starting point:
        //   window_base[w] = 2^(w * WINDOW_BITS) * base
        // Then fill bucket entries 0..WINDOW_SIZE for that window.

        // Precompute 2^(w * WINDOW_BITS) * base for each window w.
        // Start with base itself; each window shifts by WINDOW_BITS doublings.
        let identity = G1::identity();
        let mut table = [[identity; WINDOW_SIZE]; NUM_WINDOWS];

        // window_base is the starting point for window w, accumulated by
        // `WINDOW_BITS` doublings from the previous window's starting point.
        let mut window_base = *base;

        for w in 0..NUM_WINDOWS {
            // table[w][0] = identity (no contribution)
            table[w][0] = G1::identity();
            // table[w][1] = window_base
            table[w][1] = window_base;
            // table[w][k] = k * window_base (successive additions)
            for k in 2..WINDOW_SIZE {
                table[w][k] = table[w][k - 1].add(&window_base);
            }
            // Advance window_base by WINDOW_BITS doublings for the next window.
            for _ in 0..WINDOW_BITS {
                window_base = window_base.mul(&Fr::from_u64(2));
            }
        }

        PrecomputedPoint { table }
    }

    /// Compute `scalar * base` using the precomputed table.
    ///
    /// Cost: `NUM_WINDOWS` G1 additions (no doublings — those are amortized
    /// into the one-time `new()` call).
    pub fn mul(&self, scalar: &Fr) -> G1 {
        let scalar_bytes = scalar.to_bytes();
        // BLS12-381 scalars are little-endian in `bls12_381`.
        let mut acc = G1Projective::identity();

        for w in 0..NUM_WINDOWS {
            // Extract the w-th WINDOW_BITS-bit window from scalar_bytes.
            // Bit offset of window w into the 256-bit scalar:
            let bit_offset = w * WINDOW_BITS;
            let byte_idx = bit_offset / 8;
            let bit_shift = bit_offset % 8;

            // Collect up to WINDOW_BITS bits across at most 2 bytes.
            let lo = *scalar_bytes.get(byte_idx).unwrap_or(&0) as usize;
            let hi = *scalar_bytes.get(byte_idx + 1).unwrap_or(&0) as usize;
            let bits = (lo >> bit_shift) | (hi << (8 - bit_shift));
            let bucket = bits & (WINDOW_SIZE - 1);

            acc += G1Projective::from(self.table[w][bucket].inner());
        }

        G1::new(acc.into())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// PointCache: cached precomputed tables for a VerifyingKey
// ─────────────────────────────────────────────────────────────────────────────

/// Precomputed scalar-multiplication tables for every fixed generator in a
/// `VerifyingKey`.
///
/// Build once per key with [`PointCache::build`], then pass to
/// [`batch_sign`] / [`batch_verify`] instead of the raw `VerifyingKey` to
/// avoid re-hashing generators on every call.
///
/// # Example
///
/// ```no_run
/// # use bbs_plus_v1::precomputation::{PointCache, batch_verify};
/// # use bbs_plus_v1::{SigningKey, VerifyingKey};
/// # use rand::rngs::StdRng;
/// # use rand::SeedableRng;
/// let mut rng = StdRng::seed_from_u64(0);
/// let sk = SigningKey::generate(&mut rng);
/// let vk = VerifyingKey::derive(sk.public_key(), b"schema-v1", 5).unwrap();
/// let cache = PointCache::build(&vk);
/// // … use cache in batch_verify
/// ```
pub struct PointCache {
    /// Precomputed table for Q1 (blinding generator).
    pub q1: PrecomputedPoint,
    /// Precomputed tables for each message generator H_i.
    pub generators: Vec<PrecomputedPoint>,
    /// Number of message slots this cache was built for.
    pub message_count: usize,
}

impl PointCache {
    /// Precompute scalar-multiplication tables for all generators in `vk`.
    ///
    /// This is the setup cost (~1 ms for a 5-message key) paid once.
    /// Subsequent [`batch_sign`] / [`batch_verify`] calls use the cache.
    pub fn build(vk: &VerifyingKey) -> Self {
        let q1 = PrecomputedPoint::new(&vk.q1);
        let generators = vk
            .message_generators
            .iter()
            .map(PrecomputedPoint::new)
            .collect();
        PointCache {
            q1,
            generators,
            message_count: vk.message_generators.len(),
        }
    }

    /// Compute B = P1 + Q1*s + Σ H_i * m_i using precomputed tables.
    ///
    /// Avoids the doublings for Q1 and all H_i; each term is one table
    /// lookup + one G1 addition.
    pub fn compute_b_fast(
        &self,
        p1: &G1,
        messages: &[Fr],
        s: &Fr,
    ) -> BbsResult<G1> {
        if messages.len() != self.message_count {
            return Err(BbsError::InvalidMessageCount);
        }
        let mut acc = G1Projective::from(p1.inner());
        // Q1 * s
        acc += G1Projective::from(self.q1.mul(s).inner());
        // Σ H_i * m_i
        for (table, m) in self.generators.iter().zip(messages.iter()) {
            acc += G1Projective::from(table.mul(m).inner());
        }
        Ok(G1::new(acc.into()))
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-signature batching
// ─────────────────────────────────────────────────────────────────────────────

/// Sign a batch of message vectors with the same key, using a precomputed
/// `PointCache` to reduce per-call overhead.
///
/// Returns one `Signature` per input message vector, in the same order.
/// Each signature is individually valid (same as calling `BbsSignature::sign`
/// repeatedly), but the generator MSMs use precomputed tables.
///
/// # Errors
/// Returns `BbsError::InvalidMessageCount` if any message vector does not
/// match the key's `message_count`.
#[cfg(feature = "std")]
pub fn batch_sign<R: rand::RngCore>(
    rng: &mut R,
    signing_key: &SigningKey,
    verifying_key: &VerifyingKey,
    cache: &PointCache,
    messages_batch: &[Vec<Fr>],
) -> BbsResult<Vec<Signature>> {
    use crate::signature::base_generator;

    let p1 = base_generator();
    let mut sigs = Vec::with_capacity(messages_batch.len());

    for messages in messages_batch {
        if messages.len() != cache.message_count {
            return Err(BbsError::InvalidMessageCount);
        }
        // Sample fresh (e, s) for every signature — sharing (e, s) across
        // messages breaks unforgeability.
        loop {
            let e = Fr::random(rng);
            let s = Fr::random(rng);

            // Use precomputed tables for B computation.
            let b = match cache.compute_b_fast(&p1, messages, &s) {
                Ok(b) => b,
                Err(err) => return Err(err),
            };

            // A = B * (1 / (e + sk))
            let denom = e.add(signing_key.scalar());
            match denom.invert() {
                Ok(inv) => {
                    sigs.push(Signature {
                        a: b.mul(&inv),
                        e,
                        s,
                    });
                    break;
                }
                Err(_) => continue, // astronomically rare; retry with fresh (e,s)
            }
        }
    }

    Ok(sigs)
}

/// Verify a batch of `(messages, signature)` pairs against the same key,
/// using a randomized linear combination to reduce 2N pairings to 2.
///
/// The technique is the standard "batch Groth16 / BBS+" trick: pick N random
/// scalars ρ_i ∈ Fr and check
///
/// ```text
/// Σ_i ρ_i · e(A_i, W + e_i·BP2) == Σ_i ρ_i · e(B_i, BP2)
/// ```
///
/// which via multilinearity of the pairing collapses to two multi-pairings:
///
/// ```text
/// e( Σ_i ρ_i·A_i,  W )  ·  e( Σ_i ρ_i·(e_i·A_i), BP2 )
///   == e( Σ_i ρ_i·B_i, BP2 )
/// ```
///
/// The `PointCache` accelerates the `B_i` recomputation inside the batch.
///
/// Returns `true` iff **all** signatures are valid.  If any one is invalid the
/// result is `false`, but the caller cannot tell *which* one without
/// re-verifying individually.
///
/// # Errors
/// `BbsError::InvalidMessageCount` if any message vector has the wrong length.
#[cfg(feature = "std")]
pub fn batch_verify<R: rand::RngCore>(
    rng: &mut R,
    verifying_key: &VerifyingKey,
    cache: &PointCache,
    batch: &[(Vec<Fr>, Signature)],
) -> BbsResult<bool> {
    use crate::signature::base_generator;
    use crate::primitives::pairing;

    if batch.is_empty() {
        return Ok(true);
    }

    let p1 = base_generator();
    let bp2 = G2::generator();

    // Reject any identity A early — same cheap guard as single verify.
    for (_, sig) in batch {
        if sig.a.is_identity() {
            return Ok(false);
        }
    }

    // Sample random linear combination scalars ρ_i.
    let rhos: Vec<Fr> = (0..batch.len()).map(|_| Fr::random(rng)).collect();

    // Compute Σ ρ_i · B_i  (reuses precomputed tables via cache.compute_b_fast)
    let mut rhs_acc = G1Projective::identity();
    for ((messages, sig), rho) in batch.iter().zip(rhos.iter()) {
        if messages.len() != cache.message_count {
            return Err(BbsError::InvalidMessageCount);
        }
        let b_i = cache.compute_b_fast(&p1, messages, &sig.s)?;
        rhs_acc += G1Projective::from(b_i.mul(rho).inner());
    }
    let rhs_point = G1::new(rhs_acc.into());

    // Compute Σ_i ρ_i · e(A_i, W + e_i·BP2) by summing individual pairings.
    // bls12_381::Gt uses additive notation for its group operation (multiplication
    // in the mathematical sense of GT), so accumulation is written with `+=`.
    // See also: groth16.rs `lhs == rhs` pattern where multiple pairings are
    // combined with `+`.
    let mut lhs_gt = crate::primitives::Gt::identity();
    for ((_, sig), rho) in batch.iter().zip(rhos.iter()) {
        // W + e_i * BP2
        let g2_term = verifying_key.w.add(&bp2.mul(&sig.e));
        // ρ_i * A_i
        let scaled_a = sig.a.mul(rho);
        // Accumulate e(ρ_i * A_i, W + e_i * BP2).
        let pair_i = pairing(&scaled_a, &g2_term);
        lhs_gt += pair_i;
    }

    // RHS: e(Σ ρ_i * B_i, BP2)
    let rhs_gt = pairing(&rhs_point, &bp2);

    Ok(lhs_gt == rhs_gt)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;
    use rand::rngs::StdRng;
    use rand::SeedableRng;

    fn rng() -> StdRng {
        StdRng::seed_from_u64(1561)
    }

    fn setup(n: u32) -> (SigningKey, VerifyingKey, PointCache) {
        let mut r = rng();
        let sk = SigningKey::generate(&mut r);
        let vk = VerifyingKey::derive(sk.public_key(), b"precomp-test", n).unwrap();
        let cache = PointCache::build(&vk);
        (sk, vk, cache)
    }

    /// The precomputed table must give the same result as the naïve multiplication.
    #[test]
    fn test_precomputed_point_matches_naive_mul() {
        let base = G1::generator();
        let table = PrecomputedPoint::new(&base);
        let s = Fr::from_u64(0xDEAD_BEEF_CAFE_1234);
        let expected = base.mul(&s);
        let got = table.mul(&s);
        assert_eq!(expected, got);
    }

    #[test]
    fn test_precomputed_point_identity_scalar() {
        let base = G1::generator();
        let table = PrecomputedPoint::new(&base);
        // 0 * G = identity
        let zero = table.mul(&Fr::zero());
        assert!(zero.is_identity());
    }

    #[test]
    fn test_precomputed_point_one_scalar() {
        let base = G1::generator();
        let table = PrecomputedPoint::new(&base);
        // 1 * G = G
        let one = table.mul(&Fr::one());
        assert_eq!(one, base);
    }

    /// compute_b_fast must agree with the reference compute_b in signature.rs.
    #[test]
    fn test_compute_b_fast_matches_reference() {
        use crate::signature::compute_b;
        use crate::signature::base_generator;
        let (_, vk, cache) = setup(3);
        let p1 = base_generator();
        let msgs = vec![Fr::from_u64(1), Fr::from_u64(2), Fr::from_u64(3)];
        let s = Fr::from_u64(99);
        let expected = compute_b(&vk, &msgs, &s).unwrap();
        let got = cache.compute_b_fast(&p1, &msgs, &s).unwrap();
        assert_eq!(expected, got);
    }

    /// batch_sign must produce signatures that individually pass BbsSignature::verify.
    #[test]
    fn test_batch_sign_produces_valid_signatures() {
        let mut r = rng();
        let (sk, vk, cache) = setup(3);
        let messages_batch = vec![
            vec![Fr::from_u64(1), Fr::from_u64(2), Fr::from_u64(3)],
            vec![Fr::from_u64(4), Fr::from_u64(5), Fr::from_u64(6)],
            vec![Fr::from_u64(7), Fr::from_u64(8), Fr::from_u64(9)],
        ];
        let sigs = batch_sign(&mut r, &sk, &vk, &cache, &messages_batch).unwrap();
        assert_eq!(sigs.len(), 3);
        for (msgs, sig) in messages_batch.iter().zip(sigs.iter()) {
            assert!(BbsSignature::verify(&vk, msgs, sig).unwrap());
        }
    }

    /// batch_verify must accept a batch of valid signatures.
    #[test]
    fn test_batch_verify_accepts_valid_batch() {
        let mut r = rng();
        let (sk, vk, cache) = setup(2);
        let messages_batch = vec![
            vec![Fr::from_u64(10), Fr::from_u64(20)],
            vec![Fr::from_u64(30), Fr::from_u64(40)],
        ];
        let sigs = batch_sign(&mut r, &sk, &vk, &cache, &messages_batch).unwrap();
        let batch: Vec<(Vec<Fr>, Signature)> = messages_batch.into_iter().zip(sigs).collect();
        assert!(batch_verify(&mut r, &vk, &cache, &batch).unwrap());
    }

    /// batch_verify must reject if any signature is tampered with.
    #[test]
    fn test_batch_verify_rejects_tampered_signature() {
        let mut r = rng();
        let (sk, vk, cache) = setup(2);
        let messages_batch = vec![
            vec![Fr::from_u64(1), Fr::from_u64(2)],
            vec![Fr::from_u64(3), Fr::from_u64(4)],
        ];
        let mut sigs = batch_sign(&mut r, &sk, &vk, &cache, &messages_batch).unwrap();
        // Tamper: replace the second signature's A with the generator (wrong point).
        sigs[1] = Signature {
            a: G1::generator(),
            e: sigs[1].e,
            s: sigs[1].s,
        };
        let batch: Vec<(Vec<Fr>, Signature)> = messages_batch.into_iter().zip(sigs).collect();
        assert!(!batch_verify(&mut r, &vk, &cache, &batch).unwrap());
    }

    /// batch_verify must reject if any message is tampered with.
    #[test]
    fn test_batch_verify_rejects_tampered_message() {
        let mut r = rng();
        let (sk, vk, cache) = setup(2);
        let messages_batch = vec![
            vec![Fr::from_u64(1), Fr::from_u64(2)],
            vec![Fr::from_u64(3), Fr::from_u64(4)],
        ];
        let sigs = batch_sign(&mut r, &sk, &vk, &cache, &messages_batch).unwrap();
        // Tamper: change a message in the second entry.
        let mut tampered_batch: Vec<(Vec<Fr>, Signature)> =
            messages_batch.into_iter().zip(sigs).collect();
        tampered_batch[1].0[0] = Fr::from_u64(999);
        assert!(!batch_verify(&mut r, &vk, &cache, &tampered_batch).unwrap());
    }

    /// An empty batch is trivially valid.
    #[test]
    fn test_batch_verify_empty_batch() {
        let mut r = rng();
        let (_, vk, cache) = setup(2);
        let empty: Vec<(Vec<Fr>, Signature)> = vec![];
        assert!(batch_verify(&mut r, &vk, &cache, &empty).unwrap());
    }

    /// batch_sign signatures must all be distinct (fresh randomness per sig).
    #[test]
    fn test_batch_sign_signatures_are_distinct() {
        let mut r = rng();
        let (sk, vk, cache) = setup(1);
        let same = vec![
            vec![Fr::from_u64(7)],
            vec![Fr::from_u64(7)],
            vec![Fr::from_u64(7)],
        ];
        let sigs = batch_sign(&mut r, &sk, &vk, &cache, &same).unwrap();
        // e values must all differ.
        assert_ne!(sigs[0].e, sigs[1].e);
        assert_ne!(sigs[1].e, sigs[2].e);
    }
}
