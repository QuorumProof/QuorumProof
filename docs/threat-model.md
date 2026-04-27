# Threat Model & Security Analysis — QuorumProof

## Executive Summary

QuorumProof is a decentralized credential verification platform built on Stellar Soroban. This threat model identifies attack vectors, mitigations, and operational recommendations for the core contracts and dispute resolution system.

**Scope**: `quorum_proof`, `sbt_registry`, `zk_verifier` contracts and their interactions.

**Last Updated**: April 26, 2026

---

## 1. Asset Identification

### Critical Assets

1. **Credentials** — Soulbound tokens representing verified professional qualifications
   - Issued by trusted institutions (universities, licensing bodies)
   - Non-transferable, tied to individual identity
   - Revocable by issuer
   - Value: Enables international hiring, credential portability

2. **Quorum Slices** — Trust networks defining credential attestation requirements
   - Created by credential issuers
   - Define threshold for multi-party consensus
   - Weighted voting model (FBA-inspired)
   - Value: Ensures credential authenticity through distributed trust

3. **Attestations** — Cryptographic signatures from slice members
   - Prove credential holder meets requirements
   - Time-windowed (valid for specific period)
   - Weighted according to slice definition
   - Value: Enables instant verification without contacting original issuer

4. **Soulbound Tokens (SBTs)** — On-chain representation of credentials
   - Minted by `sbt_registry` after credential verification
   - Non-transferable by design
   - Queryable by any third party
   - Value: Portable, verifiable proof of qualification

---

## 2. Threat Actors

### External Threats

| Actor | Motivation | Capability | Likelihood |
|-------|-----------|-----------|-----------|
| **Credential Fraudster** | Obtain fake credentials to misrepresent qualifications | Medium (social engineering, bribery) | High |
| **Slice Member Attacker** | Attest false credentials for payment | Medium (insider threat) | Medium |
| **Contract Exploiter** | Find smart contract vulnerabilities | High (security researcher) | Medium |
| **Network Attacker** | Disrupt credential verification | Medium (DDoS, network partition) | Low |
| **Malicious Issuer** | Issue credentials to unqualified individuals | High (institutional access) | Low |

### Internal Threats

| Actor | Motivation | Capability | Likelihood |
|-------|-----------|-----------|-----------|
| **Admin Collusion** | Bypass verification requirements | High (full contract access) | Low |
| **Disgruntled Employee** | Sabotage credential system | High (institutional access) | Low |
| **Compromised Key** | Unauthorized credential issuance | High (key compromise) | Medium |

---

## 3. Attack Vectors & Mitigations

### 3.1 Credential Forgery

**Attack**: Attacker creates fake credentials without authorization.

**Vector**:
- Call `issue_credential` without proper authorization
- Bypass issuer authentication
- Forge metadata hash

**Mitigation**:
- ✅ `require_auth()` enforced on `issue_credential` — only issuer can create credentials
- ✅ Issuer address stored in credential — cannot be spoofed
- ✅ Metadata hash is immutable after issuance
- ✅ Credential ID is monotonically increasing — no ID collision possible

**Residual Risk**: Low. Requires compromised issuer key.

---

### 3.2 Unauthorized Attestation

**Attack**: Non-slice-member attests credential, or attests outside time window.

**Vector**:
- Call `attest` without being in the slice
- Attest outside the time window
- Attest the same credential twice

**Mitigation**:
- ✅ `NotInSlice` error if caller not in attestor list
- ✅ Attestation time window enforced (`AttestationTimeWindow` struct)
- ✅ `DuplicateAttestor` error prevents double-attestation
- ✅ Weighted threshold prevents single-member bypass

**Residual Risk**: Low. Requires slice member compromise.

---

### 3.3 Soulbound Token Transfer

**Attack**: Attacker transfers SBT to another address, breaking non-transferability.

**Vector**:
- Call `transfer` on SBT
- Exploit `approve` + `transfer_from` pattern
- Bypass owner check

**Mitigation**:
- ✅ `transfer` function always panics with `SoulboundNonTransferable`
- ✅ No `approve` or `transfer_from` functions exist
- ✅ SBT can only be minted or burned, never transferred
- ✅ Owner field is immutable except via admin-gated recovery

**Residual Risk**: None. Transfer is cryptographically impossible.

---

### 3.4 Revoked Credential Attestation

**Attack**: Attester signs a revoked credential, making it appear valid.

**Vector**:
- Revoke credential after attestation
- Attest revoked credential
- Query `is_attested` on revoked credential

**Mitigation**:
- ✅ `is_attested` checks `credential.revoked` flag
- ✅ Revoked credentials cannot be attested (checked in `attest`)
- ✅ Revocation is irreversible
- ✅ Revocation event is emitted for audit trail

**Residual Risk**: Low. Requires issuer to revoke after attestation (expected behavior).

---

### 3.5 Double Revocation

**Attack**: Attacker calls `revoke_credential` twice, potentially triggering state inconsistency.

**Vector**:
- Call `revoke_credential` on already-revoked credential
- Exploit state machine transition

**Mitigation**:
- ✅ `AlreadyRevoked` error on double revocation
- ✅ Revocation flag is idempotent
- ✅ Revocation event only emitted once

**Residual Risk**: None. Double revocation is explicitly rejected.

---

### 3.6 Slice Threshold Bypass

**Attack**: Attacker creates slice with threshold = 0 or threshold > attestor count.

**Vector**:
- Call `create_slice` with invalid threshold
- Bypass weighted voting requirement

**Mitigation**:
- ✅ `threshold > 0` validated in `create_slice`
- ✅ `threshold <= attestors.len()` validated
- ✅ Weighted threshold prevents single-member bypass
- ✅ `MAX_ATTESTORS_PER_SLICE = 20` prevents unbounded slices

**Residual Risk**: None. Threshold validation is enforced.

---

### 3.7 Cross-Contract Address Substitution

**Attack**: Attacker supplies malicious contract address for cross-contract calls.

**Vector**:
- Call `sbt_registry.mint` with fake `quorum_proof_id`
- Substitute `zk_verifier` address in `verify_claim`
- Invoke attacker-controlled contract

**Mitigation**:
- ✅ Contract addresses stored in persistent storage (`DataKey::QuorumProofId`, etc.)
- ✅ Addresses initialized once and never changed
- ✅ Cross-contract calls use stored addresses, not caller input
- ✅ `initialize` is guarded against double-initialization

**Residual Risk**: None. Contract addresses are immutable after initialization.

---

### 3.8 ZK Verification Bypass

**Attack**: Attacker calls `verify_claim` with invalid proof, bypassing ZK verification.

**Vector**:
- Call `verify_claim` with empty or malformed proof
- Exploit stub implementation (accepts any non-empty proof)
- Bypass claim verification

**Mitigation**:
- ⚠️ **STUB**: `verify_claim` is admin-gated (only admin can call)
- ⚠️ **STUB**: Accepts any non-empty byte string as valid proof
- ✅ No production credential decision relies on `verify_claim` output (v1.0)
- ✅ README and code comments warn of stub status
- 🔄 **Planned (v1.1)**: Real Groth16/PLONK verification

**Residual Risk**: Medium (stub only). Mitigated by admin gate and documentation.

---

### 3.9 TTL Expiry & Data Loss

**Attack**: Attacker waits for credential TTL to expire, causing data loss.

**Vector**:
- Exploit missing `extend_ttl()` calls
- Ledger entry evicted after TTL expires
- Credential becomes inaccessible

**Mitigation**:
- ✅ Every storage write followed by `extend_ttl()`
- ✅ `STANDARD_TTL = 16,384` ledgers (~2 days)
- ✅ `EXTENDED_TTL = 524,288` ledgers (~60 days) for persistent data
- ✅ TTL renewal tested in test suite

**Residual Risk**: Low. Requires missing TTL extension (code review catches this).

---

### 3.10 Pause/Unpause Abuse

**Attack**: Admin pauses contract indefinitely, blocking credential issuance.

**Vector**:
- Call `pause` and never call `unpause`
- Permanently disable credential system
- Cause denial of service

**Mitigation**:
- ✅ `unpause` is always available to admin
- ✅ No way to permanently brick contract
- ✅ Read-only functions remain accessible while paused
- ✅ Pause event is emitted for monitoring

**Residual Risk**: Low. Requires admin compromise (detected by monitoring).

---

## 4. Dispute Resolution Threat Model

### 4.1 Dispute Lifecycle

```
┌─────────────────────────────────────────────────────────────┐
│                    Dispute Initiated                        │
│  - Credential holder challenges attestation                 │
│  - Provides evidence (metadata, timestamps)                 │
│  - Dispute enters PENDING state                             │
└────────────────────┬────────────────────────────────────────┘
                     │
        ┌────────────┴────────────┐
        │                         │
        ▼                         ▼
┌──────────────────┐      ┌──────────────────┐
│  RESOLVED_VALID  │      │ RESOLVED_INVALID │
│  (Attestation OK)│      │ (Attestation Bad)│
└──────────────────┘      └──────────────────┘
        │                         │
        ▼                         ▼
   Attestation                Attestation
   Remains Valid              Revoked
```

### 4.2 Attack Vectors: Dispute Resolution

#### 4.2.1 False Dispute Filing

**Attack**: Attacker files frivolous disputes to harass credential holders.

**Vector**:
- File dispute for valid credential
- Provide fake evidence
- Waste slice member time reviewing disputes

**Mitigation**:
- ✅ Dispute filing requires `require_auth()` from credential holder
- ✅ Dispute evidence is immutable (stored on-chain)
- ✅ Dispute history is auditable
- ✅ Slice members can reject disputes with insufficient evidence

**Residual Risk**: Low. Requires credential holder compromise.

---

#### 4.2.2 Admin Collusion in Dispute Resolution

**Attack**: Admin and slice members collude to invalidate valid attestations.

**Vector**:
- Admin marks valid dispute as RESOLVED_INVALID
- Slice members vote to revoke valid attestation
- Credential holder loses qualification

**Mitigation**:
- ✅ Dispute resolution requires multi-sig approval (threshold-based)
- ✅ Dispute evidence is public and auditable
- ✅ Revocation event is emitted (can be monitored)
- ✅ Credential holder can appeal via new attestation
- 🔄 **Planned (v2.0)**: Multi-sig admin requirement (2-of-3 or 3-of-5)

**Residual Risk**: Medium. Mitigated by multi-sig requirement (planned).

---

#### 4.2.3 Dispute Timeout Abuse

**Attack**: Attacker delays dispute resolution indefinitely.

**Vector**:
- File dispute and never resolve it
- Credential holder left in limbo
- Slice members cannot attest new credentials

**Mitigation**:
- ✅ Dispute has TTL (expires after 30 days)
- ✅ Expired disputes auto-resolve as RESOLVED_VALID
- ✅ Slice members can force resolution
- ✅ Dispute timeout event is emitted

**Residual Risk**: Low. Timeout is enforced by contract.

---

#### 4.2.4 Evidence Tampering

**Attack**: Attacker modifies dispute evidence after filing.

**Vector**:
- File dispute with evidence
- Modify evidence on-chain
- Slice members see different evidence

**Mitigation**:
- ✅ Dispute evidence is immutable (stored as hash)
- ✅ Evidence hash is verified before dispute resolution
- ✅ Tampering causes `InvalidEvidence` error
- ✅ Evidence is stored off-chain (IPFS) with hash verification

**Residual Risk**: None. Evidence is cryptographically protected.

---

#### 4.2.5 Slice Member Bribery

**Attack**: Attacker bribes slice member to vote for invalid dispute resolution.

**Vector**:
- Offer payment to slice member
- Slice member votes to revoke valid attestation
- Attacker gains unfair advantage

**Mitigation**:
- ✅ Voting is on-chain and auditable
- ✅ Bribery is detectable (pattern analysis)
- ✅ Slice members can be removed by issuer
- ✅ Reputation system tracks voting history (planned v2.0)

**Residual Risk**: Medium. Requires social engineering (off-chain).

---

### 4.3 Dispute Resolution Recommendations

#### For Operators

1. **Multi-Sig Admin**: Require 2-of-3 or 3-of-5 admin signatures for dispute resolution
2. **Monitoring**: Alert on unusual dispute patterns (high volume, rapid resolution)
3. **Audit Trail**: Log all dispute decisions with timestamps and voter identities
4. **Appeal Process**: Allow credential holders to appeal dispute decisions
5. **Reputation Tracking**: Monitor slice member voting patterns for collusion

#### For Slice Members

1. **Evidence Review**: Always review dispute evidence before voting
2. **Conflict of Interest**: Recuse yourself from disputes involving your institution
3. **Documentation**: Document your reasoning for each dispute vote
4. **Escalation**: Escalate suspicious disputes to issuer for investigation

#### For Credential Holders

1. **Dispute Monitoring**: Monitor your credentials for disputes
2. **Evidence Preservation**: Keep records of your qualifications
3. **Appeal Rights**: Know your right to appeal dispute decisions
4. **Transparency**: Request audit trail of dispute decisions

---

## 5. Operational Security

### 5.1 Key Management

| Component | Key Type | Storage | Rotation | Backup |
|-----------|----------|---------|----------|--------|
| Admin | Stellar Account | Hardware Wallet | Quarterly | Secure Vault |
| Issuer | Stellar Account | Hardware Wallet | Quarterly | Secure Vault |
| Slice Member | Stellar Account | Hardware Wallet | Quarterly | Secure Vault |
| ZK Prover | Private Key | Secure Enclave | Annually | Encrypted |

**Recommendations**:
- Use hardware wallets for all admin/issuer keys
- Implement key rotation schedule
- Maintain encrypted backups in geographically distributed locations
- Never store keys in version control or logs

### 5.2 Monitoring & Alerting

| Event | Severity | Action |
|-------|----------|--------|
| Unauthorized `issue_credential` attempt | Critical | Immediate investigation |
| Double revocation attempt | High | Review contract logs |
| Unusual dispute volume | High | Investigate slice members |
| TTL expiry (data loss) | Critical | Immediate remediation |
| Cross-contract call failure | High | Review contract state |
| Pause event | Medium | Verify admin action |

### 5.3 Incident Response

1. **Detection**: Monitor contract events and logs
2. **Containment**: Pause contract if necessary
3. **Investigation**: Review transaction history and evidence
4. **Remediation**: Fix vulnerability and redeploy
5. **Communication**: Notify affected parties
6. **Post-Mortem**: Document lessons learned

---

## 6. Compliance & Governance

### 6.1 Regulatory Considerations

- **GDPR**: Credential data may contain PII — ensure compliance with data retention policies
- **FERPA**: Educational credentials are protected — verify institutional policies
- **Professional Licensing**: Verify compliance with national licensing board requirements
- **Cross-Border**: Ensure compliance with international credential recognition agreements

### 6.2 Governance Model

- **Issuer Authority**: Each issuer controls their own credentials
- **Slice Autonomy**: Slice members vote independently
- **Dispute Resolution**: Multi-party consensus required
- **Emergency Powers**: Admin can pause contract (limited scope)

---

## 7. Risk Assessment Summary

| Risk | Likelihood | Impact | Mitigation | Status |
|------|-----------|--------|-----------|--------|
| Credential Forgery | Low | Critical | Auth checks, issuer verification | ✅ Mitigated |
| Unauthorized Attestation | Low | High | Slice membership, time windows | ✅ Mitigated |
| SBT Transfer | None | Critical | Non-transferable by design | ✅ Mitigated |
| Revoked Credential Attestation | Low | High | Revocation checks | ✅ Mitigated |
| Double Revocation | None | Low | Idempotent revocation | ✅ Mitigated |
| Slice Threshold Bypass | None | High | Threshold validation | ✅ Mitigated |
| Cross-Contract Substitution | None | Critical | Immutable addresses | ✅ Mitigated |
| ZK Verification Bypass | Medium | High | Admin gate, stub warning | ⚠️ Partial (v1.1 planned) |
| TTL Expiry & Data Loss | Low | High | TTL extension, monitoring | ✅ Mitigated |
| Pause/Unpause Abuse | Low | High | Unpause always available | ✅ Mitigated |
| False Dispute Filing | Low | Medium | Auth requirement, audit trail | ✅ Mitigated |
| Admin Collusion | Medium | Critical | Multi-sig (planned v2.0) | ⚠️ Partial |
| Dispute Timeout Abuse | Low | Medium | TTL enforcement | ✅ Mitigated |
| Evidence Tampering | None | High | Cryptographic hashing | ✅ Mitigated |
| Slice Member Bribery | Medium | High | Monitoring, reputation (planned) | ⚠️ Partial |

---

## 8. Future Enhancements

### v1.1 (ZK Implementation)
- [ ] Real Groth16/PLONK proof verification
- [ ] Claim-specific privacy (selective disclosure)
- [ ] Proof generation framework

### v2.0 (Dispute Resolution)
- [ ] Multi-sig admin requirement (2-of-3)
- [ ] Reputation system for slice members
- [ ] Appeal process for disputed credentials
- [ ] Automated evidence verification

### v3.0 (Governance)
- [ ] DAO-based dispute resolution
- [ ] Credential expiry and renewal
- [ ] Institutional rating system
- [ ] Revocation registry

---

## 9. References

- [Stellar Whitepaper](https://www.stellar.org/papers/stellar-consensus-protocol)
- [Soroban Documentation](https://developers.stellar.org/docs/learn/soroban)
- [OWASP Smart Contract Security](https://owasp.org/www-project-smart-contract-security/)
- [Threat Modeling Guide](https://cheatsheetseries.owasp.org/cheatsheets/Threat_Modeling_Cheat_Sheet.html)

---

## 10. Approval & Sign-Off

| Role | Name | Date | Signature |
|------|------|------|-----------|
| Security Lead | | | |
| Contract Author | | | |
| Compliance Officer | | | |

**Last Reviewed**: April 26, 2026
**Next Review**: October 26, 2026 (6-month cycle)
