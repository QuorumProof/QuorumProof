# Threat Model & Security Analysis

## Overview

This document outlines the threat model for QuorumProof, identifying potential attack vectors, their impact, and mitigation strategies. It covers credential issuance, attestation, verification, and dispute resolution features.

## System Architecture

QuorumProof consists of three main components:

1. **QuorumProof Contract**: Core credential management and quorum slice logic
2. **SBT Registry Contract**: Soulbound token issuance and management
3. **ZK Verifier Contract**: Zero-knowledge proof verification for conditional claims

## Threat Categories

### 1. Credential Issuance Threats

#### 1.1 Unauthorized Credential Issuance
**Threat**: An attacker issues credentials on behalf of a legitimate issuer.

**Attack Vector**:
- Compromise issuer's private key
- Exploit smart contract vulnerability to bypass issuer authentication
- Social engineering to trick issuer into signing malicious transactions

**Impact**: High
- Fraudulent credentials in circulation
- Damage to issuer's reputation
- Potential harm to credential holders and verifiers

**Mitigations**:
- Require issuer authentication via `require_auth()` on all issuance functions
- Use multi-signature schemes for high-value issuers
- Implement rate limiting on credential issuance
- Audit issuer key management practices
- Monitor for unusual issuance patterns

#### 1.2 Duplicate Credential Issuance
**Threat**: An issuer issues multiple credentials of the same type to the same subject.

**Attack Vector**:
- Accidental duplicate issuance
- Intentional issuance to inflate credential count
- Replay attack on issuance transaction

**Impact**: Medium
- Confusion about credential validity
- Potential for double-counting in verification
- Audit trail complexity

**Mitigations**:
- Enforce uniqueness constraint: one credential per (issuer, subject, type) tuple
- Implement idempotent issuance (reject duplicates)
- Emit events for all issuance attempts (including rejections)
- Maintain audit log of all issuance attempts

### 2. Attestation Threats

#### 2.1 Unauthorized Attestation
**Threat**: An attacker attests to credentials without authorization.

**Attack Vector**:
- Compromise attestor's private key
- Exploit smart contract vulnerability to bypass attestor validation
- Impersonate attestor address

**Impact**: High
- Fraudulent attestations inflate credential credibility
- Verifiers trust invalid credentials
- Undermines entire trust model

**Mitigations**:
- Require attestor authentication via `require_auth()`
- Verify attestor is in the quorum slice before accepting attestation
- Implement attestor reputation tracking
- Monitor for unusual attestation patterns
- Require multi-signature for high-value attestations

#### 2.2 Quorum Slice Manipulation
**Threat**: An attacker manipulates quorum slices to lower attestation thresholds.

**Attack Vector**:
- Compromise slice creator's key
- Add malicious attestors to existing slices
- Reduce threshold to enable easier attestation

**Impact**: High
- Credentials become attested with insufficient trust
- Verifiers cannot rely on attestation guarantees
- Undermines FBA trust model

**Mitigations**:
- Only slice creator can modify their own slice
- Require explicit authorization for slice modifications
- Implement slice versioning to track changes
- Emit events for all slice modifications
- Require threshold >= 50% of total weight (prevent trivial thresholds)

#### 2.3 Attestor Collusion
**Threat**: Multiple attestors collude to attest to false credentials.

**Attack Vector**:
- Attestors coordinate to sign fraudulent credentials
- Attestors are compromised by attacker
- Attestors are malicious from the start

**Impact**: High
- Fraudulent credentials appear legitimate
- Verifiers cannot distinguish legitimate from fraudulent credentials
- Undermines entire credential system

**Mitigations**:
- Diversify attestor networks (university, licensing body, employers)
- Implement reputation tracking for attestors
- Monitor for suspicious attestation patterns
- Require threshold > 50% to prevent single-attestor dominance
- Implement dispute resolution to challenge fraudulent attestations
- Use weighted attestation to reduce impact of compromised attestors

### 3. Credential Verification Threats

#### 3.1 Expired Credential Verification
**Threat**: An attacker uses an expired credential for verification.

**Attack Vector**:
- Attempt to verify with expired credential
- Exploit smart contract to bypass expiry check
- Modify credential expiry timestamp

**Impact**: Medium
- Outdated credentials accepted as valid
- Verifiers make decisions based on stale information
- Licensing/employment status may have changed

**Mitigations**:
- Enforce expiry check in `get_credential()` function
- Implement auto-revocation for expired credentials
- Require explicit expiry timestamp for time-limited credentials
- Monitor credential expiry and send renewal reminders
- Implement credential renewal flow

#### 3.2 Revoked Credential Verification
**Threat**: An attacker uses a revoked credential for verification.

**Attack Vector**:
- Attempt to verify with revoked credential
- Exploit smart contract to bypass revocation check
- Modify revocation flag

**Impact**: High
- Revoked credentials accepted as valid
- Verifiers make decisions based on invalid credentials
- Potential for fraud if credential was revoked due to misconduct

**Mitigations**:
- Enforce revocation check in `get_credential()` function
- Maintain immutable revocation log
- Emit revocation events for auditing
- Implement revocation registry for quick lookup
- Require explicit revocation authorization from issuer

### 4. Dispute Resolution Threats

#### 4.1 Admin Collusion
**Threat**: Admin and attestors collude to attest to fraudulent credentials and reject legitimate disputes.

**Attack Vector**:
- Admin and attestors coordinate to issue fraudulent credentials
- Admin rejects all disputes challenging the fraudulent credentials
- Admin uses veto power to prevent dispute resolution

**Impact**: Critical
- Fraudulent credentials cannot be challenged
- Verifiers have no recourse for credential fraud
- System loses credibility

**Mitigations**:
- Implement multi-signature admin (require 2-of-3 or 3-of-5 signatures)
- Separate dispute resolution from credential issuance
- Implement independent dispute arbiters
- Require evidence submission for all disputes
- Implement appeal process for rejected disputes
- Implement time-based dispute resolution (auto-resolve if no response)
- Implement transparent dispute log

#### 4.2 False Dispute Attacks
**Threat**: An attacker files false disputes to harass credential holders or attestors.

**Attack Vector**:
- File disputes against legitimate credentials
- File disputes to delay credential verification
- File disputes to damage reputation of attestors

**Impact**: Medium
- Legitimate credentials delayed or blocked
- Attestor reputation damaged
- System overwhelmed with false disputes

**Mitigations**:
- Require evidence submission with disputes
- Implement dispute deposit (refunded if dispute is valid)
- Implement dispute cooldown period
- Implement rate limiting on disputes per address
- Implement reputation-based dispute weighting
- Require dispute justification and documentation

#### 4.3 Dispute Timeout Abuse
**Threat**: An attacker exploits dispute timeout mechanisms to delay resolution indefinitely.

**Attack Vector**:
- File dispute just before timeout
- Repeatedly file new disputes to restart timeout
- Exploit timeout logic to prevent resolution

**Impact**: Medium
- Credential verification delayed indefinitely
- Legitimate credentials cannot be used
- System becomes unreliable

**Mitigations**:
- Implement fixed dispute resolution timeline (e.g., 30 days)
- Implement maximum dispute count per credential
- Implement auto-resolution if no response within timeout
- Implement escalation process for unresolved disputes
- Implement dispute priority queue
- Require explicit dispute renewal (no automatic restart)

#### 4.4 Evidence Tampering
**Threat**: An attacker modifies dispute evidence after submission.

**Attack Vector**:
- Modify evidence stored on IPFS
- Replace evidence with different content
- Delete evidence to prevent review

**Impact**: High
- Dispute resolution based on false evidence
- Legitimate disputes rejected due to missing evidence
- Fraudulent disputes accepted due to fabricated evidence

**Mitigations**:
- Store only evidence hash on-chain (immutable)
- Verify evidence integrity: `sha256(evidence) == dispute.evidence_hash`
- Use IPFS content addressing (hash-based)
- Implement evidence pinning to prevent deletion
- Require cryptographic signatures on evidence
- Implement evidence versioning and audit trail

### 5. Smart Contract Threats

#### 5.1 Reentrancy Attacks
**Threat**: An attacker exploits reentrancy to call contract functions multiple times.

**Attack Vector**:
- Call contract function that calls external contract
- External contract calls back into original contract
- Exploit state inconsistency to perform unauthorized actions

**Impact**: High
- Unauthorized credential issuance/revocation
- Double-spending of attestations
- State corruption

**Mitigations**:
- Use checks-effects-interactions pattern
- Implement reentrancy guards
- Use Soroban's built-in protections against reentrancy
- Audit all external calls
- Implement state validation after external calls

#### 5.2 Integer Overflow/Underflow
**Threat**: An attacker exploits integer arithmetic bugs to manipulate values.

**Attack Vector**:
- Cause weight sum to overflow
- Cause credential count to underflow
- Exploit arithmetic bugs in threshold calculations

**Impact**: Medium
- Incorrect threshold calculations
- Credential count corruption
- Weight calculations become invalid

**Mitigations**:
- Use safe arithmetic (checked operations)
- Implement bounds checking on all arithmetic
- Use Rust's built-in overflow protection
- Audit all arithmetic operations
- Implement invariant checks

#### 5.3 Access Control Bypass
**Threat**: An attacker bypasses access control checks to perform unauthorized actions.

**Attack Vector**:
- Exploit missing `require_auth()` calls
- Exploit incorrect authorization logic
- Exploit role-based access control bugs

**Impact**: Critical
- Unauthorized credential issuance/revocation
- Unauthorized slice modifications
- Unauthorized admin actions

**Mitigations**:
- Require explicit `require_auth()` on all sensitive functions
- Implement role-based access control
- Audit all authorization logic
- Implement access control tests
- Use static analysis tools to detect missing checks

## Dispute Resolution Security

### Dispute Flow

```
1. Credential Holder or Verifier files dispute
   ↓
2. Submit evidence hash and dispute reason
   ↓
3. Dispute enters review period (30 days)
   ↓
4. Admin/Arbiters review evidence
   ↓
5. Admin/Arbiters vote on dispute resolution
   ↓
6. If threshold met: Credential revoked or dispute rejected
   ↓
7. Dispute resolution logged and events emitted
```

### Dispute Evidence Requirements

All disputes must include:
- **Evidence Hash**: IPFS hash of supporting documentation
- **Dispute Reason**: Specific claim being disputed (e.g., "degree not awarded")
- **Timestamp**: When dispute was filed
- **Filer Address**: Address of dispute filer

### Dispute Resolution Voting

- **Multi-Signature Admin**: Require 2-of-3 or 3-of-5 admin signatures
- **Weighted Voting**: Admin votes weighted by reputation
- **Threshold**: Require >50% of admin weight to resolve dispute
- **Timeout**: Auto-resolve if no response within 30 days

### Dispute Appeal Process

- **Appeal Window**: 7 days after dispute resolution
- **Appeal Evidence**: New evidence supporting appeal
- **Appeal Threshold**: Require >66% of admin weight to overturn
- **Maximum Appeals**: 2 appeals per dispute

## Security Recommendations for Operators

### 1. Key Management
- Use hardware wallets for admin keys
- Implement multi-signature schemes
- Rotate keys regularly
- Maintain secure key backups
- Implement key recovery procedures

### 2. Monitoring & Alerting
- Monitor for unusual credential issuance patterns
- Monitor for unusual attestation patterns
- Monitor for unusual dispute patterns
- Alert on failed authorization attempts
- Alert on contract state anomalies

### 3. Incident Response
- Maintain incident response plan
- Implement emergency pause mechanism
- Implement credential revocation procedures
- Implement dispute escalation procedures
- Maintain audit logs for forensics

### 4. Regular Audits
- Conduct quarterly security audits
- Perform penetration testing
- Review access control logs
- Review dispute resolution logs
- Audit credential issuance patterns

### 5. Credential Lifecycle Management
- Implement credential renewal procedures
- Implement credential expiry enforcement
- Implement credential revocation procedures
- Implement credential recovery procedures
- Maintain credential audit trail

## Compliance Considerations

### Data Protection
- Implement privacy-preserving verification (ZK proofs)
- Minimize PII storage on-chain
- Implement data retention policies
- Implement data deletion procedures
- Comply with GDPR, CCPA, and other regulations

### Credential Standards
- Align with international credential standards
- Support credential portability
- Implement credential interoperability
- Support credential verification across systems
- Maintain credential audit trail

### Dispute Resolution
- Implement fair dispute resolution procedures
- Provide appeal mechanisms
- Maintain transparent dispute logs
- Implement independent arbitration
- Comply with local dispute resolution requirements

## References

- [OWASP Smart Contract Security](https://owasp.org/www-project-smart-contract-security/)
- [Stellar Security Best Practices](https://developers.stellar.org/docs/learn/security)
- [Zero-Knowledge Proof Security](https://en.wikipedia.org/wiki/Zero-knowledge_proof)
- [Byzantine Fault Tolerance](https://en.wikipedia.org/wiki/Byzantine_fault_tolerance)
