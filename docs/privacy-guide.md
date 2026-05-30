# QuorumProof Credential Holder Privacy Guide

A comprehensive guide for credential holders on how to protect their privacy while using QuorumProof, including privacy features, anonymity modes, and best practices.

---

## Table of Contents

1. [Privacy Overview](#privacy-overview)
2. [Privacy Features](#privacy-features)
3. [Anonymity Modes](#anonymity-modes)
4. [Best Practices](#best-practices)
5. [Data Minimization](#data-minimization)
6. [Selective Disclosure](#selective-disclosure)
7. [Revocation & Deletion](#revocation--deletion)
8. [FAQ](#faq)

---

## Privacy Overview

### What Data Does QuorumProof Collect?

QuorumProof stores the following on-chain (publicly visible):

**Credential Data**:
- Credential ID (unique identifier)
- Issuer address (institution that issued credential)
- Subject address (your Stellar address)
- Credential type (1=Degree, 2=License, 3=Certification, 4=Employment)
- Metadata hash (IPFS CID or SHA-256 hash)
- Issuance timestamp
- Revocation status

**Attestation Data**:
- Attestor addresses (who verified your credential)
- Attestation timestamp
- Attestation weight (in quorum slice)

**SBT Data** (if you mint):
- Token ID
- Owner address (your Stellar address)
- Metadata URI
- Minting timestamp

### What Data Is NOT Stored On-Chain?

✅ **Private** (stored off-chain):
- Your name
- Your contact information
- Your employment history details
- Your educational background details
- Your certification details
- Any sensitive personal information

These details are stored in the **metadata** (IPFS), which you control. You decide what to include.

### Privacy Guarantees

**On-Chain Privacy**:
- Your Stellar address is public (like a username)
- Your credentials are linked to your address
- Attestations are public (who verified you)
- Timestamps are public

**Off-Chain Privacy**:
- Metadata is encrypted (you control encryption)
- Metadata is not indexed by search engines
- Metadata is only accessible if you share the IPFS CID
- You can delete metadata from IPFS

---

## Privacy Features

### 2.1 Metadata Encryption

**What**: Encrypt your credential metadata before uploading to IPFS.

**Why**: Prevents unauthorized access to sensitive details.

**How**:

**Step 1: Prepare Metadata**
```json
{
  "name": "John Doe",
  "degree": "Bachelor of Science in Computer Science",
  "university": "MIT",
  "graduation_date": "2020-05-15",
  "gpa": "3.8"
}
```

**Step 2: Encrypt with AES-256**
```typescript
import crypto from 'crypto';

const metadata = JSON.stringify({
  name: "John Doe",
  degree: "Bachelor of Science in Computer Science",
  university: "MIT",
  graduation_date: "2020-05-15",
  gpa: "3.8"
});

// Generate encryption key (store securely)
const encryptionKey = crypto.randomBytes(32);

// Encrypt metadata
const iv = crypto.randomBytes(16);
const cipher = crypto.createCipheriv('aes-256-cbc', encryptionKey, iv);
let encrypted = cipher.update(metadata, 'utf8', 'hex');
encrypted += cipher.final('hex');

// Combine IV + encrypted data
const encryptedData = iv.toString('hex') + ':' + encrypted;

console.log('Encrypted metadata:', encryptedData);
console.log('Encryption key (save securely):', encryptionKey.toString('hex'));
```

**Step 3: Upload to IPFS**
```bash
echo "$ENCRYPTED_DATA" | ipfs add
# Returns: QmXxxx (IPFS CID)
```

**Step 4: Use IPFS CID as Metadata Hash**
```typescript
const credentialId = await issueCredential(
  issuerKeypair,
  subjectAddress,
  1, // Degree
  'QmXxxx', // Encrypted metadata IPFS CID
);
```

**Step 5: Decrypt When Needed**
```typescript
function decryptMetadata(encryptedData: string, encryptionKey: string): object {
  const [ivHex, encryptedHex] = encryptedData.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const key = Buffer.from(encryptionKey, 'hex');
  
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return JSON.parse(decrypted);
}

const metadata = decryptMetadata(encryptedData, encryptionKey);
console.log('Decrypted:', metadata);
```

**Privacy Benefit**: Only you (and those you share the key with) can read your credential details.

---

### 2.2 Address Separation

**What**: Use different Stellar addresses for different purposes.

**Why**: Prevents linking your credentials across contexts.

**How**:

**Scenario**: You have credentials from multiple institutions.

**Without Address Separation**:
```
Address: GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQ375YQRDX5TWUC4N
├── Degree from MIT
├── License from IEEE
└── Employment history from Google
```

Anyone can see all your credentials linked to one address.

**With Address Separation**:
```
Address 1 (Education): GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQ375YQRDX5TWUC4N
├── Degree from MIT

Address 2 (Professional): GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQ375YQRDX5TWUC4O
├── License from IEEE
├── Employment history from Google

Address 3 (Certifications): GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQ375YQRDX5TWUC4P
├── AWS Certification
├── Kubernetes Certification
```

**Implementation**:
```typescript
// Create separate addresses
const educationKeypair = Keypair.random();
const professionalKeypair = Keypair.random();
const certificationKeypair = Keypair.random();

// Issue credentials to different addresses
await issueCredential(
  issuerKeypair,
  educationKeypair.publicKey(),
  1, // Degree
  'QmEducation...',
);

await issueCredential(
  issuerKeypair,
  professionalKeypair.publicKey(),
  2, // License
  'QmProfessional...',
);

await issueCredential(
  issuerKeypair,
  certificationKeypair.publicKey(),
  3, // Certification
  'QmCertification...',
);
```

**Privacy Benefit**: Credentials are not linked to a single identity.

---

### 2.3 Metadata Minimization

**What**: Store only essential information in metadata.

**Why**: Reduces exposure of sensitive data.

**How**:

**Minimal Metadata** (Recommended):
```json
{
  "credential_type": "degree",
  "issuer": "MIT",
  "issued_date": "2020-05-15"
}
```

**Detailed Metadata** (Not Recommended):
```json
{
  "name": "John Doe",
  "date_of_birth": "1998-03-20",
  "ssn": "123-45-6789",
  "degree": "Bachelor of Science in Computer Science",
  "university": "MIT",
  "graduation_date": "2020-05-15",
  "gpa": "3.8",
  "honors": "Summa Cum Laude",
  "thesis_title": "Advanced Machine Learning Techniques",
  "advisor": "Dr. Jane Smith",
  "home_address": "123 Main St, Cambridge, MA 02139",
  "phone": "555-1234",
  "email": "john@example.com"
}
```

**Best Practice**: Store only what's necessary for verification.

---

## Anonymity Modes

### 3.1 Pseudonymous Verification

**What**: Verify credentials without revealing your identity.

**Use Case**: Applying for a job without revealing your current employer.

**How**:

**Step 1: Create Pseudonymous Address**
```typescript
const pseudonymousKeypair = Keypair.random();
const pseudonymousAddress = pseudonymousKeypair.publicKey();
```

**Step 2: Transfer Credential to Pseudonymous Address**
```typescript
// Note: Credentials are non-transferable, so you must:
// 1. Revoke the original credential
// 2. Issue a new credential to the pseudonymous address

await revokeCredential(originalIssuerKeypair, credentialId);

const newCredentialId = await issueCredential(
  issuerKeypair,
  pseudonymousAddress,
  credentialType,
  metadataHash,
);
```

**Step 3: Share Pseudonymous Address**
```typescript
// Share only the pseudonymous address with the verifier
// They can verify your credentials without knowing your real identity
const isAttested = await isAttested(newCredentialId, sliceId);
console.log(`Credential verified: ${isAttested}`);
```

**Privacy Benefit**: Verifier sees credentials but not your real identity.

**Limitation**: Issuer knows both your real and pseudonymous addresses.

---

### 3.2 Selective Disclosure (Planned v1.1)

**What**: Prove specific claims about your credentials without revealing full details.

**Use Case**: Prove you have a degree without revealing your GPA or graduation date.

**Status**: Planned for v1.1 (ZK verification implementation)

**How** (Future):
```typescript
// Prove you have a degree without revealing details
const proof = await generateProof(
  credentialId,
  'HasDegree', // Claim type
  {
    // Only prove these fields
    fields: ['degree_type', 'issuer'],
    // Hide these fields
    hidden: ['gpa', 'graduation_date', 'name'],
  }
);

const verified = await verifyClaim(
  adminKeypair,
  CONTRACT_QUORUM_PROOF,
  credentialId,
  ['HasDegree'],
  proof,
);

console.log(`Claim verified: ${verified}`);
```

---

### 3.3 Credential Sharing with Expiry

**What**: Share credentials with time-limited access.

**Use Case**: Share credentials with a recruiter for 30 days, then revoke access.

**How**:

**Step 1: Create Temporary Address**
```typescript
const tempKeypair = Keypair.random();
const tempAddress = tempKeypair.publicKey();
```

**Step 2: Issue Credential to Temporary Address**
```typescript
const tempCredentialId = await issueCredential(
  issuerKeypair,
  tempAddress,
  credentialType,
  metadataHash,
);
```

**Step 3: Share Temporary Address with Recruiter**
```typescript
// Share only the temporary address
// Recruiter can verify credentials for 30 days
```

**Step 4: Revoke After 30 Days**
```typescript
// After 30 days, revoke the temporary credential
await revokeCredential(issuerKeypair, tempCredentialId);

// Recruiter can no longer verify credentials
```

**Privacy Benefit**: Time-limited credential sharing.

---

## Best Practices

### 4.1 Key Management

**Do**:
- ✅ Store private keys in a hardware wallet (Ledger, Trezor)
- ✅ Use strong passphrases (20+ characters)
- ✅ Backup keys in a secure location
- ✅ Use different keys for different purposes
- ✅ Rotate keys periodically (annually)

**Don't**:
- ❌ Store private keys in plain text
- ❌ Share private keys with anyone
- ❌ Use the same key for multiple purposes
- ❌ Store keys in cloud storage (unencrypted)
- ❌ Use weak passphrases

---

### 4.2 Credential Sharing

**Do**:
- ✅ Share only the credential ID (not the full credential)
- ✅ Verify the recipient's identity before sharing
- ✅ Use encrypted channels (HTTPS, Signal, etc.)
- ✅ Set expiry dates for shared credentials
- ✅ Revoke credentials after use

**Don't**:
- ❌ Share your private key
- ❌ Share credentials with unverified recipients
- ❌ Use unencrypted channels (email, SMS)
- ❌ Share credentials indefinitely
- ❌ Share credentials with multiple recipients

---

### 4.3 Metadata Management

**Do**:
- ✅ Encrypt sensitive metadata
- ✅ Store metadata on IPFS (distributed)
- ✅ Pin metadata to ensure availability
- ✅ Use minimal metadata (only essential info)
- ✅ Review metadata before sharing

**Don't**:
- ❌ Store sensitive data in plain text
- ❌ Store metadata on centralized servers
- ❌ Forget to pin metadata
- ❌ Include unnecessary personal information
- ❌ Share metadata without reviewing

---

### 4.4 Address Management

**Do**:
- ✅ Use separate addresses for different contexts
- ✅ Document which address is for which purpose
- ✅ Rotate addresses periodically
- ✅ Monitor address activity
- ✅ Use pseudonymous addresses when appropriate

**Don't**:
- ❌ Use the same address for all credentials
- ❌ Link addresses publicly
- ❌ Reuse addresses across platforms
- ❌ Ignore suspicious activity
- ❌ Use real names in pseudonymous addresses

---

## Data Minimization

### 5.1 What to Include in Metadata

**Essential** (Always Include):
- Credential type (degree, license, etc.)
- Issuer name
- Issuance date

**Recommended** (Include if Relevant):
- Expiry date (if applicable)
- Credential level (e.g., Bachelor, Master)
- Field of study (e.g., Computer Science)

**Optional** (Include Only if Necessary):
- GPA or grade
- Honors or distinctions
- Thesis title

**Never Include**:
- ❌ Social Security Number
- ❌ Date of birth
- ❌ Home address
- ❌ Phone number
- ❌ Email address
- ❌ Passport number
- ❌ Driver's license number

---

### 5.2 Metadata Template

**Minimal Template**:
```json
{
  "type": "degree",
  "issuer": "MIT",
  "issued": "2020-05-15"
}
```

**Standard Template**:
```json
{
  "type": "degree",
  "issuer": "MIT",
  "issued": "2020-05-15",
  "field": "Computer Science",
  "level": "Bachelor"
}
```

**Detailed Template** (Use Encryption):
```json
{
  "type": "degree",
  "issuer": "MIT",
  "issued": "2020-05-15",
  "field": "Computer Science",
  "level": "Bachelor",
  "gpa": "3.8",
  "honors": "Summa Cum Laude",
  "thesis": "Advanced ML Techniques"
}
```

---

## Selective Disclosure

### 6.1 Selective Disclosure Concept

**What**: Prove specific claims without revealing full details.

**Example**: Prove you have a degree without revealing your GPA.

**How It Works**:

```
Full Credential:
├── Degree: Bachelor of Science
├── Field: Computer Science
├── University: MIT
├── GPA: 3.8
├── Graduation: 2020-05-15
└── Honors: Summa Cum Laude

Selective Disclosure (Employer):
├── Degree: Bachelor of Science ✓
├── Field: Computer Science ✓
├── University: MIT ✓
├── GPA: [HIDDEN]
├── Graduation: [HIDDEN]
└── Honors: [HIDDEN]

Selective Disclosure (Recruiter):
├── Degree: Bachelor of Science ✓
├── Field: Computer Science ✓
├── University: [HIDDEN]
├── GPA: [HIDDEN]
├── Graduation: [HIDDEN]
└── Honors: [HIDDEN]
```

### 6.2 Implementation (Planned v1.1)

**Step 1: Create Proof Request**
```typescript
const proofRequest = await generateProofRequest(
  credentialId,
  ['HasDegree'],
);
```

**Step 2: Generate Selective Disclosure Proof**
```typescript
const proof = await generateSelectiveDisclosureProof(
  credentialId,
  {
    reveal: ['degree_type', 'field', 'university'],
    hide: ['gpa', 'graduation_date', 'honors'],
  }
);
```

**Step 3: Verify Proof**
```typescript
const verified = await verifyClaim(
  adminKeypair,
  CONTRACT_QUORUM_PROOF,
  credentialId,
  ['HasDegree'],
  proof,
);
```

**Privacy Benefit**: Prove claims without revealing unnecessary details.

---

## Revocation & Deletion

### 7.1 Credential Revocation

**What**: Permanently revoke a credential.

**When**: Credential is no longer valid, or you want to remove it.

**How**:

```typescript
await revokeCredential(issuerKeypair, credentialId);
```

**Effect**:
- Credential is marked as revoked
- Cannot be attested
- Cannot be verified
- Revocation is permanent and irreversible

**Privacy Benefit**: Remove credentials from your profile.

---

### 7.2 SBT Burning

**What**: Destroy a Soulbound Token.

**When**: You no longer want the SBT to represent your credential.

**How**:

```typescript
await burnSbt(holderKeypair, tokenId);
```

**Effect**:
- SBT is destroyed
- Token ID is no longer valid
- Cannot be recovered
- Burning is permanent and irreversible

**Privacy Benefit**: Remove SBT from your profile.

---

### 7.3 Metadata Deletion

**What**: Remove metadata from IPFS.

**When**: You want to delete sensitive information.

**How**:

```bash
# Unpin metadata from IPFS
ipfs pin rm QmXxxx

# Metadata is no longer accessible
# (if not pinned elsewhere)
```

**Effect**:
- Metadata is removed from IPFS
- Credential hash still exists on-chain
- Metadata cannot be recovered (if not backed up)

**Privacy Benefit**: Delete sensitive metadata.

**Warning**: If you delete metadata, verifiers cannot access credential details. Only do this if you're sure you won't need the metadata later.

---

## FAQ

### Q: Is my Stellar address private?

**A**: No. Your Stellar address is public, like a username. Anyone can see your address and the credentials linked to it. However, you can use multiple addresses to separate credentials.

---

### Q: Can I hide my credentials from the blockchain?

**A**: No. Credentials are stored on the Stellar blockchain, which is public. However, you can:
- Encrypt your metadata
- Use pseudonymous addresses
- Use selective disclosure (planned v1.1)
- Revoke credentials you don't want to share

---

### Q: Can I delete my credentials?

**A**: You can revoke credentials (mark them as invalid), but you cannot delete them from the blockchain. Blockchain data is immutable. However, you can:
- Revoke credentials
- Burn SBTs
- Delete metadata from IPFS

---

### Q: Who can see my credentials?

**A**: Anyone can see:
- Your Stellar address
- Your credential IDs
- Your credential types
- Your issuer
- Your attestations
- Your SBTs

Only you (and those you share the encryption key with) can see:
- Your metadata (if encrypted)
- Your personal details

---

### Q: Can I share credentials anonymously?

**A**: Yes. You can:
- Use a pseudonymous address
- Share only the credential ID
- Use selective disclosure (planned v1.1)
- Set expiry dates for shared credentials

---

### Q: What if my private key is compromised?

**A**: If your private key is compromised:
1. Immediately revoke all credentials issued to that address
2. Create a new address
3. Request new credentials from issuers
4. Rotate your keys

---

### Q: Can I transfer credentials to another address?

**A**: No. Credentials are non-transferable by design. However, you can:
- Revoke the original credential
- Request a new credential to a different address

---

### Q: How do I know if my metadata is secure?

**A**: Your metadata is secure if:
- ✅ It's encrypted with AES-256
- ✅ It's stored on IPFS (distributed)
- ✅ You control the encryption key
- ✅ You don't share the encryption key

Your metadata is NOT secure if:
- ❌ It's stored in plain text
- ❌ It's stored on a centralized server
- ❌ You share the encryption key
- ❌ You use weak encryption

---

### Q: Can I use QuorumProof anonymously?

**A**: Partially. You can:
- Use pseudonymous addresses
- Encrypt your metadata
- Use selective disclosure (planned v1.1)

However, you cannot:
- Hide your Stellar address
- Hide your credentials from the blockchain
- Hide your attestations

---

### Q: What's the difference between privacy and anonymity?

**A**: 
- **Privacy**: Controlling who sees your data (encryption, access control)
- **Anonymity**: Not being identifiable (pseudonymous addresses, selective disclosure)

QuorumProof provides privacy features (encryption, metadata control) but not full anonymity (your address is still visible).

---

### Q: How do I report a privacy concern?

**A**: If you have a privacy concern:
1. Email: privacy@quorumproof.io
2. Include: Description of concern, affected credential ID, steps to reproduce
3. We will investigate and respond within 48 hours

---

## Further Reading

- [Architecture Overview](./architecture.md)
- [Threat Model & Security](./threat-model.md)
- [SDK Methods Reference](./sdk-methods-reference.md)
- [API Client Guide](./api-client-guide.md)

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-05-29 | [Author] | Initial version |

**Last Updated**: May 29, 2026
**Next Review**: November 29, 2026
