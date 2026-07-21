# BBS+ Cryptographic Core (v0.1.0)

Pure Rust implementation of BBS+ (Boneh-Boyen-Signatures) multi-message signature scheme with selective disclosure for privacy-preserving credentials.

## Features

- **BBS+ Signature Scheme**: Sign multiple attributes in a single credential
- **Selective Disclosure**: Prove subsets of attributes without revealing others
- **Unlinkability**: Multiple presentations of the same credential cannot be linked
- **Zero-Knowledge Proofs**: Cryptographically prove claims about attributes
- **Predicates**: Support range proofs, equality, and custom constraints
- **Accumulator Integration**: Cryptographic accumulators for unlinkable revocation

## Architecture

### Modules

- `primitives.rs` - BLS12-381 curve arithmetic (Fr, G1, G2, GT)
- `transcript.rs` - Fiat-Shamir transcript for challenge generation
- `signature.rs` - BBS+ key generation and signing (coming)
- `presentation.rs` - Presentation proof generation and verification (coming)
- `accumulator.rs` - Cryptographic accumulator for revocation (coming)
- `errors.rs` - Error types and result definitions

### Security Properties

- **Curve**: BLS12-381 (pairing-friendly, 128-bit security)
- **Signature unforgeability**: EUF-CMA (Existential Unforgeability)
- **Proof soundness**: Honest Verifier ZK (HVZK)
- **Unlinkability**: Information-theoretic (unconditional)
- **Revocation**: Accumulator-based non-membership proofs

## Usage

### Basic Example (when modules are complete)

```rust
use bbs_plus_v1::{Fr, G1, Transcript, DOMAIN_BBS_PLUS};

// Create transcript for Fiat-Shamir
let mut transcript = Transcript::new(DOMAIN_BBS_PLUS.as_bytes());

// Append data to transcript
let scalar = Fr::one();
transcript.append_scalar(b"test", &scalar);

// Generate challenge
let challenge = transcript.squeeze_challenge().unwrap();
```

## Cryptographic References

- Boneh, D., Boyen, X., & Shacham, H. (2004). "Short Signatures from the Weil Pairing"
- Au, M. H., Chow, S. S., & Yiu, S. M. (2016). "Short Linkable Ring Signatures Revisited"
- W3C Verifiable Credentials Data Model 2.0

## No-std Compatibility

This library targets `no_std` for Soroban smart contract deployment. Features:

- `std` (default): Standard library support
- `soroban`: Soroban SDK types
- `serde_support`: Serialization framework

## Testing

```bash
cargo test --lib
cargo test --lib --release
cargo bench --benches bbs_plus_benchmarks
```

## Phase 1 Status (Current)

- [x] Primitives module with curve arithmetic
- [x] Transcript module with Fiat-Shamir
- [x] Error handling
- [x] Core lib structure
- [ ] Signature module (in progress)
- [ ] Presentation module (pending)
- [ ] Accumulator module (pending)
- [ ] Serialization module (pending)

## Gas Optimization Notes

Target Soroban performance (per operation):
- Signature generation: 100-200ms
- Presentation proof: 50-100ms
- Serialization: <10ms
- Non-membership proof: 150-250ms

## Future Extensions

- Aggregated signatures (BBS-A)
- Threshold credentials (M-of-N)
- Conditional attributes
- Proof aggregation
