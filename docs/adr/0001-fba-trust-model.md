# ADR-0001: Federated Byzantine Agreement (FBA) Trust Model

## Status
Accepted

## Context
QuorumProof needed a decentralized trust mechanism for credential verification that doesn't rely on a central authority. The problem: how to enable engineers to build personal trust networks that are verifiable, tamper-proof, and don't require trusting a single entity.

## Decision
Adopt the Federated Byzantine Agreement (FBA) trust model from the Stellar whitepaper, allowing each credential holder to define their own "quorum slice" — a personal set of trusted attestors (university, licensing body, employers) whose collective signature validates credentials.

## Rationale
- **Decentralized**: No central registry or authority needed
- **Flexible**: Each engineer controls who they trust
- **Proven**: FBA powers Stellar's consensus, battle-tested at scale
- **Auditable**: Attestation history is transparent and verifiable on-chain
- **Scalable**: Verification doesn't require contacting all attestors simultaneously

## Alternatives Considered
- **Centralized Registry**: Single authority validates all credentials
  - Tradeoff: Simpler to implement, but creates a single point of failure and trust bottleneck
  
- **Proof-of-Authority (PoA)**: Fixed set of validators
  - Tradeoff: Faster consensus, but less flexible for individual trust preferences
  
- **Threshold Signatures (m-of-n)**: Require m signatures from n attestors
  - Tradeoff: Simpler than FBA, but doesn't allow for hierarchical trust relationships

## Consequences
### Positive
- Engineers have full control over their trust network
- No central authority to corrupt or go offline
- Transparent, auditable attestation history
- Aligns with Stellar's decentralized philosophy

### Negative
- More complex to implement and reason about
- Requires all attestors to be on-chain or accessible
- Quorum slice misconfiguration could invalidate credentials

## References
- [Stellar Whitepaper](https://www.stellar.org/papers/stellar-consensus-protocol.pdf)
- [Trust Slice Model Documentation](../trust-slices.md)
