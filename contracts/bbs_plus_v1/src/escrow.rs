//! Threshold (Shamir) secret sharing for BBS+ issuer key escrow/backup.
//!
//! # Design
//!
//! If an issuer's BBS+ signing key (an `Fr` scalar, see `signature::SigningKey`)
//! is lost, every signature it ever produced becomes unverifiable-in-spirit --
//! the issuer can no longer prove continuity of their key material. This
//! module lets an issuer split that key into `n` shares such that any
//! `t`-of-`n` ("threshold-of-total") shares reconstruct it, following the
//! classical Shamir construction over the same scalar field the rest of this
//! crate already uses for BBS+ arithmetic:
//!
//! ```text
//! f(x) = secret + a_1*x + a_2*x^2 + ... + a_{t-1}*x^{t-1}    (mod r)
//! share_i = (i, f(i))    for i = 1..=n
//! ```
//!
//! Any `t` shares reconstruct `f(0) = secret` via Lagrange interpolation.
//! Fewer than `t` shares reveal nothing about the secret (information-
//! theoretic security), which is the entire point of a *threshold* scheme
//! over simply handing every guardian a plaintext copy.
//!
//! Splitting requires randomness (the polynomial's coefficients), so -- in
//! keeping with this crate's existing convention that real key/blinding
//! material is only ever generated off-chain (see the crate-level `rand`
//! feature note) -- `split_secret` takes the coefficients as an argument
//! rather than sampling them itself, and is usable in `no_std` contexts.
//! Reconstruction needs no randomness at all: only field addition,
//! multiplication, and inversion, all available without `std`.

extern crate alloc;
use alloc::vec::Vec;

use crate::errors::{BbsError, BbsResult};
use crate::primitives::Fr;

/// One share of a Shamir-split secret. `index` is the polynomial evaluation
/// point (always >= 1; index 0 is reserved for the secret itself, `f(0)`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeyShare {
    pub index: u32,
    pub value: Fr,
}

impl KeyShare {
    /// Canonical wire format: big-endian share index followed by the
    /// share's scalar bytes.
    pub fn to_bytes(&self) -> [u8; 36] {
        let mut out = [0u8; 36];
        out[..4].copy_from_slice(&self.index.to_be_bytes());
        out[4..].copy_from_slice(&self.value.to_bytes());
        out
    }

    pub fn from_bytes(bytes: &[u8; 36]) -> BbsResult<Self> {
        let mut index_bytes = [0u8; 4];
        index_bytes.copy_from_slice(&bytes[..4]);
        let index = u32::from_be_bytes(index_bytes);

        let mut value_bytes = [0u8; 32];
        value_bytes.copy_from_slice(&bytes[4..]);
        let value = Fr::from_bytes(&value_bytes)?;

        Ok(KeyShare { index, value })
    }
}

/// Splits `secret` into `total_shares` Shamir shares, any
/// `coefficients.len() + 1` of which reconstruct it.
///
/// `coefficients` are the polynomial's degree-1..degree-(t-1) coefficients
/// (`a_1..a_{t-1}` above), generated off-chain with a CSPRNG -- the caller is
/// responsible for discarding them securely after splitting, since knowing
/// them is equivalent to knowing the secret.
pub fn split_secret(secret: Fr, coefficients: &[Fr], total_shares: u32) -> BbsResult<Vec<KeyShare>> {
    let threshold = coefficients.len() as u32 + 1;
    if threshold < 2 || threshold > total_shares {
        return Err(BbsError::InvalidScalar);
    }

    let mut shares = Vec::with_capacity(total_shares as usize);
    for i in 1..=total_shares {
        let x = Fr::from_u64(i as u64);
        let mut acc = secret;
        let mut x_pow = x;
        for coeff in coefficients {
            acc = acc.add(&coeff.mul(&x_pow));
            x_pow = x_pow.mul(&x);
        }
        shares.push(KeyShare { index: i, value: acc });
    }
    Ok(shares)
}

/// Reconstructs the secret from `shares` (must contain at least the
/// original threshold's worth, though this function has no way to know that
/// threshold itself -- callers must not invoke it with fewer than `t`
/// shares, since it will silently return the wrong scalar rather than fail).
///
/// Uses Lagrange interpolation evaluated at `x = 0`:
/// `secret = sum_i( y_i * prod_{j != i}( x_j / (x_j - x_i) ) )`.
pub fn reconstruct_secret(shares: &[KeyShare]) -> BbsResult<Fr> {
    if shares.len() < 2 {
        return Err(BbsError::InvalidScalar);
    }

    for i in 0..shares.len() {
        for j in (i + 1)..shares.len() {
            if shares[i].index == shares[j].index {
                // Duplicate share index: the Lagrange basis below would
                // divide by zero, and a duplicate carries no additional
                // information anyway.
                return Err(BbsError::InvalidScalar);
            }
        }
    }

    let mut secret = Fr::zero();
    for i in 0..shares.len() {
        let xi = Fr::from_u64(shares[i].index as u64);
        let mut numerator = Fr::one();
        let mut denominator = Fr::one();
        for j in 0..shares.len() {
            if i == j {
                continue;
            }
            let xj = Fr::from_u64(shares[j].index as u64);
            numerator = numerator.mul(&xj);
            denominator = denominator.mul(&xj.sub(&xi));
        }
        let lagrange_coefficient = numerator.mul(&denominator.invert()?);
        secret = secret.add(&shares[i].value.mul(&lagrange_coefficient));
    }
    Ok(secret)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_split_and_reconstruct_exact_threshold() {
        let secret = Fr::from_u64(424242);
        let coefficients = [Fr::from_u64(7), Fr::from_u64(19)]; // threshold = 3
        let shares = split_secret(secret, &coefficients, 5).unwrap();
        assert_eq!(shares.len(), 5);

        let subset = [shares[0], shares[2], shares[4]];
        let recovered = reconstruct_secret(&subset).unwrap();
        assert_eq!(recovered, secret);
    }

    #[test]
    fn test_reconstruct_with_different_subset_matches() {
        let secret = Fr::from_u64(99);
        let coefficients = [Fr::from_u64(3)]; // threshold = 2
        let shares = split_secret(secret, &coefficients, 5).unwrap();

        let subset_a = [shares[0], shares[1]];
        let subset_b = [shares[2], shares[4]];
        assert_eq!(reconstruct_secret(&subset_a).unwrap(), secret);
        assert_eq!(reconstruct_secret(&subset_b).unwrap(), secret);
    }

    #[test]
    fn test_split_rejects_invalid_threshold() {
        let secret = Fr::from_u64(1);
        // threshold (coefficients.len() + 1 = 6) exceeds total_shares (5)
        let coefficients = [Fr::from_u64(1); 5];
        assert!(split_secret(secret, &coefficients, 5).is_err());
    }

    #[test]
    fn test_reconstruct_rejects_duplicate_indices() {
        let share = KeyShare { index: 1, value: Fr::from_u64(1) };
        assert!(reconstruct_secret(&[share, share]).is_err());
    }

    #[test]
    fn test_key_share_byte_round_trip() {
        let share = KeyShare { index: 3, value: Fr::from_u64(555) };
        let bytes = share.to_bytes();
        let decoded = KeyShare::from_bytes(&bytes).unwrap();
        assert_eq!(decoded, share);
    }
}
