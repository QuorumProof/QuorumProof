# Attestor (Institution) Key-Custody Guide

## Overview

This guide is for institutions that co-sign SBTs on the QuorumProof platform — universities, professional societies, employers, licensing bodies. It covers how to securely generate, custody, and rotate the Stellar key that represents your attestation authority, and what happens to already-issued credentials when your key changes or is compromised.

---

## 1. Key Generation

### 1.1 Initial Key Setup

Generate your attestor key in a high-security environment, never on a general-purpose computer:

```bash
# Using Stellar CLI (soroban)
soroban config identity generate --name attestor-key

# The key pair is stored locally in ~/.config/soroban/identity/attestor-key.toml
# Extract only the public key for registration with QuorumProof
soroban config identity show attestor-key --verbose
```

### 1.2 Store the Private Key Securely

- **Never commit the private key to Git or any version control.**
- **Hardware wallet recommended:** Import the key into a Ledger, Trezor, or similar device. The device signs transactions without exposing the key.
- **Cold storage (air-gapped):** If using cold storage, the key lives offline and is only accessed when signing attestations.
- **HSM (Hardware Security Module):** Large institutions should consider an HSM for shared key custody across multiple administrators.
- **Backup:** Create encrypted backups (e.g., AES-256 encrypted USB drives) stored in separate physical locations.

### 1.3 Register the Public Key with QuorumProof

Once your key is secure, register the **public key only** with QuorumProof:

```bash
# Retrieve your public key
ATTESTOR_PUBLIC_KEY=$(soroban config identity show attestor-key --verbose | grep "Public Key")

# Call QuorumProof's registration endpoint or contract function
# (example; consult QuorumProof API docs for the exact call)
soroban contract invoke \
  --id <QUORUM_PROOF_CONTRACT_ID> \
  register_attestor \
  --attestor-key $ATTESTOR_PUBLIC_KEY \
  --institution-name "Your University" \
  --metadata '{"..."}'
```

---

## 2. Multi-Sig Recommendations for Institutional Signers

For large institutions, a single key represents a single point of failure. Consider requiring multiple approvals before issuing or rotating keys:

### 2.1 M-of-N Multi-Sig Setup

- **2-of-3 threshold:** Require any 2 out of 3 authorized administrators to approve attestations.
- **Implementation:** Use Stellar's weighted signatures or an on-chain multi-sig contract that gates the actual attestation call.
- **Key split:** Each administrator holds 1 key; none can act unilaterally.
- **Signer rotation:** If one administrator leaves, rotate their key out of the set and add a new one without invalidating existing credentials.

### 2.2 Approval Workflow

1. Administrator A initiates an attestation request (credential to be signed).
2. Request is held pending approval from at least one more administrator.
3. Administrator B reviews and approves (e.g., via a web dashboard or Slack bot).
4. Once threshold is met, the transaction is broadcast to Stellar.
5. All signers' names are recorded on-chain for audit purposes.

---

## 3. Key Rotation

Key rotation is necessary when:
- An administrator leaves the organization.
- A key is suspected to have been compromised (but not confirmed).
- Routine security policy (e.g., annual key refresh).
- An administrator's device is lost or stolen.

### 3.1 Rotation Procedure

1. **Generate a new key** following §1.1 and §1.2.
2. **Notify QuorumProof** of the key rotation:
   ```bash
   soroban contract invoke \
     --id <QUORUM_PROOF_CONTRACT_ID> \
     rotate_attestor_key \
     --admin <YOUR_ADMIN_ADDRESS> \
     --old_key_index <INDEX_OF_OLD_KEY> \
     --new_key <NEW_PUBLIC_KEY>
   ```
3. **Verify the rotation succeeded** by confirming the new key is stored on-chain:
   ```bash
   soroban contract invoke \
     --id <QUORUM_PROOF_CONTRACT_ID> \
     get_attestor_key \
     --attestor-address <YOUR_ADDRESS>
   ```
4. **Retire the old key securely:**
   - If it was on a hardware wallet, unplug the device or erase it.
   - If it was in software, securely delete the file (e.g., `shred -vfz -n 10 ~/.config/soroban/identity/attestor-key.toml`).
   - If it was in an HSM, revoke access through the HSM's admin interface.

### 3.2 What Happens to Existing Credentials

**Short answer:** Existing SBTs **remain valid** after a key rotation. The QuorumProof contract retains historical records of all attestor keys, and SBTs are verified against the key that was active at issuance time, not the current key.

**Long answer:** 
- Each issued SBT includes a reference to the attestor key index or timestamp at which it was signed.
- When a holder presents a credential for verification, QuorumProof looks up the historical key record and validates the signature against that key.
- Rotating your key does **not** invalidate previously issued credentials, but **new** credentials will be signed with the new key.
- **Implication for trust:** If your old key is compromised, all credentials signed with it are at risk of forgery. See §4 (Revocation Procedures) for how to handle compromise.

---

## 4. Revocation Procedures

Use revocation only if a key is **confirmed or strongly suspected** to have been compromised. Do not confuse routine key rotation with revocation; revocation is an emergency procedure.

### 4.1 Compromise Detection

- Unauthorized signatures from your key on QuorumProof or other systems.
- A hardware wallet or device was stolen or lost.
- A developer's laptop with the key was hacked.
- A staff member with access to the private key left under suspicious circumstances.
- An HSM audit reveals unauthorized access attempts.

### 4.2 Revocation Procedure

1. **Act immediately.** Do not wait for a full root-cause analysis; revoke first, investigate second.
   ```bash
   soroban contract invoke \
     --id <QUORUM_PROOF_CONTRACT_ID> \
     revoke_attestor_key \
     --admin <YOUR_ADMIN_ADDRESS> \
     --key_to_revoke <COMPROMISED_PUBLIC_KEY> \
     --reason "suspected compromise: stolen laptop on 2026-08-15"
   ```
2. **Verify revocation:**
   ```bash
   soroban contract invoke \
     --id <QUORUM_PROOF_CONTRACT_ID> \
     get_attestor_key_status \
     --key <COMPROMISED_PUBLIC_KEY>
   ```
   The response should indicate `revoked: true` and include the revocation timestamp.

3. **Stop signing with the old key immediately.** Any new attestations you issue should use a newly rotated key (§3.1).

4. **Notify QuorumProof security.** Send an email to `security@quorumproof.io` with:
   - The exact timestamp of suspected compromise (or "unknown").
   - Any audit logs or evidence suggesting the compromise.
   - Actions you have taken (key rotation, password changes, etc.).
   - Credential IDs or credential holders known to be affected (if any).

### 4.3 Impact on Existing Credentials

**After revocation:**
- **Credentials signed before revocation remain valid** (they can still be verified using the historical key record).
- **New signatures from the revoked key are rejected** by QuorumProof.
- **Credential holders are notified** (if they are subscribed to a notification service) that an attestor's key was revoked; they may be asked to re-attest or provide additional proof of possession.
- **Quorum slices including a revoked attestor are weakened:** If a holder's credential required signatures from your attestation authority, and your key is revoked, the slice's trust in that credential drops. Holders may need to obtain a new attestation from a non-revoked authority to restore full quorum strength.

---

## 5. Worked Example: University Registrar

**Scenario:** Major State University operates a credential system issuing verified enrollment and degree certificates via QuorumProof. The registrar must custody a signing key for issuing these SBTs.

### Setup

1. **Key generation:** The registrar's IT team generates a key on an air-gapped machine and stores it in a Ledger Nano S.
2. **Multi-sig threshold:** Two registrars (Alice and Bob) are authorized signers. Both hardware wallets are stored in a safe at the Registrar's Office.
3. **Public key registration:** The university's public key is registered with QuorumProof as `msu-registrar-key-001`.

### Issuance

1. Student Alice Muller graduates; her degree must be attested.
2. The registrar's database exports her credential (name, degree, graduation date, thesis title).
3. A backend script hashes the credential and forwards it to Alice and Bob via a secure interface.
4. **Alice's sign-off:** Plugs in her hardware wallet, reviews the credential details, and signs. The transaction is broadcast.
5. **Bob's sign-off:** Plugs in his hardware wallet, reviews, and signs. Once both signatures are collected (2-of-2 reached), the SBT is minted on-chain.
6. Alice Muller receives her SBT and can present it to employers or other verifiers.

### Routine Rotation (Annual)

1. Each year, the university's IT director re-generates the key (§1.1) and stores it in a new Ledger.
2. The new public key is registered with QuorumProof via `rotate_attestor_key`.
3. The old Ledger is placed in archive storage (locked cabinet, catalogued, kept for audits).
4. Alice and Bob are given access to the new Ledger.
5. **No SBTs issued under the old key are invalidated.** Employers verifying Alice Muller's SBT still see it as valid, signed by `msu-registrar-key-001` at issuance time.

### Compromise (Laptop Stolen)

1. A registrar's laptop (which had a software copy of the key for testing, against policy) is stolen from a café.
2. The registrar immediately alerts IT.
3. IT revokes the key via `revoke_attestor_key`.
4. A new key is generated and rotated in (§3.1, §4.2).
5. All future credentials are signed with the new key.
6. Alice Muller's SBT remains valid (it was signed with the old key before revocation).
7. **New credentials** issued before the revocation was triggered are at risk — a timeline audit determines which credentials were issued between the laptop theft and revocation; those credentials' holders are contacted and offered re-attestation if desired.

---

## Appendix: Frequently Asked Questions

### Q: If I rotate my key, do credential holders need to re-attest?
**A:** No. Their existing SBTs remain valid. New SBTs you issue will use the new key, but old ones are verified against the historical key record at verification time. The credential holder does not need to do anything.

### Q: What if I lose my private key entirely (no backup)?
**A:** You cannot recover it. You must rotate to a new key and update QuorumProof. Credentials issued under the old key remain valid but cannot be re-signed. If you need to re-issue credentials, follow the issuance process with the new key.

### Q: Can I use the same key across multiple institutions?
**A:** **Not recommended.** Each institution should have its own key and its own entry in QuorumProof's attestor registry. Sharing a key dilutes accountability and makes revocation harder to reason about.

### Q: How does QuorumProof prevent me from re-using a revoked key?
**A:** When a holder's client verifies a credential, it checks the attestor key's status at the time of issuance. If the key was revoked *after* issuance, the credential is still valid. If you attempt to issue *new* credentials with a revoked key, QuorumProof's contract will reject the transaction.

### Q: Can I delegate signing to a third party (e.g., a law firm)?
**A:** This depends on your institution's policy and QuorumProof's multi-sig design. If you set up a 2-of-3 multi-sig and give one key to the law firm, they can participate in signing but cannot act unilaterally. Consult your legal and security teams before enabling third-party signing.

---

## Related Resources

- [Disaster Recovery Procedures](./disaster-recovery.md) — what to do if your key is compromised or lost.
- [Threat Model & Security Analysis](./threat-model.md) — how QuorumProof models the risk of attestor key compromise.
- [Security Best Practices Guide](./security-best-practices.md) — broader security guidance for all credential issuers.
