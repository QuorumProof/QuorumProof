# ADR-002: Soulbound Token (SBT) Non-Transferability

## Status
Accepted

## Context
QuorumProof issues Soulbound Tokens (SBTs) to represent verified professional credentials on-chain. Unlike traditional NFTs, SBTs are designed to be non-transferable — they are bound to the credential holder's identity and cannot be sold, traded, or transferred to another person.

The question is: should SBTs be technically enforced as non-transferable at the smart contract level, or should they be transferable with social/legal enforcement of non-transferability?

## Problem Statement
How should we ensure that professional credentials (represented as SBTs) cannot be fraudulently transferred to another person?

1. **Fraud Prevention**: Prevent credential holders from selling their credentials to others
2. **Identity Binding**: Ensure credentials remain bound to the original holder
3. **Verification Integrity**: Ensure verifiers can trust that the credential holder is the original recipient
4. **Regulatory Compliance**: Support jurisdictions that require credentials to be non-transferable

## Alternatives Considered

### 1. Transferable NFTs with Social Enforcement
- **Description**: Implement SBTs as standard transferable NFTs, relying on social norms and legal agreements to prevent transfer
- **Pros**:
  - Simpler smart contract implementation
  - More flexible for edge cases (e.g., credential recovery)
  - Aligns with standard NFT patterns
  - Allows for credential inheritance or delegation
- **Cons**:
  - Relies on external enforcement (difficult to verify)
  - Vulnerable to fraud and credential theft
  - Verifiers cannot trust that holder is original recipient
  - Does not prevent black market credential sales
  - Difficult to enforce across jurisdictions

### 2. Technically Non-Transferable SBTs ✓ **CHOSEN**
- **Description**: Implement SBTs with smart contract logic that prevents any transfer
- **Pros**:
  - Cryptographically enforced non-transferability
  - Verifiers can trust credential binding
  - Prevents fraud and credential theft
  - Clear and unambiguous rules
  - Supports regulatory compliance
  - Aligns with SBT philosophy
- **Cons**:
  - Less flexible for edge cases
  - Requires careful handling of credential recovery
  - May not support all use cases (e.g., inheritance)
  - Requires new patterns for credential updates

### 3. Conditional Transferability
- **Description**: Allow transfers only under specific conditions (e.g., with issuer approval, after expiry)
- **Pros**:
  - Flexible for edge cases
  - Allows credential recovery with issuer approval
  - Supports some delegation scenarios
- **Cons**:
  - More complex to implement and understand
  - Requires trust in issuer for recovery
  - Potential for abuse if conditions are too permissive
  - Harder to verify and audit

## Decision
**Implement SBTs as technically non-transferable at the smart contract level.**

The `transfer()` function will be disabled or will panic if called. The only way to update or recover a credential is through:
1. **Credential Revocation**: The issuer can revoke the old credential
2. **Credential Reissuance**: The issuer can issue a new credential to the same subject
3. **Credential Expiry**: Expired credentials are automatically revoked

## Rationale

1. **Fraud Prevention**: Technical enforcement is the only reliable way to prevent credential fraud. Social enforcement is insufficient for high-stakes professional credentials.

2. **Verification Integrity**: Verifiers need cryptographic assurance that the credential holder is the original recipient. This is essential for international hiring and professional verification.

3. **Regulatory Alignment**: Many jurisdictions require professional credentials to be non-transferable. Technical enforcement supports compliance.

4. **SBT Philosophy**: Soulbound Tokens are specifically designed to be non-transferable. Implementing them as transferable NFTs contradicts the core concept.

5. **Simplicity**: Non-transferable SBTs are simpler to understand and verify than conditional transferability schemes.

6. **Precedent**: Established SBT implementations (e.g., Ethereum SBTs) use technical non-transferability.

## Consequences

### Positive
- Credentials are cryptographically bound to the holder
- Verifiers can trust credential authenticity
- Prevents credential fraud and black market sales
- Supports regulatory compliance
- Clear and unambiguous rules
- Aligns with SBT standards

### Negative
- Less flexible for edge cases (e.g., credential recovery after wallet loss)
- Requires issuer involvement for credential updates
- May not support all use cases (e.g., inheritance)
- Users cannot transfer credentials even with consent
- Requires careful handling of credential lifecycle

## Implementation Notes

1. **Transfer Prevention**: The SBT contract will not implement a `transfer()` function. Any attempt to transfer will fail.

2. **Credential Recovery**: If a user loses access to their wallet:
   - The issuer can revoke the old credential
   - The issuer can issue a new credential to the user's new wallet
   - The user must re-attest the credential with their quorum slice

3. **Credential Updates**: If a credential needs to be updated:
   - The issuer revokes the old credential
   - The issuer issues a new credential with updated metadata
   - The user must re-attest the new credential

4. **Credential Expiry**: Credentials can have an expiry date. Expired credentials are automatically revoked and cannot be used for verification.

5. **Revocation Events**: All revocations (manual, expiry-based, or recovery-based) emit events for auditing.

## Security Considerations

1. **Wallet Security**: Users must secure their wallets carefully, as there is no recovery mechanism other than issuer reissuance.

2. **Issuer Trust**: Users must trust their issuers to reissue credentials if needed. This is acceptable because issuers are already trusted to issue credentials.

3. **Credential Binding**: The SBT is bound to the subject's address. If the subject's address is compromised, the credential is compromised. This is inherent to blockchain-based credentials.

## References
- [Soulbound Tokens (SBTs) - Vitalik Buterin](https://vitalik.ca/general/2022/01/26/soulbound.html)
- [ERC-5192: Minimal Soulbound NFTs](https://eips.ethereum.org/EIPS/eip-5192)
- [Credential Expiry and Auto-Revocation](../credential-expiry.md)
