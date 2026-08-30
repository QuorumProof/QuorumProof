# Threat Model & Security Analysis — QuorumProof

## Executive Summary

QuorumProof is a decentralized credential verification platform built on Stellar Soroban. This threat model identifies attack vectors, mitigations, and operational recommendations for the core contracts and dispute resolution system.

**Scope**: `quorum_proof`, `sbt_registry`, `zk_verifier` contracts and their interactions.

**Last Updated**: August 30, 2026

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

## 3.11 Selective Disclosure (BBS+)

BBS+ signatures (`contracts/bbs_plus_v1`) allow a credential holder to derive a presentation proof that reveals only a chosen subset of credential attributes to a verifier while keeping the rest hidden. This capability significantly reduces data exposure per interaction, but it also introduces a new class of attack vectors that do not exist with conventional (all-or-nothing) signature schemes.

**Background**: Each call to `BbsPresentation::create_presentation` re-randomizes the underlying signature commitment, so presentations of the same underlying credential are cryptographically unlinkable to one another. This is a core design goal documented in [ADR-007](adr/adr-007-bbs-plus-selective-disclosure.md) and explained in the [BBS+ Tutorial](bbs-plus-tutorial.md#5-privacy-guarantees). The attack vectors below are the situations where that protection can be circumvented or is insufficient on its own.

---

### 3.11.1 Reveal Correlation Across Verifiers

**Attack**: A single verifier (or colluding verifiers) accumulates multiple partial-disclosure presentations from the same holder over time. Even though each proof is individually unlinkable at the cryptographic layer, the *semantic content* of disclosed attributes can be correlated to reconstruct the full credential or to re-identify the holder.

**Example**: A holder discloses `institution` to Verifier A, `graduation_year` to Verifier B, and `license_number` to Verifier C. If A, B, and C share their logs, the union of three partial disclosures may uniquely identify the holder and reconstruct most of the original credential.

**Preconditions**: Verifier(s) log the disclosed attribute values alongside any external session identifier (IP address, wallet address, request timestamp).

**Impact**: Erosion of selective-disclosure privacy guarantees; credential-holder re-identification without ever receiving the full credential.

**Mitigations**:
- ✅ Cryptographic unlinkability per presentation — `bbs_plus_v1` re-randomizes the signature commitment, so proof bytes themselves carry no cross-verifier correlation signal (see `contracts/bbs_plus_v1/src/presentation.rs`)
- ✅ Holders are advised in [BBS+ Tutorial §5](bbs-plus-tutorial.md#5-privacy-guarantees) that metadata outside the proof (IP, wallet address, timing) is a separate correlation channel
- ⚠️ **Gap**: No protocol-level binding prevents a verifier from logging and sharing the cleartext disclosed values — this is a verifier policy gap, not a cryptographic one
- 🔄 **Recommended (not yet implemented)**: Verifier data-minimization policy: verifiers SHOULD be contractually required (via issuer terms of service) to discard disclosed attributes after verification completes and to not share them with third parties; document this requirement in the verifier onboarding checklist (see `docs/issuer-security-checklist.md`)
- 🔄 **Recommended (not yet implemented)**: Per-verifier nonce binding — require verifiers to supply a fresh nonce in each presentation request; the holder embeds it in the proof so the same presentation cannot be replayed to a different verifier even if intercepted

**Residual Risk**: Medium. Cryptographic layer is sound; risk lives entirely in verifier behavior and metadata channels outside the contract's control.

---

### 3.11.2 Replay of a Disclosed Proof

**Attack**: An adversary intercepts or obtains a valid `PresentationProof` (e.g. from a network transcript, a compromised verifier's database, or a holder who inadvertently shares proof bytes) and replays it to a different verifier or in a different context to impersonate the credential holder.

**Preconditions**: The proof was captured after it was generated but before or during transmission to the intended verifier. No verifier-specific binding was embedded in the proof.

**Impact**: Impersonation — a third party uses a stolen proof to pass as the credential holder for a one-time verification check.

**Mitigations**:
- ✅ Presentations derived by `contracts/bbs_plus_v1` are valid zero-knowledge proofs of issuer signature knowledge; they do not by themselves bind the prover to a specific verifier session — this is a known gap in the base BBS+ IETF draft that is expected to be addressed via a verifier-supplied presentation nonce
- ⚠️ **Gap: not yet implemented** — the current `verify_presentation` entry point does not enforce that a verifier-supplied nonce was embedded in the proof at derivation time; a captured proof is replayable to any verifier that accepts presentations for the same credential type
- 🔄 **Recommended (not yet implemented)**: Mandatory verifier nonce flow: the verifier generates a single-use challenge nonce, sends it to the holder, and the holder calls `create_presentation` with the nonce bound into the Fiat-Shamir transcript (via `contracts/bbs_plus_v1/src/transcript.rs`); `verify_presentation` then checks the nonce matches — this is tracked as a follow-up implementation item for `contracts/bbs_plus_v1`
- 🔄 **Recommended (not yet implemented)**: Short-lived proof TTL — presentations should carry an expiry field so that a captured proof becomes useless after a configurable window (e.g. 5 minutes); this requires a coordinated clock between holder and verifier

**Residual Risk**: Medium (gap not yet implemented). Until nonce binding is enforced in `bbs_plus_v1`, captured presentations are replayable. Operators should deploy the contract in contexts where transport-layer security (TLS) reduces interception risk.

---

### 3.11.3 Verifier Collusion to Reconstruct Full Attributes

**Attack**: Multiple independent verifiers, each receiving a different partial disclosure of the same credential over time, share their received attribute values to jointly reconstruct the full attribute set — effectively undoing the holder's selective disclosure choices.

**Preconditions**: Two or more verifiers that have each received at least one presentation from the same holder, and who collude (or whose databases are compromised together) to pool disclosed values.

**Impact**: Full credential reconstruction without the holder's consent; severe privacy violation equivalent to receiving the full credential upfront.

**Mitigations**:
- ✅ Cryptographic proof bytes are unlinkable across presentations — verifiers cannot prove to each other that two separate presentations came from the same underlying credential without the holder's cooperation (see `contracts/bbs_plus_v1/src/presentation.rs` re-randomization)
- ✅ The [BBS+ Tutorial §3.3](bbs-plus-tutorial.md#33-multi-credential-disclosure) notes that cross-credential linking is not automatic and requires an explicit holder-committed pseudonym
- ⚠️ **Gap**: If a holder discloses the *same* attribute (e.g. `institution` = "Acme Institute") to multiple verifiers, the plaintext value itself is the correlation signal — no cryptographic property prevents semantic join
- ⚠️ **Gap**: If a holder uses the same wallet address (Stellar account) across all verifier interactions, that address becomes an out-of-band linking identifier irrespective of proof unlinkability
- 🔄 **Recommended (not yet implemented)**: Holder pseudonym / pairwise DID pattern — use a different Stellar account or a cryptographic pseudonym per verifier relationship so the on-chain address does not serve as a correlation handle; document this pattern in `docs/privacy-guide.md`
- 🔄 **Recommended (not yet implemented)**: Minimum-disclosure policy enforcement at the application layer — the holder's wallet/SDK should warn when a verifier requests more attributes than the stated purpose requires; track in SDK roadmap

**Residual Risk**: Medium. Cryptographic unlinkability holds at the proof level; correlation via attribute semantics and wallet identity is a deployment and policy concern outside the scope of `bbs_plus_v1` itself.

---

### 3.11.4 Revocation Check Linkability

**Attack**: A holder presents a BBS+ proof and a verifier checks the revocation accumulator (`contracts/bbs_plus_v1/src/accumulator.rs`) using a credential-specific identifier. If the revocation check is done naively (e.g. by querying a public list keyed by credential ID), the verifier — or an observer of the on-chain query — can link the holder's presentation to a specific credential, breaking the unlinkability guarantee that BBS+ provides for the proof itself.

**Preconditions**: Verifier or on-chain observer correlates the revocation lookup with the presentation proof submission.

**Impact**: Re-identification of the credential holder via the revocation channel, even when the BBS+ proof is cryptographically unlinkable.

**Mitigations**:
- ✅ `contracts/bbs_plus_v1/src/accumulator.rs` implements a cryptographic accumulator supporting non-membership proofs — the holder can prove their credential is not revoked *without* revealing which specific credential is being checked (see [ADR-007 — Implementation Notes](adr/adr-007-bbs-plus-selective-disclosure.md#implementation-notes))
- ✅ The [BBS+ Tutorial §5](bbs-plus-tutorial.md#5-privacy-guarantees) explicitly documents revocation-check linkability as a known risk and points to the accumulator as the mitigation
- ⚠️ **Gap**: Integration of the accumulator non-membership proof into the end-to-end `verify_presentation` flow is listed as Phase 1 work in `contracts/bbs_plus_v1/README.md`; until that integration is complete, verifiers that use the accumulator directly may inadvertently reintroduce linkability
- 🔄 **Recommended (not yet implemented)**: Gate `verify_presentation` on an accumulator non-membership proof being included in the `PresentationProof` structure, so that revocation checking and presentation verification are bundled into a single unlinkable on-chain call

**Residual Risk**: Medium (gap not yet fully integrated). Operators should not deploy separate revocation lookups by credential ID until the accumulator integration is complete.

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
- Provide fake or insufficient evidence
- Waste slice member time reviewing disputes

**Mitigation**:
- ✅ Dispute filing requires `require_auth()` from the credential holder — third parties cannot file on their behalf
- ✅ Dispute evidence is required at filing time and stored immutably on-chain (cannot be added retroactively)
- ✅ Evidence must include: credential ID, dispute reason, supporting metadata hash, and timestamp
- ✅ Slice members can reject disputes with insufficient evidence before voting begins
- ✅ Dispute history is permanently auditable — repeated frivolous filers are identifiable
- ✅ Dispute filing is rate-limited per credential (one active dispute at a time)

**Residual Risk**: Low. Requires credential holder compromise; evidence requirements deter frivolous filings.

---

#### 4.2.2 Admin Collusion in Dispute Resolution

**Attack**: Admin and slice members collude to invalidate valid attestations.

**Vector**:
- Admin marks valid dispute as RESOLVED_INVALID
- Slice members vote to revoke valid attestation
- Credential holder loses qualification

**Mitigation**:
- ✅ Dispute resolution requires multi-sig approval (threshold-based voting)
- ✅ Dispute evidence is public and auditable on-chain
- ✅ Revocation event is emitted (can be monitored by any party)
- ✅ Credential holder can appeal via new attestation from a different slice
- ✅ **Operator requirement**: Deploy admin as a multisig account (2-of-3 or 3-of-5 Stellar multisig) — see Section 4.3 recommendations
- 🔄 **Planned (v2.0)**: On-chain multi-sig admin enforcement via contract logic

**Residual Risk**: Medium. Operators must configure Stellar account-level multisig for admin keys (see Section 4.3).

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

1. **Multi-Sig Admin (Required)**: Configure the admin Stellar account as a multisig with at least 2-of-3 signers before deploying to mainnet. Use `stellar account set-options --master-weight 0 --med-threshold 2 --high-threshold 2 --signer <key2>,1 --signer <key3>,1`. This prevents single-key compromise from resolving disputes unilaterally.
2. **Dispute Evidence Requirements**: Enforce that disputes include a metadata hash pointing to off-chain evidence (IPFS or equivalent). Reject disputes with empty or placeholder evidence hashes at the application layer.
3. **Monitoring**: Alert on unusual dispute patterns — high volume from a single address, rapid resolution (< 1 hour), or disputes filed and resolved by overlapping slice members.
4. **Audit Trail**: Log all dispute decisions with timestamps, voter identities, and evidence hashes. Retain logs for at least 2 years.
5. **Appeal Process**: Allow credential holders to re-attest via a different quorum slice after a dispute resolves against them. Document this process for credential holders.
6. **Reputation Tracking**: Monitor slice member voting patterns. Flag members who consistently vote with the majority on disputed cases for manual review (planned v2.0 on-chain reputation system).

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

## 5. Recent Features Threat Analysis (v1.0+)

### 5.1 Weighted Attestation Threshold

**Feature**: Quorum slices now support weighted voting where each attestor has a configurable weight, and a threshold must be met by the sum of weights.

**New Attack Vectors**:

#### 5.1.1 Weight Manipulation

**Attack**: Attacker creates slice with unbalanced weights to bypass threshold.

**Vector**:
- Create slice with 10 attestors, each weight=1, threshold=1
- Single attestor can attest credential
- Defeats purpose of multi-party consensus

**Mitigation**:
- ✅ Threshold validation: `threshold <= sum(weights)` enforced
- ✅ Threshold must be > 0 (prevents zero-threshold slices)
- ✅ `MAX_ATTESTORS_PER_SLICE = 20` prevents unbounded slices
- ✅ Slice creator is responsible for threshold design
- ✅ Slice configuration is immutable after creation

**Residual Risk**: Low. Requires slice creator to intentionally misconfigure (detectable via audit).

**Recommendation**: Document best practices for threshold selection (e.g., require 2-of-3 or 3-of-5 minimum).

---

#### 5.1.2 Attestor Weight Overflow

**Attack**: Attacker supplies weights that overflow u32, causing incorrect threshold calculation.

**Vector**:
- Create slice with weights summing to > u32::MAX
- Threshold calculation wraps around
- Threshold becomes achievable with fewer attestors

**Mitigation**:
- ✅ Weights are u32 (max 4,294,967,295 per attestor)
- ✅ Sum of weights checked against threshold (u32)
- ✅ Rust type system prevents overflow in safe code
- ✅ Test suite includes overflow edge cases

**Residual Risk**: None. Type system prevents overflow.

---

### 5.2 Credential Metadata Hashing

**Feature**: Credentials now store metadata as immutable hashes (IPFS CID or SHA-256).

**New Attack Vectors**:

#### 5.2.1 Hash Collision

**Attack**: Attacker finds two different metadata documents with the same hash.

**Vector**:
- Issue credential with metadata hash H
- Attacker finds different metadata with hash H
- Credential appears to have different content

**Mitigation**:
- ✅ SHA-256 used (collision resistance: 2^128 operations)
- ✅ IPFS CID uses SHA-256 by default
- ✅ Collision probability negligible for practical purposes
- ✅ Metadata stored off-chain (IPFS) — on-chain only stores hash

**Residual Risk**: Negligible (cryptographic guarantee).

---

#### 5.2.2 Metadata Availability Loss

**Attack**: Attacker deletes metadata from IPFS, making credential unverifiable.

**Vector**:
- Issue credential with IPFS CID
- Attacker removes file from IPFS
- Credential hash exists but metadata is gone

**Mitigation**:
- ✅ Metadata stored on IPFS (distributed, replicated)
- ✅ Issuer responsible for pinning metadata
- ✅ Credential holder can re-pin metadata
- ✅ Hash verification ensures integrity (cannot be replaced with different content)
- 🔄 **Planned (v2.0)**: Mandatory metadata pinning service

**Residual Risk**: Medium. Requires IPFS infrastructure maintenance.

**Recommendation**: Operators should run IPFS pinning service or use Pinata/Filecoin for redundancy.

---

### 5.3 Dispute Resolution System

**Feature**: Credentials can now be disputed by holders, with evidence-based resolution.

**New Attack Vectors**:

#### 5.3.1 Dispute Spam

**Attack**: Attacker files many disputes to overwhelm slice members.

**Vector**:
- File 100 disputes in rapid succession
- Slice members cannot review all evidence
- Valid disputes get lost in noise

**Mitigation**:
- ✅ Dispute filing requires `require_auth()` from credential holder
- ✅ One active dispute per credential at a time
- ✅ Dispute TTL (30 days) prevents indefinite accumulation
- ✅ Dispute evidence is required at filing time
- ✅ Slice members can reject disputes with insufficient evidence

**Residual Risk**: Low. Rate limiting and evidence requirements deter spam.

**Recommendation**: Implement application-level rate limiting (e.g., max 5 disputes per holder per month).

---

#### 5.3.2 Dispute Resolution Collusion

**Attack**: Slice members collude to invalidate valid credentials.

**Vector**:
- Multiple slice members vote to resolve dispute as INVALID
- Valid credential is revoked
- Credential holder has no recourse

**Mitigation**:
- ✅ Dispute resolution requires threshold-based voting
- ✅ Dispute evidence is public and auditable
- ✅ Revocation event is emitted (can be monitored)
- ✅ Credential holder can appeal via new slice
- ✅ Voting history is on-chain (detectable pattern)
- ⚠️ **Partial**: Multi-sig admin enforcement planned for v2.0

**Residual Risk**: Medium. Requires collusion of multiple slice members.

**Recommendation**: Implement monitoring for unusual voting patterns (e.g., same members voting together repeatedly).

---

#### 5.3.3 Evidence Forgery

**Attack**: Attacker submits forged evidence to support dispute.

**Vector**:
- File dispute with fake evidence hash
- Slice members cannot verify authenticity
- Dispute resolution based on false evidence

**Mitigation**:
- ✅ Evidence stored off-chain (IPFS) with hash verification
- ✅ Hash mismatch causes `InvalidEvidence` error
- ✅ Evidence is immutable (cannot be changed after filing)
- ✅ Slice members responsible for evidence verification
- ✅ Audit trail shows evidence hash and resolution

**Residual Risk**: Low. Cryptographic hashing prevents tampering; social engineering remains possible.

**Recommendation**: Require slice members to document evidence review process.

---

### 5.4 SBT Minting & Burning

**Feature**: Credential holders can now mint Soulbound Tokens (SBTs) representing credentials.

**New Attack Vectors**:

#### 5.4.1 SBT Minting Without Attestation

**Attack**: Attacker mints SBT for credential that hasn't been attested.

**Vector**:
- Issue credential
- Mint SBT before attestation threshold is met
- SBT appears to represent verified credential

**Mitigation**:
- ✅ `mint` checks that credential exists
- ✅ `mint` checks that credential is not revoked
- ✅ Application layer should verify attestation before minting (recommended)
- ✅ SBT metadata can indicate attestation status

**Residual Risk**: Low. Application layer should enforce attestation requirement.

**Recommendation**: Document that SBT minting does not imply attestation; verifiers should check `is_attested()` separately.

---

#### 5.4.2 SBT Metadata Manipulation

**Attack**: Attacker mints SBT with misleading metadata.

**Vector**:
- Mint SBT with metadata claiming higher qualification than credential
- Verifier trusts SBT metadata without checking credential
- Credential holder appears overqualified

**Mitigation**:
- ✅ SBT metadata is immutable after minting
- ✅ SBT metadata hash is stored on-chain
- ✅ Verifiers should check both SBT and credential metadata
- ✅ Metadata mismatch is detectable

**Residual Risk**: Low. Requires verifier to trust SBT metadata without verification.

**Recommendation**: Verifiers should always check underlying credential, not just SBT metadata.

---

#### 5.4.3 SBT Burning & Re-minting

**Attack**: Attacker burns SBT and re-mints with different metadata.

**Vector**:
- Mint SBT with accurate metadata
- Burn SBT
- Re-mint SBT with modified metadata
- Credential appears to have changed

**Mitigation**:
- ✅ Burn is irreversible (SBT destroyed)
- ✅ Re-minting creates new token ID
- ✅ Token ID history is on-chain (can be audited)
- ✅ Credential metadata is immutable (cannot be changed)

**Residual Risk**: Low. Credential metadata is immutable; SBT metadata changes are auditable.

---

## 6. Operational Security

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
| **Weight Manipulation** | **Low** | **High** | **Threshold validation, immutable config** | **✅ Mitigated** |
| **Hash Collision** | **Negligible** | **High** | **SHA-256 cryptographic guarantee** | **✅ Mitigated** |
| **Metadata Availability Loss** | **Medium** | **Medium** | **IPFS replication, pinning service** | **⚠️ Partial** |
| **Dispute Spam** | **Low** | **Medium** | **Rate limiting, evidence requirements** | **✅ Mitigated** |
| **Dispute Resolution Collusion** | **Medium** | **Critical** | **Voting threshold, audit trail** | **⚠️ Partial** |
| **Evidence Forgery** | **Low** | **High** | **Cryptographic hashing, audit trail** | **✅ Mitigated** |
| **SBT Minting Without Attestation** | **Low** | **Medium** | **Application-layer verification** | **⚠️ Partial** |
| **SBT Metadata Manipulation** | **Low** | **Medium** | **Immutable metadata, verifier diligence** | **⚠️ Partial** |
| **SBT Burning & Re-minting** | **Low** | **Low** | **Immutable credential, auditable history** | **✅ Mitigated** |
| **BBS+ Reveal Correlation** | **Medium** | **Medium** | **Cryptographic unlinkability (proof layer); verifier policy gap remains** | **⚠️ Partial** |
| **BBS+ Proof Replay** | **Medium** | **High** | **Nonce binding not yet enforced in `bbs_plus_v1`** | **⚠️ Gap (planned)** |
| **BBS+ Verifier Collusion** | **Medium** | **Medium** | **Proof-level unlinkability; wallet-address correlation gap** | **⚠️ Partial** |
| **BBS+ Revocation Linkability** | **Medium** | **Medium** | **Accumulator non-membership proof exists; end-to-end integration pending** | **⚠️ Partial** |

---

## 8. Future Enhancements

### v1.1 (ZK Implementation & Metadata Pinning)
- [ ] Real Groth16/PLONK proof verification
- [ ] Claim-specific privacy (selective disclosure)
- [ ] Proof generation framework
- [ ] Mandatory metadata pinning service
- [ ] Metadata availability monitoring
- [ ] BBS+ verifier nonce binding (closes replay-of-proof gap — §3.11.2)
- [ ] BBS+ accumulator non-membership proof integrated into `verify_presentation` (closes revocation linkability gap — §3.11.4)

### v2.0 (Dispute Resolution & Governance)
- [ ] Multi-sig admin requirement (2-of-3)
- [ ] Reputation system for slice members
- [ ] Appeal process for disputed credentials
- [ ] Automated evidence verification
- [ ] Dispute voting audit trail
- [ ] Collusion detection algorithms

### v3.0 (Advanced Governance)
- [ ] DAO-based dispute resolution
- [ ] Credential expiry and renewal
- [ ] Institutional rating system
- [ ] Revocation registry
- [ ] Cross-chain credential bridging

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

**Last Reviewed**: May 29, 2026
**Next Review**: November 29, 2026 (6-month cycle)
