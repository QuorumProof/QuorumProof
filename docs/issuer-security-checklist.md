# Issuer Security Checklist

Issuers hold the highest-value keys in the QuorumProof system: an issuer
key can mint credentials, revoke them, and initiate holder recovery. A
compromised issuer key does more damage than almost any other failure mode
in the protocol (see [Threat Model §2 — Threat Actors](threat-model.md#2-threat-actors)
and [Risk Assessment Summary](threat-model.md#7-risk-assessment-summary)).
This checklist gives issuing institutions a concrete set of operational
security requirements to follow, organized by threat severity, with links
to the underlying threat model entries that justify each control.

This document is operational guidance for institutions *using* QuorumProof
as issuers. It is distinct from
[Security Audit Checklist](security-audit-checklist.md), which is for
auditors reviewing the contract code itself, and from
[Security Best Practices](security-best-practices.md), which covers the
protocol broadly.

---

## How to use this document

Work through each section and check off items before going live on
mainnet. Re-run the full checklist after any change to signing
infrastructure, personnel, or credential-issuance volume. Items marked
**(Critical)** must be resolved before issuing any mainnet credential;
items marked **(High)** should be resolved within the first issuance
cycle; **(Medium)** and **(Low)** items are ongoing hardening.

---

## 1. Key Management

- [ ] **(Critical)** Issuer signing keys are generated and stored in an
      HSM or equivalent hardware-backed key store — never as a plaintext
      seed phrase in application config, a `.env` file, or source control.
- [ ] **(Critical)** No single person has unilateral access to the issuer
      key material. Use a multi-party custody solution (threshold
      signatures or a hardware approval quorum) for any issuer signing
      volume above trivial testnet usage.
- [ ] **(Critical)** Key backup material (seed shares, HSM export) is
      stored encrypted, offline, and split across at least two physically
      separate locations.
- [ ] **(High)** Key rotation procedure is documented and rehearsed. When
      rotating, revoke the old key's operational access *before*
      publicizing the new issuer address, to avoid a window where both
      keys are trusted in downstream systems.
- [ ] **(High)** Signing keys used for testnet are never reused on
      mainnet, and vice versa.
- [ ] **(Medium)** Key usage is rate-limited at the infrastructure layer
      (e.g. a signing proxy) so a compromised application cannot mint an
      unbounded number of credentials before detection.

**Relevant threat model entries:** Credential Forgery (Critical impact),
Admin Collusion (Critical impact) — see
[Risk Assessment Summary](threat-model.md#7-risk-assessment-summary).

---

## 2. Access Control

- [ ] **(Critical)** The application backend that calls `issue_credential`
      / `revoke_credential` runs behind authentication and authorization
      that mirrors the on-chain issuer role — a compromised internal
      account should not be able to trigger issuance without a second
      layer of approval.
- [ ] **(Critical)** Production credentials (RPC API keys, signing service
      tokens, database credentials) are stored in a secrets manager, not
      in environment files checked into version control or shared over
      chat.
- [ ] **(High)** Staff who can trigger issuance/revocation are limited to
      a named, reviewed list; access is revoked immediately on role change
      or offboarding.
- [ ] **(High)** Recovery initiation (`initiate_recovery`) requires the
      same approval workflow as issuance, since it can redirect a
      credential to a new subject address.
- [ ] **(Medium)** Separate least-privilege service accounts are used for
      issuance, revocation, and read-only verification integrations — a
      verifier integration should never hold issuer signing capability.
- [ ] **(Medium)** Break-glass / emergency-pause access
      (`pause`/`unpause`) is restricted to a small on-call group distinct
      from day-to-day issuance staff.

**Relevant threat model entries:** Unauthorized Attestation, Pause/Unpause
Abuse — see [Attack Vectors & Mitigations](threat-model.md#3-attack-vectors--mitigations).

---

## 3. Audit Logging

- [ ] **(Critical)** Every issuance, revocation, and suspension performed
      by the issuer's backend is logged with: acting principal, timestamp,
      credential ID, subject, and the reason/justification supplied.
      Cross-reference the on-chain event fields in
      [Audit Log Format](audit-log-format.md) so off-chain and on-chain
      records can be reconciled.
- [ ] **(High)** Audit logs are append-only (write-once storage or a
      hash-chained log) so a compromised backend cannot retroactively
      hide its own actions.
- [ ] **(High)** Alerts fire on anomalous issuance patterns — a burst of
      issuances outside business hours, issuance to a previously unseen
      batch of subjects, or repeated `DuplicateCredential` (`#4`) errors
      that could indicate probing.
- [ ] **(Medium)** Audit logs are retained for at least as long as the
      credential validity period (see `expires_at` semantics), and
      exported into the backup pipeline described in
      [Backup System](backup-system.md) so they survive a backend
      failure.
- [ ] **(Low)** Periodic reconciliation jobs compare the issuer's local
      audit log against on-chain `CredentialIssued`/`CredentialRevoked`
      events to detect drift or missed writes.

**Relevant threat model entries:** Evidence Tampering, Evidence Forgery —
see [Attack Vectors & Mitigations](threat-model.md#3-attack-vectors--mitigations).

---

## 4. Security Recommendations by Threat Level

Mapped from [Threat Model — Risk Assessment Summary](threat-model.md#7-risk-assessment-summary):

### Critical impact risks
*Credential Forgery, SBT Transfer, Cross-Contract Substitution, Admin
Collusion, Dispute Resolution Collusion.*
- Treat issuer key compromise as an incident requiring immediate
  `pause()` and credential-holder communication, not a routine rotation.
- Require dual control (two-person rule) for any admin-level action,
  including pause/unpause and recovery approval.

### High impact risks
*Unauthorized Attestation, Revoked Credential Attestation, ZK Verification
Bypass, TTL Expiry & Data Loss, Pause/Unpause Abuse, Slice Member Bribery,
Evidence Tampering, SBT Minting Without Attestation.*
- Monitor attestation and revocation events in near-real-time (see
  [Monitoring Guide](monitoring-guide.md)); high-impact risks are the ones
  where minutes of delay in detection matter most.
- Do not rely solely on the ZK verifier stub for access decisions until it
  is out of stub status (`v1.1`) — treat it as advisory, not authoritative,
  per [Threat Model §5](threat-model.md#5-recent-features-threat-analysis-v10).

### Medium impact risks
*False Dispute Filing, Metadata Availability Loss, Dispute Spam, SBT
Metadata Manipulation.*
- Pin credential metadata (IPFS) with a redundant pinning service; a
  metadata availability loss degrades verifiability even though the
  on-chain hash is intact.
- Rate-limit dispute filing at the application layer in addition to the
  contract's own protections.

### Low impact risks
*Double Revocation, Slice Threshold Bypass, Dispute Timeout Abuse, SBT
Burning & Re-minting.*
- These are already mitigated at the contract level; issuer-side controls
  here are limited to standard logging and periodic review rather than
  dedicated tooling.

---

## 5. Sign-Off

Before issuing on mainnet, confirm:

- [ ] All **Critical** items above are checked off.
- [ ] All **High** items above are checked off or have a documented
      remediation timeline.
- [ ] This checklist has been reviewed against the current
      [Threat Model](threat-model.md) (re-check after any threat model
      revision).
- [ ] The issuer's incident response contact is registered per
      [SECURITY.md](../SECURITY.md).

---

## Related Documentation

- [Threat Model & Security Analysis](threat-model.md)
- [Security Best Practices](security-best-practices.md)
- [Security Audit Checklist](security-audit-checklist.md)
- [Audit Log Format](audit-log-format.md)
- [Backup System](backup-system.md)
- [Monitoring Guide](monitoring-guide.md)
