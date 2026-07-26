# Threat Model: Credential Fraud Detection — Issue #1252

## Executive Summary

This threat model documents credential fraud vectors in the QuorumProof ecosystem, mitigation strategies, and operational safeguards. It complements the cross-chain trust model documentation and focuses on scenarios where valid-looking but fraudulent credentials enter the system.

## Threat Model Scope

**In Scope:**
- Fake credentials issued by impersonated attestors
- Stolen credentials from legitimate credential holders
- Credential tampering and mutation attacks
- Compromised attestor keys
- Collusion attacks among attestors
- Rate-based credential mills

**Out of Scope:**
- Network-layer DDoS attacks
- Smart contract bugs (see separate audit reports)
- Stellar protocol vulnerabilities
- Wallet compromises (separate user responsibility)

---

## Threat Actors

### 1. **Opportunistic Fraudster**
- **Motivation**: Economic gain (job placement, loan approvals)
- **Capability**: Basic technical skills, access to documentation
- **Attack Vector**: Create fake credentials, forge issuer signatures
- **Impact**: Low-volume fraud, detectable via issuer vetting

### 2. **Organized Credential Ring**
- **Motivation**: Revenue from credential fraud-as-a-service
- **Capability**: Technical expertise, social engineering, collusion
- **Attack Vector**: Compromise issuer keys, operate credential mills
- **Impact**: High-volume fraud, persistent threat

### 3. **Disgruntled Attestor**
- **Motivation**: Revenge, financial gain
- **Capability**: Full access to issuer infrastructure
- **Attack Vector**: Issue false credentials, modify audit logs
- **Impact**: High-impact, credential-specific fraud

### 4. **Nation-State/APT**
- **Motivation**: Strategic advantage (espionage, workforce infiltration)
- **Capability**: Advanced persistent threat capabilities
- **Attack Vector**: Compromise multiple attestors, infrastructure
- **Impact**: Systemic trust compromise

---

## Fraud Vectors & Mitigations

### Vector 1: Fake Issuer Attack

**Description**: Attacker creates a fraudulent issuer entity (e.g., "Stanford Engineering Society") and issues credentials.

**Attack Tree**:
```
┌─ Fake Issuer Attack
├─ Precondition: Attacker controls a Stellar account
├─ Step 1: Register fake issuer in audit log
├─ Step 2: Issue credentials signed by fake issuer key
├─ Step 3: Credential holders share with verifiers
└─ Step 4: Verifier trusts fake issuer (no vetting)
```

**Mitigations**:

| Level | Mitigation | Responsibility | Effectiveness |
|-------|-----------|-----------------|----------------|
| **Preventive** | Issuer Vetting: Require legal registration proof, domain ownership, multi-factor enrollment | Operator | ★★★★★ |
| **Preventive** | Tiered Issuer Reputation: New issuers get limited credential volume; trust increases with audit history | System | ★★★★☆ |
| **Detective** | Verifier Due Diligence: Check issuer registration date, credential volume trends, and audit log entries | Verifier | ★★★★☆ |
| **Responsive** | Credential Revocation: Batch revoke credentials from compromised issuer | Operator | ★★★★★ |

**Operational Checks**:
- Review issuer registrations quarterly
- Flag new issuers issuing high-volume credentials
- Monitor for issuer name collisions (e.g., "MIT" vs "M1T")

---

### Vector 2: Stolen Credential Reuse

**Description**: Attacker obtains a valid credential (theft, data breach, phishing) and attempts to use it in a different context or sell it.

**Attack Tree**:
```
┌─ Stolen Credential Reuse
├─ Step 1: Obtain credential (phishing, breach, etc.)
├─ Step 2: Extract credential data or SBT
├─ Step 3: Present to new verifier/employer
├─ Step 4: Risk: Credential accepted if verifier does not check holder identity
└─ Mitigation: Credential binding to holder identity
```

**Mitigations**:

| Level | Mitigation | Responsibility | Effectiveness |
|-------|-----------|-----------------|----------------|
| **Preventive** | Holder Identity Verification: Bind credentials to Stellar account; require on-chain proof-of-ownership | System | ★★★★★ |
| **Preventive** | Revocation Checks: Verifier queries on-chain revocation status before accepting | Verifier | ★★★★★ |
| **Detective** | Usage Anomaly Detection: Flag credentials used across multiple geographies/employers in short timeframe | Operator | ★★★☆☆ |
| **Responsive** | Revocation Notification: Alert credential holders if their SBT is shared/accessed | System | ★★★★☆ |

**Operational Checks**:
- Monitor for duplicate credential presentations in short timeframes
- Log and review high-risk usage patterns (multiple jobs, rapid location changes)

---

### Vector 3: Attestor Key Compromise

**Description**: Attacker gains access to an issuer's signing key (via malware, insider threat, or social engineering) and issues fraudulent credentials.

**Attack Tree**:
```
┌─ Attestor Key Compromise
├─ Step 1: Compromise issuer private key (malware, insider, phishing)
├─ Step 2: Issue high-volume fraudulent credentials
├─ Step 3: Credentials appear valid (signed by legitimate key)
├─ Step 4: Detection lag = credential fraud window
└─ Step 5: Attacker sells credentials or uses them directly
```

**Mitigations**:

| Level | Mitigation | Responsibility | Effectiveness |
|-------|-----------|-----------------|----------------|
| **Preventive** | Key Rotation: Implement regular key rotation schedule (quarterly recommended) | Issuer | ★★★★☆ |
| **Preventive** | Multi-Sig Issuance: Require multi-party authorization for credential issuance (2-of-3, etc.) | System | ★★★★★ |
| **Preventive** | Hardware Security Module (HSM): Store keys in HSM with access controls | Issuer | ★★★★★ |
| **Detective** | Issuance Rate Monitoring: Alert on abnormal credential volumes | Operator | ★★★★☆ |
| **Detective** | Audit Log Immutability: Maintain tamper-proof audit trail of all credential issuances | System | ★★★★★ |
| **Responsive** | Emergency Key Revocation: Invalidate compromised key; re-issue credentials via new key | Operator | ★★★★★ |

**Operational Checks**:
- Monitor issuance rate per issuer (flag 10x normal volume)
- Require issuers to notify operator within 24 hours of key compromise
- Maintain secure issuer communication channel for emergency revocation

---

### Vector 4: Credential Tampering (Mutation Attack)

**Description**: Attacker modifies credential metadata or attributes after issuance.

**Attack Tree**:
```
┌─ Credential Tampering
├─ Attempt 1: Modify on-chain SBT metadata
│  └─ Mitigation: SBTs immutable; metadata hash-protected
├─ Attempt 2: Forge issuer signature on modified data
│  └─ Mitigation: Cryptographic signature verification
└─ Attempt 3: Present off-chain credential copy with modifications
   └─ Mitigation: Require on-chain verification of SBT
```

**Mitigations**:

| Level | Mitigation | Responsibility | Effectiveness |
|-------|-----------|-----------------|----------------|
| **Preventive** | Immutable SBTs: Credentials on-chain are immutable after issuance | System | ★★★★★ |
| **Preventive** | Cryptographic Signatures: All credentials cryptographically signed by issuer | System | ★★★★★ |
| **Preventive** | On-Chain Verification: Verifiers check on-chain SBT, not off-chain copies | Verifier | ★★★★★ |
| **Detective** | Signature Verification Failures: Log and alert on failed verification attempts | System | ★★★★☆ |

**Operational Checks**:
- Audit all failed verification attempts daily
- Verify verifier compliance with on-chain verification requirement

---

### Vector 5: Collusion Attack (Multi-Party Fraud)

**Description**: Multiple attestors collude to issue fraudulent credentials without risk of detection.

**Attack Tree**:
```
┌─ Collusion Attack
├─ Step 1: Multiple issuers agree to issue false credentials
├─ Step 2: Each issues credentials independently (appears legitimate)
├─ Step 3: Credentials form valid multi-party quorum
├─ Step 4: Verifier trusts credentials (all attestors agree)
└─ Step 5: Fraud detected only through real-world verification
```

**Mitigations**:

| Level | Mitigation | Responsibility | Effectiveness |
|-------|-----------|-----------------|----------------|
| **Preventive** | Issuer Diversity: Require credentials from non-colluding entities (e.g., university + employer + regulator) | System | ★★★★☆ |
| **Preventive** | Stake/Reputation System: Issuers with reputation at stake less likely to collude | System | ★★★☆☆ |
| **Detective** | Real-World Verification: Spot-check high-risk credentials with issuer directly | Verifier | ★★★★☆ |
| **Detective** | Behavioral Clustering: Flag issuers that consistently collaborate (may indicate collusion) | Operator | ★★★☆☆ |
| **Responsive** | Batch Revocation: Revoke all credentials from colluding issuers once detected | Operator | ★★★★★ |

**Operational Checks**:
- Monitor issuer collaboration patterns
- Conduct periodic spot-checks (10% of high-value credentials)
- Require verifier feedback on real-world credential validation

---

### Vector 6: Credential Mill / Rate-Based Attack

**Description**: Attacker or compromised issuer issues high-volume low-quality credentials to saturate market.

**Attack Tree**:
```
┌─ Credential Mill
├─ Step 1: Compromise issuer or create fake issuer
├─ Step 2: Auto-issue credentials for thousands of accounts
├─ Step 3: Sell credentials or distribute for fraud
├─ Step 4: Market flooded with worthless credentials
└─ Step 5: Legitimate credentials lose value/trust
```

**Mitigations**:

| Level | Mitigation | Responsibility | Effectiveness |
|-------|-----------|-----------------|----------------|
| **Preventive** | Rate Limiting: Limit credentials per issuer per time period (e.g., 100/day) | System | ★★★★★ |
| **Preventive** | Capacity Planning: Set credential capacity per issuer during onboarding | Operator | ★★★★☆ |
| **Detective** | Anomaly Detection: Alert on 10x normal issuance rate | Operator | ★★★★☆ |
| **Detective** | Credential Quality Metrics: Track acceptance rate, revocation rate per issuer | Operator | ★★★★☆ |
| **Responsive** | Throttling: Auto-throttle issuer on rate anomalies | System | ★★★★☆ |

**Operational Checks**:
- Review issuance rates daily
- Investigate any issuer exceeding rate limits
- Set conservative initial rate limits for new issuers

---

## Attack Tree Summary

```
                        Credential Fraud
                              |
                ______________|_________
               |                       |
          Technical Attacks    Social/Operational Attacks
               |                       |
      ____     |     ____        ____   |   ____
     /    \    |    /    \      /    \  |  /    \
    | Fake | Tamper | Key  | Collusion| Mill | Theft |
    |Issuer| Mutate |Comp. | Attack  | Ops  | Reuse |
     \    /    |    \    /      \    /  |  \    /
      ‾‾‾‾     |     ‾‾‾‾        ‾‾‾‾   |   ‾‾‾‾
```

---

## Recommended Operator Actions

### Immediate (Week 1)

1. **Establish Issuer Vetting Process**
   - Document requirements for issuer registration (legal proof, domain ownership, KYC)
   - Create issuer onboarding checklist
   - Assign vetting authority

2. **Enable Audit Logging**
   - Ensure all credential issuances are logged
   - Set up log aggregation and backup
   - Document log retention policy (minimum 7 years)

3. **Create Incident Response Plan**
   - Define procedures for key compromise, fraud detection, revocation
   - Establish escalation path to legal/compliance
   - Create incident notification template

### Short-term (Month 1)

4. **Implement Rate Limiting**
   - Configure rate limits per issuer (conservative initial limits)
   - Set up monitoring/alerting for rate anomalies
   - Document limits per issuer tier

5. **Set Up Revocation System**
   - Test credential revocation procedure
   - Document revocation process
   - Create batch revocation templates

6. **Verifier Communication**
   - Publish guidance on verifier due diligence
   - Document required checks (on-chain verification, issuer registration)
   - Establish verifier feedback channel

### Medium-term (Quarter 1)

7. **Multi-Sig Issuance**
   - Pilot multi-sig requirement with willing issuers
   - Integrate into core issuer API
   - Document multi-sig setup

8. **Anomaly Detection**
   - Implement machine learning-based credential anomaly detection
   - Tune thresholds based on issuer baseline
   - Set up alerting pipeline

9. **Spot-Check Program**
   - Establish spot-check frequency (10% of high-value credentials)
   - Create spot-check checklist
   - Document findings and remediation

---

## Escalation Procedures

### Severity: Critical (Systemic Compromise)

**Trigger**: Evidence that multiple issuers are issuing fraudulent credentials or attacker has compromised system infrastructure.

**Response** (within 1 hour):
1. Alert incident response team
2. Halt new credential issuances (disable API endpoints if necessary)
3. Notify board/executives
4. Preserve evidence
5. Establish crisis communication channel

**Follow-up**:
- Root cause analysis
- Forensic investigation
- Determine scope of fraud
- Public disclosure plan

### Severity: High (Issuer Compromise)

**Trigger**: Single issuer demonstrates compromised signing key or unusually high fraud rate.

**Response** (within 4 hours):
1. Alert issuer technical contact
2. Revoke compromised key
3. Batch-revoke suspicious credentials
4. File incident report
5. Notify affected credential holders

**Follow-up**:
- Post-mortem with issuer
- Root cause investigation
- Re-onboarding if necessary

### Severity: Medium (Fraud Detection)

**Trigger**: Fraudulent credentials detected via spot-check or verifier feedback.

**Response** (within 24 hours):
1. Investigate specific credential and issuer
2. Determine if isolated or part of pattern
3. Contact issuer for explanation
4. Revoke fraudulent credentials if warranted
5. Monitor issuer for escalation

**Follow-up**:
- Increase spot-check frequency for affected issuer
- Review issuer controls

### Severity: Low (Operational Issue)

**Trigger**: Minor audit log inconsistency, rate limit exceeded once, etc.

**Response** (within 5 business days):
1. Investigate root cause
2. Document finding
3. Notify issuer if applicable
4. Update procedures if necessary

---

## Compliance & Regulatory Considerations

### Data Protection (GDPR, CCPA)
- Maintain separate audit trails for fraud investigation
- Ensure credential holders can request deletion of their data
- Provide breach notification within legal timeframe

### Know-Your-Customer (KYC)
- Implement KYC for issuer registration
- Maintain KYC records for audit
- Update KYC as issuer details change

### Anti-Fraud Regulations
- Comply with local anti-fraud/AML regulations
- Maintain suspicious activity reporting (SAR) procedures
- Document decision rationale for credential revocation

---

## References

- **Stellar Whitepaper**: https://stellar.org/papers/stellar-consensus-protocol.pdf
- **NIST Cybersecurity Framework**: https://www.nist.gov/cyberframework
- **OWASP Threat Modeling**: https://owasp.org/www-community/Threat_Modeling
- **Zero-Knowledge Proofs for Credential Verification**: [ZK_VERIFIER documentation in contracts/]

---

## Appendix: Glossary

| Term | Definition |
|------|-----------|
| **Attestor** | Entity that issues credentials (university, employer, etc.) |
| **Quorum Slice** | Personal trust network of multiple attestors for a credential holder |
| **SBT** | Soulbound Token — non-transferable on-chain credential |
| **Audit Log** | Immutable record of all credential issuances and revocations |
| **Verifier** | Entity that checks credentials to verify holder qualifications |
| **Fraud Vector** | Specific method by which an attacker could commit fraud |
| **Mitigation** | Control or procedure to reduce risk of fraud |

---

**Document Version**: 1.0  
**Last Updated**: July 2026  
**Next Review**: October 2026  
**Owner**: Security & Compliance Team
