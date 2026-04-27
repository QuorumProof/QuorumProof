# ADR-003: Zero-Knowledge Verification Approach

## Status
Accepted

## Context
QuorumProof needs to support conditional verification of credentials — allowing verifiers to check specific claims (e.g., "has a Mechanical Engineering degree") without accessing the full credential data (e.g., GPA, transcript details).

This is essential for privacy-preserving verification where credential holders want to prove specific attributes without revealing unnecessary personal information.

The question is: how should we implement zero-knowledge (ZK) verification on Soroban?

## Problem Statement
How can we enable privacy-preserving credential verification where:
1. Verifiers can confirm specific claims without accessing full credential data
2. Credential holders control what information is revealed
3. The system is efficient enough for real-time verification
4. The implementation is practical on Soroban (a resource-constrained environment)

## Alternatives Considered

### 1. Full Credential Disclosure
- **Description**: Verifiers receive the complete credential data and verify it themselves
- **Pros**:
  - Simple to implement
  - No cryptographic overhead
  - Verifiers have full transparency
- **Cons**:
  - Reveals all credential data to verifiers
  - No privacy for credential holders
  - Verifiers must trust their own verification logic
  - Not suitable for sensitive information (GPA, medical history, etc.)

### 2. Selective Disclosure with Hashing
- **Description**: Credential holder provides specific fields and their hashes; verifier checks hashes match
- **Pros**:
  - Simple to implement
  - Efficient
  - Supports selective disclosure
  - Works well on resource-constrained systems
- **Cons**:
  - Verifier can brute-force small fields (e.g., degree types)
  - Does not provide cryptographic proof of knowledge
  - Requires trust in credential holder's hashing

### 3. Zero-Knowledge Proofs (ZKPs) ✓ **CHOSEN**
- **Description**: Credential holder generates a ZK proof that a claim is true without revealing the underlying data
- **Pros**:
  - Strong privacy guarantees
  - Cryptographically sound
  - Verifier cannot brute-force or infer additional information
  - Supports complex claims (e.g., "degree in engineering AND GPA > 3.5")
  - Industry standard for privacy-preserving verification
- **Cons**:
  - More complex to implement
  - Higher computational overhead
  - Requires careful circuit design
  - Proof generation can be slow on resource-constrained devices

### 4. Trusted Execution Environment (TEE)
- **Description**: Use a TEE (e.g., Intel SGX) to verify credentials privately
- **Pros**:
  - Hardware-backed security
  - Efficient verification
  - Supports complex logic
- **Cons**:
  - Requires specialized hardware
  - Not available on all platforms
  - Introduces centralized trust point
  - Difficult to audit and verify

## Decision
**Implement Zero-Knowledge Proofs (ZKPs) for conditional credential verification.**

The system will use a dedicated `zk_verifier` contract that:
1. Accepts a credential ID and a claim type
2. Accepts a ZK proof from the credential holder
3. Verifies the proof without accessing the underlying credential data
4. Returns true/false based on proof validity

## Rationale

1. **Privacy Preservation**: ZKPs provide the strongest privacy guarantees. Verifiers cannot infer any information beyond the specific claim being verified.

2. **Cryptographic Soundness**: ZKPs are mathematically proven to be secure. Unlike hashing or selective disclosure, they cannot be broken by brute-force or inference attacks.

3. **Flexibility**: ZKPs support complex claims (e.g., "degree in engineering AND GPA > 3.5") that cannot be expressed with simple hashing.

4. **Industry Standard**: ZKPs are the industry standard for privacy-preserving verification. Using them aligns with best practices and allows integration with other ZK systems.

5. **Credential Holder Control**: Credential holders can choose which claims to prove and which to keep private. This gives them full control over information disclosure.

6. **Verifier Efficiency**: Proof verification is fast and efficient, even on resource-constrained systems like Soroban.

## Consequences

### Positive
- Strong privacy guarantees for credential holders
- Cryptographically sound verification
- Supports complex conditional claims
- Aligns with industry standards
- Enables selective disclosure
- Verifiers cannot infer additional information

### Negative
- More complex to implement and understand
- Proof generation requires computational resources
- Requires careful circuit design to avoid bugs
- Proof generation can be slow on resource-constrained devices
- Requires education for users on how to generate proofs

## Implementation Notes

1. **Claim Types**: The system supports specific claim types:
   - `HasDegree`: Credential holder has a degree
   - `HasLicense`: Credential holder has a professional license
   - `HasEmployment`: Credential holder has employment history
   - `HasSkill`: Credential holder has a specific skill
   - Custom claims can be added

2. **Proof Generation**: Credential holders generate proofs using:
   - The credential metadata
   - The claim type
   - A ZK circuit specific to the claim
   - Their private key (for authentication)

3. **Proof Verification**: The `zk_verifier` contract:
   - Receives the credential ID, claim type, and proof
   - Verifies the proof using the ZK circuit
   - Returns true if the proof is valid, false otherwise

4. **Circuit Design**: Each claim type has a corresponding ZK circuit that:
   - Takes the credential metadata as input
   - Checks the specific claim
   - Outputs a boolean result
   - Ensures no information leakage

5. **Integration with Credential Verification**: The `verify_engineer` function:
   - Checks that the credential exists and is attested
   - Calls the `zk_verifier` to verify the specific claim
   - Returns true only if both checks pass

## Security Considerations

1. **Circuit Correctness**: ZK circuits must be carefully designed and audited to ensure they correctly implement the claim logic without information leakage.

2. **Proof Soundness**: The ZK system must use a sound proof system (e.g., zk-SNARKs, zk-STARKs) to ensure proofs cannot be forged.

3. **Credential Binding**: Proofs must be bound to the specific credential to prevent proof reuse across different credentials.

4. **Replay Protection**: The system must prevent proof replay attacks by including a nonce or timestamp in the proof.

## Future Enhancements

1. **Recursive Proofs**: Support proofs that verify other proofs, enabling complex multi-credential verification.

2. **Aggregated Proofs**: Allow multiple claims to be verified in a single proof for efficiency.

3. **Threshold Proofs**: Support proofs like "at least 2 of 3 credentials have claim X".

4. **Expressive Circuits**: Support more complex claims (e.g., "degree in engineering AND GPA > 3.5 AND graduated after 2020").

## References
- [Zero-Knowledge Proofs - Wikipedia](https://en.wikipedia.org/wiki/Zero-knowledge_proof)
- [zk-SNARKs - Vitalik Buterin](https://blog.ethereum.org/2016/12/05/zksnarks-in-a-nutshell/)
- [Circom - Circuit Compiler](https://docs.circom.io/)
- [ZK Verification Design Documentation](../zk-verification.md)
