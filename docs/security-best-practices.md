# Security Best Practices Guide

## Overview

This guide provides comprehensive security best practices for using QuorumProof, including common attack vectors, mitigation strategies, and code examples.

## Common Attack Vectors

### 1. Credential Forgery

**Description**: Attackers attempt to create fake credentials or modify existing ones.

**Attack Scenarios**:
- Issuing credentials without proper authorization
- Modifying credential metadata after issuance
- Creating credentials with false information

**Mitigation Strategies**:
- Verify issuer identity before accepting credentials
- Implement multi-signature requirements for critical operations
- Use cryptographic proofs to ensure credential integrity
- Maintain audit logs of all credential operations

**Code Example**:
```rust
// Verify credential issuer
pub fn verify_credential_issuer(
    credential_id: u64,
    expected_issuer: &Address,
) -> Result<bool, Error> {
    let credential = get_credential(credential_id)?;
    
    // Verify issuer matches expected value
    if credential.issuer != *expected_issuer {
        return Err(Error::IssuerMismatch);
    }
    
    // Verify credential signature
    verify_credential_signature(&credential)?;
    
    Ok(true)
}

// Implement multi-signature for credential issuance
pub fn issue_credential_multisig(
    subject: &Address,
    credential_type: u32,
    metadata_hash: &BytesN<32>,
    signers: &Vec<Address>,
    threshold: u32,
) -> Result<u64, Error> {
    // Verify minimum signers
    if signers.len() < threshold as usize {
        return Err(Error::InsufficientSignatures);
    }
    
    // Verify all signers are authorized
    for signer in signers {
        verify_signer_authorization(signer)?;
    }
    
    // Issue credential
    let credential_id = issue_credential(subject, credential_type, metadata_hash)?;
    
    // Log multi-signature operation
    log_multisig_operation(&credential_id, signers, threshold);
    
    Ok(credential_id)
}
```

### 2. Quorum Slice Manipulation

**Description**: Attackers attempt to manipulate quorum slices to bypass verification requirements.

**Attack Scenarios**:
- Adding malicious attestors to a quorum slice
- Reducing the threshold to require fewer attestations
- Removing legitimate attestors
- Creating fake quorum slices

**Mitigation Strategies**:
- Implement strict access controls on quorum slice modifications
- Require multi-party approval for slice changes
- Maintain immutable audit trails
- Validate attestor credentials before adding to slice

**Code Example**:
```rust
// Validate attestor before adding to slice
pub fn add_attestor_with_validation(
    slice_id: u64,
    attestor: &Address,
) -> Result<(), Error> {
    // Verify caller has permission
    verify_caller_authorization()?;
    
    // Validate attestor credentials
    validate_attestor_credentials(attestor)?;
    
    // Check for duplicate attestors
    if slice_contains_attestor(slice_id, attestor) {
        return Err(Error::DuplicateAttestor);
    }
    
    // Add attestor with audit log
    add_attestor(slice_id, attestor)?;
    log_attestor_addition(slice_id, attestor);
    
    Ok(())
}

// Implement approval workflow for slice modifications
pub fn modify_slice_with_approval(
    slice_id: u64,
    modification: SliceModification,
    approvers: &Vec<Address>,
) -> Result<(), Error> {
    // Create modification request
    let request_id = create_modification_request(slice_id, modification.clone())?;
    
    // Collect approvals
    let mut approval_count = 0;
    for approver in approvers {
        if approve_modification(request_id, approver)? {
            approval_count += 1;
        }
    }
    
    // Check if threshold met
    let slice = get_slice(slice_id)?;
    if approval_count < slice.threshold as usize {
        return Err(Error::InsufficientApprovals);
    }
    
    // Apply modification
    apply_modification(request_id, modification)?;
    log_modification_applied(slice_id, request_id);
    
    Ok(())
}
```

### 3. Unauthorized Attestation

**Description**: Attackers attempt to attest credentials without proper authorization.

**Attack Scenarios**:
- Attesting credentials for unauthorized subjects
- Providing false attestations
- Attesting revoked credentials
- Attesting credentials outside of authority scope

**Mitigation Strategies**:
- Implement role-based access control (RBAC)
- Verify attestor authority for credential type
- Check credential status before accepting attestation
- Maintain attestor reputation scores

**Code Example**:
```rust
// Verify attestor authority
pub fn attest_with_authority_check(
    credential_id: u64,
    attestor: &Address,
) -> Result<(), Error> {
    let credential = get_credential(credential_id)?;
    
    // Verify credential is not revoked
    if credential.is_revoked {
        return Err(Error::CredentialRevoked);
    }
    
    // Verify attestor has authority for this credential type
    verify_attestor_authority(attestor, credential.credential_type)?;
    
    // Check attestor reputation
    let reputation = get_attestor_reputation(attestor)?;
    if reputation < MINIMUM_REPUTATION_THRESHOLD {
        return Err(Error::InsufficientReputation);
    }
    
    // Record attestation
    attest(credential_id, attestor)?;
    log_attestation(credential_id, attestor);
    
    Ok(())
}

// Implement role-based access control
pub fn verify_attestor_authority(
    attestor: &Address,
    credential_type: u32,
) -> Result<(), Error> {
    let attestor_role = get_attestor_role(attestor)?;
    let allowed_types = get_allowed_credential_types(&attestor_role)?;
    
    if !allowed_types.contains(&credential_type) {
        return Err(Error::UnauthorizedCredentialType);
    }
    
    Ok(())
}
```

### 4. Replay Attacks

**Description**: Attackers replay valid transactions to perform unauthorized operations.

**Attack Scenarios**:
- Replaying attestation transactions
- Replaying credential issuance transactions
- Replaying slice modifications

**Mitigation Strategies**:
- Implement nonce-based transaction validation
- Use sequence numbers for operations
- Implement time-based expiration
- Validate transaction signatures

**Code Example**:
```rust
// Implement nonce-based validation
pub fn attest_with_nonce(
    credential_id: u64,
    attestor: &Address,
    nonce: u64,
) -> Result<(), Error> {
    // Verify nonce hasn't been used
    if nonce_used(attestor, nonce) {
        return Err(Error::NonceAlreadyUsed);
    }
    
    // Verify nonce is within valid range
    let current_nonce = get_current_nonce(attestor)?;
    if nonce <= current_nonce {
        return Err(Error::InvalidNonce);
    }
    
    // Perform attestation
    attest(credential_id, attestor)?;
    
    // Mark nonce as used
    mark_nonce_used(attestor, nonce)?;
    
    Ok(())
}

// Implement sequence-based validation
pub fn issue_credential_with_sequence(
    subject: &Address,
    credential_type: u32,
    metadata_hash: &BytesN<32>,
    sequence: u64,
) -> Result<u64, Error> {
    // Get expected sequence
    let expected_sequence = get_next_sequence(subject)?;
    
    // Verify sequence matches
    if sequence != expected_sequence {
        return Err(Error::InvalidSequence);
    }
    
    // Issue credential
    let credential_id = issue_credential(subject, credential_type, metadata_hash)?;
    
    // Increment sequence
    increment_sequence(subject)?;
    
    Ok(credential_id)
}
```

### 5. Sybil Attacks

**Description**: Attackers create multiple fake identities to gain disproportionate influence.

**Attack Scenarios**:
- Creating multiple attestor accounts
- Manipulating quorum slices with fake attestors
- Gaining majority control through fake identities

**Mitigation Strategies**:
- Implement identity verification requirements
- Use reputation systems
- Implement rate limiting
- Monitor for suspicious patterns

**Code Example**:
```rust
// Implement identity verification
pub fn register_attestor_with_verification(
    attestor: &Address,
    identity_proof: &BytesN<32>,
) -> Result<(), Error> {
    // Verify identity proof
    verify_identity_proof(attestor, identity_proof)?;
    
    // Check for duplicate identities
    if identity_already_registered(identity_proof) {
        return Err(Error::DuplicateIdentity);
    }
    
    // Register attestor
    register_attestor(attestor)?;
    store_identity_proof(attestor, identity_proof)?;
    
    Ok(())
}

// Implement reputation system
pub fn update_attestor_reputation(
    attestor: &Address,
    delta: i32,
) -> Result<(), Error> {
    let current_reputation = get_attestor_reputation(attestor)?;
    let new_reputation = (current_reputation as i32 + delta).max(0) as u32;
    
    // Check for suspicious reputation changes
    if delta < -100 {
        log_suspicious_activity(attestor, "Large reputation decrease");
    }
    
    // Update reputation
    set_attestor_reputation(attestor, new_reputation)?;
    
    Ok(())
}

// Implement rate limiting
pub fn attest_with_rate_limit(
    credential_id: u64,
    attestor: &Address,
) -> Result<(), Error> {
    // Check rate limit
    let attestations_in_window = count_recent_attestations(attestor, RATE_LIMIT_WINDOW)?;
    if attestations_in_window >= MAX_ATTESTATIONS_PER_WINDOW {
        return Err(Error::RateLimitExceeded);
    }
    
    // Perform attestation
    attest(credential_id, attestor)?;
    
    Ok(())
}
```

### 6. Private Key Compromise

**Description**: Attackers gain access to private keys and can impersonate users.

**Attack Scenarios**:
- Stealing private keys from wallets
- Compromising key management systems
- Phishing attacks to obtain keys
- Malware stealing keys from devices

**Mitigation Strategies**:
- Use hardware wallets for key storage
- Implement multi-signature schemes
- Use key rotation policies
- Implement transaction signing verification

**Code Example**:
```typescript
// Implement secure key storage
class SecureKeyManager {
  private keyStore: Map<string, EncryptedKey> = new Map();
  
  // Store key with encryption
  storeKey(userId: string, privateKey: string): void {
    const encrypted = this.encryptKey(privateKey);
    this.keyStore.set(userId, encrypted);
  }
  
  // Retrieve and decrypt key
  getKey(userId: string, password: string): string {
    const encrypted = this.keyStore.get(userId);
    if (!encrypted) {
      throw new Error('Key not found');
    }
    return this.decryptKey(encrypted, password);
  }
  
  // Encrypt key with AES-256
  private encryptKey(key: string): EncryptedKey {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', this.masterKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(key, 'utf8'),
      cipher.final()
    ]);
    return { iv: iv.toString('hex'), data: encrypted.toString('hex') };
  }
  
  // Decrypt key
  private decryptKey(encrypted: EncryptedKey, password: string): string {
    const decipher = crypto.createDecipheriv(
      'aes-256-cbc',
      this.masterKey,
      Buffer.from(encrypted.iv, 'hex')
    );
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encrypted.data, 'hex')),
      decipher.final()
    ]);
    return decrypted.toString('utf8');
  }
}

// Implement transaction signing verification
async function verifyTransactionSignature(
  transaction: Transaction,
  publicKey: string
): Promise<boolean> {
  const messageHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(transaction.data))
    .digest();
  
  const isValid = crypto.verify(
    'sha256',
    messageHash,
    publicKey,
    Buffer.from(transaction.signature, 'hex')
  );
  
  return isValid;
}

// Implement key rotation
async function rotateKeys(userId: string): Promise<void> {
  // Generate new key pair
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  
  // Store new key
  const keyManager = new SecureKeyManager();
  keyManager.storeKey(userId, privateKey.export({ format: 'pem', type: 'pkcs8' }));
  
  // Update public key in system
  await updatePublicKey(userId, publicKey.export({ format: 'pem', type: 'spki' }));
  
  // Log key rotation
  logKeyRotation(userId);
}
```

## Security Checklist

### Development

- [ ] Use secure coding practices
- [ ] Implement input validation
- [ ] Implement output encoding
- [ ] Use parameterized queries
- [ ] Implement proper error handling
- [ ] Avoid hardcoding secrets
- [ ] Use security linters

### Deployment

- [ ] Use HTTPS/TLS for all communications
- [ ] Implement rate limiting
- [ ] Use Web Application Firewall (WAF)
- [ ] Implement DDoS protection
- [ ] Use security headers
- [ ] Implement logging and monitoring
- [ ] Regular security updates

### Operations

- [ ] Implement access controls
- [ ] Use multi-factor authentication
- [ ] Implement audit logging
- [ ] Regular security audits
- [ ] Incident response plan
- [ ] Backup and disaster recovery
- [ ] Security training for staff

### Cryptography

- [ ] Use strong encryption algorithms
- [ ] Use secure random number generation
- [ ] Implement proper key management
- [ ] Use digital signatures
- [ ] Implement certificate pinning
- [ ] Regular cryptographic audits

## Incident Response

### Detection

- Monitor for suspicious activities
- Implement alerting systems
- Regular security assessments
- Penetration testing

### Response

1. **Identify**: Determine the scope and nature of the incident
2. **Contain**: Isolate affected systems
3. **Eradicate**: Remove the threat
4. **Recover**: Restore systems to normal operation
5. **Learn**: Conduct post-incident analysis

### Communication

- Notify affected users
- Inform regulatory bodies if required
- Maintain transparency
- Provide remediation guidance

## References

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [OWASP Secure Coding Practices](https://owasp.org/www-project-secure-coding-practices-quick-reference-guide/)
- [CWE/SANS Top 25](https://cwe.mitre.org/top25/)
- [Stellar Security Best Practices](https://developers.stellar.org/docs/learn/security)

---

## Admin-Key Topology and Multi-Sig / Timelock Policy

> Added by issue #1508. This section documents the current per-contract admin key
> topology, the threat model that justifies upgrading to a multi-sig / timelock
> scheme, and the design decision for the v1.1 roadmap item.

### Current Topology (v1.0)

Each of the three deployed contracts — `quorum_proof`, `sbt_registry`, and
`zk_verifier` — stores a single `DataKey::Admin` address checked with a direct
equality assertion on every sensitive operation:

```rust
// Pattern repeated in all three contracts
let stored_admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
assert!(stored_admin == admin, "unauthorized");
```

Operations gated by this pattern include:

| Contract | Gated operations |
|---|---|
| `quorum_proof` | `upgrade`, `set_admin`, `pause`/`resume`, `emergency_pause`/`emergency_degrade` |
| `sbt_registry` | `upgrade`, `set_admin`, `pause`/`unpause`, `revoke_credential` |
| `zk_verifier` | `upgrade`, `set_admin`, `pause`/`unpause`, `rotate_verifying_key` |

**Key observations:**
- The three admin keys are independent — there is no shared key or on-chain relationship between them.
- A single EOA key compromise is a full, immediate compromise of that contract's trust guarantees.
- Because the three keys are independent, an attacker only needs to compromise the weakest one to own one contract outright. If the three keys share a common secret store (e.g. the same GitHub Actions secret or the same hardware wallet derivation path), a single secrets-management failure compromises all three.
- There is no on-chain delay between `set_admin` and the new admin gaining full privileges — an attacker with the key can upgrade, pause, or rotate the verifying key in a single transaction.

### Threat Model

The primary threats addressed by upgrading the admin scheme are:

1. **Single-key compromise** — stolen or leaked `STELLAR_SECRET_KEY` gives an attacker full admin rights on all admin-gated operations with no time window for detection and response.
2. **Supply-chain / CI compromise** — a compromised GitHub Actions runner can exfiltrate `secrets.STELLAR_DEPLOY_SECRET_KEY` and immediately use it.
3. **Insider threat** — any team member with access to the secret can unilaterally upgrade or pause a contract.
4. **Irreversible upgrades** — there is no on-chain delay between `upgrade` being called and the new WASM taking effect, so a malicious upgrade cannot be cancelled once submitted.

### Design Decision: Multi-Sig / Timelock Scheme (v1.1 Scope)

A full multi-sig / timelock implementation is **scoped to v1.1** rather than
implemented in v1.0 for the following reasons:

- Soroban does not have a native multi-sig primitive at the contract level; a
  correct implementation requires either an off-chain aggregator or an on-chain
  pending-approval store, both of which add non-trivial complexity and gas cost.
- The existing pause/emergency-pause mechanism (§1.7 in `docs/disaster-recovery.md`)
  already provides an emergency stop that can be used to freeze a compromised
  contract while a key-rotation recovery is performed.
- The `set_admin` function already exists as the rotation mechanism; adding a
  timelock on top of it is additive, not a redesign.

**Chosen scheme for v1.1:**

An `AdminProposal` pattern modelled on OpenZeppelin's `TimelockController`:

1. **Propose** — the current admin submits a proposal (`propose_admin_change(new_admin, eta)`) that is stored on-chain with a mandatory delay (`eta ≥ now + TIMELOCK_DELAY`). `TIMELOCK_DELAY` is a contract constant, initially set to 48 hours for `mainnet` and 1 hour for `testnet`.
2. **Queue** — the proposal sits in a `PendingAdminChange` storage entry during the delay window. Any on-chain observer (exporter, monitoring) can detect and alert on it.
3. **Execute** — after `eta` passes, any caller can invoke `execute_admin_change(proposal_id)` which atomically sets the new admin and removes the proposal. The executing caller does not need to be the admin.
4. **Cancel** — the current admin can cancel a pending proposal before `eta` with `cancel_admin_change(proposal_id)`. This is the recovery mechanism if a proposal was submitted by a compromised key.

The same `AdminProposal` mechanism is applied to `upgrade` and `rotate_verifying_key`. The `pause`/`emergency_pause` operations are **exempt from the timelock** because they must be usable immediately during an incident.

**Multi-sig requirement (also v1.1):**

Rather than a full m-of-n on-chain multi-sig (which would require a separate
multi-sig contract or Stellar account with multiple signers), the v1.1 approach
uses **Stellar account-level multi-sig** for the admin address:

- The admin `Address` stored in each contract points to a **Stellar account with
  a 2-of-3 signer set** (three hardware-wallet-backed keys, any two sufficient).
- Stellar's native transaction signing policy enforces the 2-of-3 requirement
  before the transaction is accepted by the network — no on-contract code change
  is required for the multi-sig enforcement itself.
- This approach reuses Stellar's existing multi-sig infrastructure and avoids
  implementing a custom on-chain aggregator.

**Why unsound/yanked denial does not affect this change:**
The multi-sig mechanism operates at the Stellar account layer, not via a new Rust
dependency, so the `deny.toml` tightening in issue #1490 has no interaction with
this design.

**Rationale for keeping `pause` exempt from timelock:**
An emergency pause is a harm-reduction measure that must not be slowed by a 48-hour
delay. The worst-case abuse of an untimelocked pause is a service disruption
(contract frozen), not a funds loss or a privilege escalation. An attacker who
controls the admin key can already cause more damage via `upgrade` — and `upgrade`
*is* timelocked — so the pause exemption does not meaningfully widen the attack
surface.

**Same-transaction admin-then-upgrade guard:**
The `AdminProposal` design inherently blocks a same-transaction admin-then-upgrade
attack: the admin change proposal must be submitted in one transaction, the timelock
delay must elapse (≥ 48 hours on mainnet), and the upgrade must be submitted in a
separate transaction after the new admin is confirmed. There is no path to combine
both in a single transaction.

### Wiring to Existing Infrastructure

- The monitoring exporter (`monitoring/exporter/exporter.py`) should expose a
  `quorumproof_pending_admin_proposal{contract="..."}` gauge once the v1.1
  `AdminProposal` storage entry is available, so `monitoring/prometheus/alerts.yml`
  can fire an alert whenever a proposal is queued.
- The `docs/disaster-recovery.md` key-rotation runbook (§1.1 and the new
  `§1.9 Key Rotation Runbook`) is the operational procedure for exercising the
  `AdminProposal` flow.

### Current Interim Mitigations (v1.0)

Until v1.1 lands, the following controls reduce the single-key risk:

1. **Hardware wallet** — the deployer key is stored on a hardware wallet, not in a software keystore.
2. **GitHub Actions secret isolation** — `STELLAR_DEPLOY_SECRET_KEY` is scoped to the `environment: testnet` / `environment: mainnet` contexts with required reviewers, not accessible to all workflow runs.
3. **Separate keys per environment** — testnet and mainnet use distinct key pairs, so a testnet secrets leak does not affect mainnet.
4. **90-day rotation policy** — the deployer key is rotated every 90 days per `docs/disaster-recovery.md` §2 backup strategy.
5. **Emergency pause** — if a key compromise is suspected, the contract can be paused immediately via `emergency_pause` while the key rotation is executed (see §1.7 in `docs/disaster-recovery.md`).

---

## Security Requirements, Checklist, Threat Modeling, and Tooling

> Added by issue #1637. This section turns the guidance above into concrete,
> enforceable requirements for QuorumProof contributors and operators. The
> generic checklist earlier in this file still applies; the items below are
> specific to this codebase and are the ones reviewers will ask about.

### Security Requirements

Requirements use RFC 2119 keywords. Each has an ID so PRs and audits can cite it.

#### Smart contracts (`contracts/`)

| ID | Requirement |
|---|---|
| SR-C1 | Every state-mutating public function **MUST** call `require_auth()` on the address whose authority it exercises (issuer, holder, attestor, or admin) before touching storage. |
| SR-C2 | Contract code **MUST NOT** add new bare `.unwrap()` / `.expect()` calls; use `panic_with_error!(&env, ContractError::…)` so failures surface as typed errors. Enforced by `scripts/check_unwraps.sh` (ratchet). |
| SR-C3 | `unsafe` blocks **MUST NOT** be used in contract crates. |
| SR-C4 | Admin addresses **MUST NOT** be hardcoded; they are set at `initialize` and changed only via the admin-rotation flow. |
| SR-C5 | Credentials and SBTs **MUST** remain non-transferable; no code path may change `subject` / `owner` after issuance except the documented recovery flow. |
| SR-C6 | Personal data **MUST NOT** be written to ledger storage. Only hashes/commitments go on-chain; encryption and compression happen off-chain (see [privacy-guide.md](./privacy-guide.md), [crypto-shredding-architecture.md](./crypto-shredding-architecture.md)). |
| SR-C7 | ZK verification entry points used in production **MUST** fail closed. Test-only verifiers stay behind `#[cfg(any(test, feature = "testutils"))]`. |
| SR-C8 | Every storage entry that must outlive its default TTL **MUST** have its TTL extended in the same call that writes it. |
| SR-C9 | Upgrades **MUST** follow [contract-upgrade-checklist.md](./contract-upgrade-checklist.md) and preserve the invariants in [migration-invariants.md](./migration-invariants.md). |

#### API server (`api-server/`)

| ID | Requirement |
|---|---|
| SR-A1 | Every route that accepts a body **MUST** validate it with a schema from `middleware/validate.ts`. JSON bodies are capped at 100 kB. |
| SR-A2 | Privileged routes **MUST** be protected with `rbac.requirePermission(...)`; `/api/admin/*` additionally sits behind the IP allow-list. |
| SR-A3 | Errors **MUST** be returned as RFC 9457 Problem Details and **MUST NOT** leak stack traces, SQL, secrets, or internal hostnames. |
| SR-A4 | SQL **MUST** use parameterized queries. String-concatenated SQL is rejected in review. |
| SR-A5 | Secrets (API keys, webhook secrets, OTPs, share-link passwords) **MUST** be stored hashed; plaintext is returned only once at creation. |
| SR-A6 | Rate limiting, DDoS protection, and request de-duplication middleware **MUST NOT** be bypassed for new `/api` routes. |
| SR-A7 | Outbound webhooks **MUST** be signed (see `api-server/docs/WEBHOOK_SIGNATURE_VERIFICATION.md`). |
| SR-A8 | Logs **MUST NOT** contain secrets, OTPs, full API keys, or credential metadata plaintext. |
| SR-A9 | CORS **MUST** use an explicit origin allow-list in production. |

#### Frontend / dashboard

| ID | Requirement |
|---|---|
| SR-F1 | Secret keys **MUST NOT** be handled by the web app; signing is delegated to the wallet (e.g. Freighter). |
| SR-F2 | User-controlled strings **MUST** be rendered as text, never via `innerHTML` / `dangerouslySetInnerHTML`. |
| SR-F3 | Production builds **MUST** ship a Content-Security-Policy that disallows inline scripts. |

#### Operations & supply chain

| ID | Requirement |
|---|---|
| SR-O1 | Deployer/admin keys **MUST** be stored on hardware wallets and rotated every 90 days (see [attestor-key-custody-guide.md](./attestor-key-custody-guide.md)). |
| SR-O2 | Testnet and mainnet **MUST** use distinct keys and distinct GitHub environments with required reviewers. |
| SR-O3 | New Rust dependencies **MUST** pass `cargo deny check`; advisory exceptions in `deny.toml` **MUST** carry a tracking issue and date. |
| SR-O4 | Every release **MUST** publish an SBOM (`sbom/`, `.github/workflows/sbom.yml`). |
| SR-O5 | Suspected vulnerabilities **MUST** be reported privately per [`../SECURITY.md`](../SECURITY.md), not in public issues. |

### Security Checklist

Copy the relevant block into your PR description and tick each item.

#### Every PR

- [ ] No secrets, keys, or real addresses with funds in the diff (TruffleHog passes)
- [ ] New/changed contract functions call `require_auth()` where they mutate state (SR-C1)
- [ ] No new bare `unwrap()` / `expect()` / `unsafe` in contracts (SR-C2, SR-C3)
- [ ] New API routes validate input and have RBAC where needed (SR-A1, SR-A2)
- [ ] Errors use Problem Details and reveal no internals (SR-A3)
- [ ] No personal data written on-chain or to logs (SR-C6, SR-A8)
- [ ] New dependencies justified and pass `cargo deny` / `npm audit` (SR-O3)
- [ ] Threat model updated if the change adds an asset, trust boundary, or entry point (see below)

#### Contract changes

- [ ] Negative tests for unauthorized callers exist for every new mutating function
- [ ] Storage TTLs extended where needed (SR-C8)
- [ ] Fuzz target added or updated for new parsing/arithmetic logic ([fuzz-testing-guide.md](./fuzz-testing-guide.md))
- [ ] Arithmetic uses checked operations on untrusted input
- [ ] Events emitted for security-relevant state changes (issue, revoke, attest, admin change)
- [ ] `scripts/scan_contracts.sh` reports no CRITICAL findings

#### Release

- [ ] [security-audit-checklist.md](./security-audit-checklist.md) completed
- [ ] `cargo audit`, `cargo deny check`, `npm audit --omit=dev` clean or exceptions documented
- [ ] Mutation-testing score not regressed ([mutation-testing workflow](../.github/workflows/mutation-testing.yml))
- [ ] SBOM generated and attached (SR-O4)
- [ ] Upgrade path reviewed against [contract-upgrade-checklist.md](./contract-upgrade-checklist.md)
- [ ] Monitoring and alerts cover any new critical events ([critical-event-alerting.md](./critical-event-alerting.md))

#### Deployment

- [ ] Deployer key on hardware wallet, correct environment (SR-O1, SR-O2)
- [ ] [deployment-checklist.md](./deployment-checklist.md) completed
- [ ] Emergency pause procedure verified and on-call informed ([disaster-recovery.md](./disaster-recovery.md))
- [ ] Admin IP allow-list and CORS origins reviewed for the target environment

### Threat Modeling Guide

The system-level threat model lives in [threat-model.md](./threat-model.md),
with a focused model for credential fraud in
[THREAT_MODEL_CREDENTIAL_FRAUD.md](./THREAT_MODEL_CREDENTIAL_FRAUD.md). Use
this guide when a feature changes what those documents describe.

#### When to threat-model

Run the process below (it takes 30–60 minutes for most features) when a change:

- adds a new contract, public contract function, or API route;
- introduces a new asset (key, secret, personal data, token);
- crosses a new trust boundary (new external service, bridge, oracle, webhook consumer);
- changes authorization, quorum/threshold logic, or cryptographic verification;
- changes how data is stored, retained, or deleted.

#### Process

1. **Scope and diagram.** Draw a data-flow diagram of the change: actors
   (holder, issuer, attestor, verifier, admin, anonymous caller), processes
   (contract, API server, frontend, workers), data stores (ledger storage,
   Postgres, Redis, object storage), and **trust boundaries** between them.
   Mermaid in the PR description is fine:

   ```mermaid
   flowchart LR
     V[Verifier] -- HTTPS --> API[API server]
     API -- RPC --> RPC[(Soroban RPC)]
     RPC --> QP[quorum_proof contract]
     H[Holder wallet] -- signed tx --> QP
     subgraph Trust boundary: ledger
       QP
     end
   ```

2. **List assets.** What would an attacker want? For QuorumProof the usual
   list is: admin/deployer keys, attestor keys, credential integrity,
   revocation status, holder privacy (link between address and identity),
   API keys and webhook secrets, audit-log integrity, availability of
   verification.

3. **Enumerate threats with STRIDE** per element crossing a boundary:

   | STRIDE | Question | QuorumProof example |
   |---|---|---|
   | **S**poofing | Can someone act as another principal? | Forged attestor signature; stolen API key |
   | **T**ampering | Can data be modified in transit or at rest? | Altered metadata hash; edited audit-log rows |
   | **R**epudiation | Can an actor deny an action? | Attestor denies co-signing; missing events |
   | **I**nformation disclosure | Can data leak? | Personal data on-chain; verbose error bodies; share-link enumeration |
   | **D**enial of service | Can availability be degraded? | Unbounded loops over slice members; batch-verify amplification; RPC exhaustion |
   | **E**levation of privilege | Can a caller gain rights? | Missing `require_auth`; RBAC bypass; upgrade hijack |

   Also consider FBA-specific threats: Sybil attestors, collusion to reach a
   weighted threshold, and slice manipulation (see
   [economic-security-model.md](./economic-security-model.md) and
   [quorum-slice-guide.md](./quorum-slice-guide.md)).

4. **Rate each threat.** Use Likelihood (1–3) × Impact (1–3). Score ≥ 6 must
   be mitigated before merge; 3–4 needs a tracked issue; ≤ 2 may be accepted
   with a written rationale.

5. **Decide and record mitigations.** For each threat pick: mitigate,
   transfer, accept, or eliminate the feature. Link each mitigation to the
   requirement ID above, a test, or a monitoring alert.

6. **Record the result.** Add a row to the relevant table in
   [threat-model.md](./threat-model.md) (or a new section for a new
   component). Significant design decisions go in an ADR under
   [`adr/`](./adr/README.md).

#### Threat record template

```markdown
### T-<component>-<n>: <short name>

- **Element / boundary:** <e.g. POST /api/verify/batch → Soroban RPC>
- **STRIDE category:** <S|T|R|I|D|E>
- **Description:** <how the attack works>
- **Assets at risk:** <keys, integrity, privacy, availability…>
- **Likelihood × Impact:** <L> × <I> = <score>
- **Mitigation:** <control, requirement ID, test, alert>
- **Status:** <mitigated | tracked in #NNN | accepted (rationale)>
```

#### Review

The PR reviewer checks that every threat scored ≥ 6 has a mitigation that is
actually present in the diff (code, test, or alert), not only described.

### Security Tooling

| Tool | What it catches | Where it runs | Run locally |
|---|---|---|---|
| `cargo audit` | Known-vulnerable Rust crates (RustSec) | CI `security` job | `cargo install cargo-audit && cargo audit` |
| `cargo deny` | Advisories, unsound/yanked crates, license policy, banned deps (`deny.toml`) | CI `security` job | `cargo install cargo-deny && cargo deny check` |
| TruffleHog | Committed secrets across history | CI `security` job | `trufflehog git file://. --results=verified,unknown` |
| `scripts/scan_contracts.sh` | Unsafe contract patterns: bare unwrap/expect, `unsafe`, hardcoded addresses, missing auth | Local / pre-release | `./scripts/scan_contracts.sh` |
| `scripts/check_unwraps.sh` | Ratchet on bare `.unwrap()` count in contracts | CI | `./scripts/check_unwraps.sh` |
| `scripts/check_deps.sh` | Stale advisory exceptions in `deny.toml` | Local / scheduled | `./scripts/check_deps.sh` |
| `cargo fuzz` (`fuzz/`) | Panics and logic errors on adversarial input | `.github/workflows/fuzz.yml` | see [FUZZING.md](./FUZZING.md) |
| `cargo mutants` | Weak tests around security checks | `.github/workflows/mutation-testing.yml` | `./scripts/mutation_test.sh` |
| Formal verification (`formal-verification/`) | Invariant violations in critical functions | Local | see [formal-verification.md](./formal-verification.md) |
| SBOM (`sbom/`) | Supply-chain inventory for each release | `.github/workflows/sbom.yml` | see workflow |
| `npm audit` | Known-vulnerable JS packages in `api-server/`, `frontend/`, `dashboard/` | Local / recommended in CI | `npm audit --omit=dev` in each package |
| `cargo clippy -- -D warnings` | Lints including suspicious arithmetic and error handling | CI `contracts` job | `cargo clippy --all-targets -- -D warnings` |
| Prometheus alerts (`monitoring/`) | Runtime anomalies: auth failures, admin changes, pause events | Production | see [critical-event-alerting.md](./critical-event-alerting.md) |

**Adding a tool.** New security tooling should run in CI (fail the build on
high-severity findings), document how to suppress a false positive with a
tracking comment, and be added to the table above.

**Handling findings.** Treat a tooling finding like a bug: fix it, or add a
dated, issue-linked exception (the `deny.toml` `allow` list is the model).
Never silence a finding without a tracking issue. Findings that indicate an
exploitable vulnerability follow the private disclosure process in
[`../SECURITY.md`](../SECURITY.md).
