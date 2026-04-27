# ADR-001: Federated Byzantine Agreement (FBA) Trust Model

## Status
Accepted

## Context
QuorumProof is designed to verify professional credentials across international borders without relying on a central authority. The system needs to support trust decisions made by individuals (engineers) who define their own network of attestors (universities, licensing bodies, employers).

The Stellar whitepaper introduced Federated Byzantine Agreement (FBA) as a consensus model where each participant can define their own "quorum slice" — a set of trusted nodes whose agreement is sufficient for consensus. This model is fundamentally different from traditional Byzantine Fault Tolerance (BFT) which requires a fixed, known set of validators.

## Problem Statement
How should QuorumProof establish trust in credentials when:
1. There is no central authority to validate credentials
2. Different engineers may trust different institutions
3. Credentials must be verifiable across borders and jurisdictions
4. The system must be resistant to collusion and fraud

## Alternatives Considered

### 1. Centralized Registry (Traditional Approach)
- **Description**: A central authority maintains a registry of all credentials and attestors
- **Pros**:
  - Simple to implement and understand
  - Easy to enforce consistent rules
  - Straightforward revocation and updates
- **Cons**:
  - Single point of failure
  - Requires trust in central authority
  - Difficult to operate across jurisdictions
  - Vulnerable to censorship and corruption
  - Does not scale globally

### 2. Proof-of-Work Consensus (Blockchain)
- **Description**: Use traditional blockchain consensus (PoW) where miners validate credentials
- **Pros**:
  - Decentralized
  - Censorship-resistant
  - Well-understood model
- **Cons**:
  - Extremely energy-intensive
  - Slow transaction finality
  - Requires significant computational resources
  - Not suitable for credential verification use case

### 3. Proof-of-Stake Consensus (Blockchain)
- **Description**: Use PoS where validators are chosen based on stake
- **Pros**:
  - More energy-efficient than PoW
  - Faster finality
  - Decentralized
- **Cons**:
  - Requires all participants to trust the same validator set
  - Does not support individual trust decisions
  - Difficult to represent diverse, international trust networks
  - Validator set changes are complex and contentious

### 4. Federated Byzantine Agreement (FBA) ✓ **CHOSEN**
- **Description**: Each participant defines their own quorum slice of trusted nodes
- **Pros**:
  - Supports individual trust decisions
  - No central authority required
  - Naturally represents diverse trust networks
  - Proven model (used by Stellar)
  - Efficient and fast
  - Scales to global networks
- **Cons**:
  - More complex to understand and implement
  - Requires careful design of quorum slices
  - Potential for network partitions if slices are poorly designed

## Decision
**Adopt Federated Byzantine Agreement (FBA) as the trust model for QuorumProof.**

Each engineer defines a personal quorum slice consisting of:
- Their university (degree attestation)
- A national engineering society (license validation)
- Previous employers (professional history)

Credentials are considered attested when the weighted sum of attestations from the quorum slice meets or exceeds a threshold. This allows engineers to build trust networks that reflect their actual professional relationships.

## Rationale

1. **Alignment with Stellar**: QuorumProof is built on Stellar Soroban, which uses FBA. Adopting the same model ensures consistency and allows future integration with Stellar's native consensus.

2. **Individual Agency**: Engineers control their own trust networks rather than relying on a central authority. This is essential for a system designed to work across borders and jurisdictions.

3. **Scalability**: FBA scales to global networks without requiring all participants to trust the same validator set. Each participant can have their own quorum slice.

4. **Efficiency**: FBA achieves consensus quickly without the computational overhead of PoW or the complexity of PoS validator elections.

5. **Real-World Modeling**: The model naturally represents how professional credentials actually work — through networks of trusted institutions and individuals.

## Consequences

### Positive
- Engineers have full control over their trust networks
- System is resistant to single points of failure
- Naturally supports international and cross-jurisdictional verification
- Efficient and fast credential verification
- Aligns with Stellar's proven consensus model

### Negative
- More complex for users to understand than centralized systems
- Requires careful design of quorum slices to avoid network partitions
- Potential for "trust bubbles" if slices are poorly designed
- Requires education and guidance for users to set up effective slices

## Implementation Notes

1. **Quorum Slice Structure**: Each slice consists of:
   - A list of attestors (addresses)
   - Weights for each attestor (representing their stake/trust)
   - A threshold (minimum weight sum required for attestation)

2. **Weighted Attestation**: The sum of weights from attesting parties must meet or exceed the threshold. This allows for flexible trust models:
   - Equal weight: All attestors have equal say
   - Weighted: Some attestors are more trusted than others
   - Hierarchical: Different types of attestors have different weights

3. **Credential Attestation**: A credential is considered attested when:
   ```
   sum(weights of attesting parties) >= threshold
   ```

4. **Verification**: To verify a credential, check:
   - The credential exists and is not revoked
   - The credential has not expired
   - The credential is attested by the required quorum slice

## References
- [Stellar Consensus Protocol (SCP) Whitepaper](https://www.stellar.org/papers/stellar-consensus-protocol.pdf)
- [Federated Byzantine Agreement - Wikipedia](https://en.wikipedia.org/wiki/Byzantine_fault_tolerance#Federated_Byzantine_Agreement)
- [Trust Slice Model Documentation](../trust-slices.md)
