# Credential Type Registry

## Overview

QuorumProof uses a **credential type registry** to organize and categorize different kinds of professional credentials. Each credential type is identified by a unique 32-bit integer (`u32`) and can have human-readable metadata (name and description) registered on-chain.

This document describes the credential type hierarchy, design patterns, and best practices for defining custom types.

## Credential Type Hierarchy

Credential types follow a hierarchical structure to support different domains and use cases:

```
Professional Credentials (1000-1999)
├── Academic (1000-1099)
│   ├── Degree (1001)
│   ├── Diploma (1002)
│   └── Certificate (1003)
├── Licensing (1100-1199)
│   ├── Professional License (1101)
│   ├── Specialty License (1102)
│   └── Renewal License (1103)
└── Employment (1200-1299)
    ├── Employment History (1201)
    ├── Reference (1202)
    └── Skill Certification (1203)

Government Credentials (2000-2999)
├── National ID (2001)
├── Passport (2002)
└── Work Permit (2003)

Custom/Domain-Specific (3000+)
```

## Common Credential Types

### Academic Credentials

#### Degree (Type ID: 1001)
Represents a formal degree awarded by an accredited educational institution.

**Metadata Hash Contents:**
```json
{
  "institution": "University of São Paulo",
  "field_of_study": "Mechanical Engineering",
  "degree_level": "Bachelor",
  "graduation_date": "2020-06-15",
  "gpa": "3.8",
  "transcript_hash": "QmXxxx..."
}
```

**Example Registration:**
```rust
client.register_credential_type(
    &admin,
    &1001u32,
    &String::from_str(&env, "Degree"),
    &String::from_str(&env, "University degree (Bachelor, Master, PhD)")
);
```

#### Diploma (Type ID: 1002)
Represents a diploma or certificate of completion from an educational program.

**Metadata Hash Contents:**
```json
{
  "institution": "Technical Institute",
  "program": "Advanced Manufacturing",
  "completion_date": "2021-12-10",
  "program_hash": "QmYyyy..."
}
```

#### Certificate (Type ID: 1003)
Represents a professional or technical certificate.

**Metadata Hash Contents:**
```json
{
  "issuer": "Professional Association",
  "certification_name": "Certified Professional Engineer",
  "issue_date": "2019-03-20",
  "certification_hash": "QmZzzz..."
}
```

### Licensing Credentials

#### Professional License (Type ID: 1101)
Represents a government-issued professional license (e.g., engineering license, medical license).

**Metadata Hash Contents:**
```json
{
  "license_number": "PE-2019-12345",
  "jurisdiction": "Brazil",
  "discipline": "Mechanical Engineering",
  "issue_date": "2019-05-10",
  "expiry_date": "2024-05-10",
  "license_authority": "CREA",
  "license_hash": "QmAaaa..."
}
```

**Example Registration:**
```rust
client.register_credential_type(
    &admin,
    &1101u32,
    &String::from_str(&env, "Professional License"),
    &String::from_str(&env, "Government-issued professional license")
);
```

#### Specialty License (Type ID: 1102)
Represents a specialized license or endorsement (e.g., structural engineering specialty).

**Metadata Hash Contents:**
```json
{
  "base_license": "PE-2019-12345",
  "specialty": "Structural Engineering",
  "issue_date": "2020-01-15",
  "specialty_hash": "QmBbbb..."
}
```

#### Renewal License (Type ID: 1103)
Represents a renewed or extended license.

**Metadata Hash Contents:**
```json
{
  "original_license": "PE-2019-12345",
  "renewal_date": "2024-05-10",
  "new_expiry": "2029-05-10",
  "renewal_hash": "QmCccc..."
}
```

### Employment Credentials

#### Employment History (Type ID: 1201)
Represents employment at a specific organization.

**Metadata Hash Contents:**
```json
{
  "employer": "Acme Engineering Corp",
  "position": "Senior Mechanical Engineer",
  "start_date": "2018-06-01",
  "end_date": "2023-12-31",
  "employment_hash": "QmDddd..."
}
```

**Example Registration:**
```rust
client.register_credential_type(
    &admin,
    &1201u32,
    &String::from_str(&env, "Employment History"),
    &String::from_str(&env, "Employment record from an organization")
);
```

#### Reference (Type ID: 1202)
Represents a professional reference or recommendation.

**Metadata Hash Contents:**
```json
{
  "referee_name": "Dr. Jane Smith",
  "referee_title": "VP Engineering",
  "referee_organization": "Acme Engineering Corp",
  "reference_date": "2024-01-15",
  "reference_hash": "QmEeee..."
}
```

#### Skill Certification (Type ID: 1203)
Represents certification of a specific technical skill.

**Metadata Hash Contents:**
```json
{
  "skill": "CAD Design (CATIA)",
  "certifying_body": "Dassault Systèmes",
  "proficiency_level": "Advanced",
  "certification_date": "2022-09-20",
  "skill_hash": "QmFfff..."
}
```

## Best Practices for Type Design

### 1. Use Consistent Type ID Ranges

Organize your credential types into logical ranges:
- **1000-1999**: Professional credentials
- **2000-2999**: Government credentials
- **3000+**: Custom/domain-specific types

This makes it easier to understand the credential landscape and avoid collisions.

### 2. Document Metadata Structure

Always document the expected JSON structure for your credential type's metadata hash. This helps:
- Issuers understand what data to include
- Verifiers know what to expect
- Auditors can validate credential contents

### 3. Include Immutable Identifiers

Metadata should include unique identifiers that cannot be forged:
- License numbers
- Degree conferral dates
- Institution names
- Issuing authority

### 4. Use IPFS Hashes for Supporting Documents

Store supporting documents (transcripts, certificates, licenses) on IPFS and include their hashes in the metadata:

```json
{
  "transcript_hash": "QmXxxx...",
  "certificate_hash": "QmYyyy...",
  "supporting_docs": ["QmZzzz...", "QmAaaa..."]
}
```

### 5. Plan for Expiry and Renewal

For time-limited credentials, include:
- `issue_date`: When the credential was issued
- `expiry_date`: When the credential expires
- `renewal_date`: When it was last renewed

Use the `expires_at` field on the Credential struct to enforce expiry at the contract level.

### 6. Support Hierarchical Relationships

For credentials that build on others (e.g., specialty licenses on base licenses), include references:

```json
{
  "base_credential_id": 12345,
  "base_credential_hash": "QmXxxx...",
  "specialty": "Structural Engineering"
}
```

### 7. Minimize Sensitive Data

Avoid storing personally identifiable information (PII) directly in metadata. Instead:
- Store hashes of sensitive data
- Use zero-knowledge proofs for verification
- Keep full records off-chain

Example:
```json
{
  "subject_hash": "sha256(subject_address)",
  "ssn_hash": "sha256(ssn)",
  "full_record_ipfs": "QmXxxx..."
}
```

## Registering Custom Credential Types

To register a new credential type on-chain:

```rust
let env = Env::default();
let client = QuorumProofContractClient::new(&env, &contract_id);
let admin = Address::generate(&env);

// Register a custom credential type
client.register_credential_type(
    &admin,
    &3001u32,  // Custom type ID
    &String::from_str(&env, "Custom Certification"),
    &String::from_str(&env, "A custom professional certification")
);

// Retrieve the registered type
let type_def = client.get_credential_type(&3001u32);
assert_eq!(type_def.name, "Custom Certification");
```

## Querying Credential Types

Once registered, credential types can be queried:

```rust
// Get type definition
let type_def = client.get_credential_type(&1001u32);
println!("Type: {}", type_def.name);
println!("Description: {}", type_def.description);
```

## Migration and Versioning

When updating credential type definitions:

1. **Create a new type ID** for the updated version (e.g., 1001 → 1001v2)
2. **Keep the old type registered** for backward compatibility
3. **Document the migration path** in your system
4. **Use credential expiry** to phase out old types

Example:
```rust
// Old type (deprecated)
client.register_credential_type(&admin, &1001u32, &"Degree (v1)", &"...");

// New type (current)
client.register_credential_type(&admin, &1001u32, &"Degree (v2)", &"...");
```

## Security Considerations

### Metadata Hash Integrity

The metadata hash is stored on-chain but the actual metadata is stored off-chain (typically on IPFS). To verify integrity:

1. Retrieve the credential from the contract
2. Fetch the metadata from IPFS using the hash
3. Verify: `sha256(metadata) == credential.metadata_hash`

### Preventing Type Confusion

Always validate the credential type before processing:

```rust
let credential = client.get_credential(&cred_id);
assert_eq!(credential.credential_type, 1001u32, "Expected degree credential");
```

### Attestor Verification

For credentials with multiple attestors, verify the quorum slice:

```rust
let attestors = client.get_attestors(&cred_id);
let is_attested = client.is_attested(&cred_id, &slice_id);
assert!(is_attested, "Credential not properly attested");
```

## Examples

### Complete Degree Credential Flow

```rust
// 1. Register the degree type
client.register_credential_type(
    &admin,
    &1001u32,
    &String::from_str(&env, "Degree"),
    &String::from_str(&env, "University degree")
);

// 2. Issue a degree credential
let metadata = Bytes::from_slice(&env, b"ipfs://QmDegreeMetadata");
let expiry = Some(1735689600u64); // 2025-01-01
let cred_id = client.issue_credential(
    &university,
    &student,
    &1001u32,
    &metadata,
    &expiry
);

// 3. Create a quorum slice with university, licensing body, and employer
let mut attestors = Vec::new(&env);
attestors.push_back(university.clone());
attestors.push_back(licensing_body.clone());
attestors.push_back(employer.clone());

let mut weights = Vec::new(&env);
weights.push_back(50u32);
weights.push_back(30u32);
weights.push_back(20u32);

let slice_id = client.create_slice(&student, &attestors, &weights, &50u32);

// 4. Attestors sign the credential
client.attest(&university, &cred_id, &slice_id);
client.attest(&licensing_body, &cred_id, &slice_id);

// 5. Verify the credential is attested
assert!(client.is_attested(&cred_id, &slice_id));

// 6. Mint an SBT for the credential
let sbt_uri = Bytes::from_slice(&env, b"ipfs://QmSBTMetadata");
let token_id = sbt_client.mint(&student, &cred_id, &sbt_uri);
```

## References

- [Credential Expiry and Auto-Revocation](./credential-expiry.md)
- [Trust Slice Model](./trust-slices.md)
- [ZK Verification Design](./zk-verification.md)
- [Threat Model & Security](./threat-model.md)
