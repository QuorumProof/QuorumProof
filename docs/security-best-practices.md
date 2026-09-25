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
