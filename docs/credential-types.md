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
│   ├── Specialty License (1102)  ← parent: Professional License (1101)
│   └── Renewal License (1103)    ← parent: Professional License (1101)
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

### On-Chain Hierarchy API

Parent-child relationships are stored on-chain and enforced by the contract. Use these functions to work with the hierarchy:

```rust
// Register a child type with a parent
client.register_credential_type(
    &admin, &1102u32,
    &String::from_str(&env, "Specialty License"),
    &String::from_str(&env, "Specialized engineering endorsement"),
    &Some(1101u32),  // parent: Professional License
);

// Get the direct parent of a type
let parent: Option<u32> = client.get_credential_type_parent(&1102u32);
// => Some(1101)

// Get all children of a type
let children: Vec<u32> = client.get_credential_type_children(&1101u32);
// => [1102, 1103]

// Get full ancestor chain (parent → grandparent → root)
let ancestors: Vec<u32> = client.get_credential_type_ancestors(&1102u32);
// => [1101]  (Professional License is the root here)

// Check if a type is a descendant of another
let is_child: bool = client.is_credential_type_child_of(&1102u32, &1101u32);
// => true
```

### Verification Rule Inheritance

When verifying a credential, use `inherit_verification_rules` to get the full ordered list of types whose rules apply — from most specific (the credential's own type) to most general (the root):

```rust
// Returns [1102, 1101] — check Specialty License rules first, then Professional License rules
let rule_chain: Vec<u32> = client.inherit_verification_rules(&1102u32);
```

This allows verifiers to apply layered validation: a Specialty License must satisfy both its own rules and all rules inherited from Professional License.

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

// Register a root custom type (no parent)
client.register_credential_type(
    &admin,
    &3001u32,
    &String::from_str(&env, "Custom Certification"),
    &String::from_str(&env, "A custom professional certification"),
    &None,  // no parent
);

// Register a child type under the custom root
client.register_credential_type(
    &admin,
    &3002u32,
    &String::from_str(&env, "Custom Specialty"),
    &String::from_str(&env, "A specialization of Custom Certification"),
    &Some(3001u32),  // parent: Custom Certification
);

// Retrieve the registered type
let type_def = client.get_credential_type(&3001u32);
assert_eq!(type_def.name, "Custom Certification");

// Verify hierarchy
assert!(client.is_credential_type_child_of(&3002u32, &3001u32));
```

### Circular Hierarchy Prevention

The contract prevents circular parent references. Attempting to create a cycle panics with `ContractError::CircularHierarchy`:

```rust
// This would panic — 3001 cannot be its own ancestor
client.register_credential_type(&admin, &3001u32, &name, &desc, &Some(3002u32));
// Error: CircularHierarchy
```

### Registering with an Unregistered Parent

If the parent type is not yet registered, the call panics with `ContractError::InvalidParentType`. Always register parent types before child types.

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

## Credential Type Metadata Requirements

### Required Fields by Type

All credential types must include these core fields in their metadata:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `issuer` | string | Yes | Name or ID of the issuing organization |
| `issue_date` | ISO 8601 | Yes | Date the credential was issued |
| `subject_identifier` | string | Yes | Unique identifier for the credential holder |
| `credential_version` | string | No | Version of the credential format |
| `supporting_documents` | array | No | IPFS hashes of supporting documents |

### Type-Specific Metadata

#### Academic Credentials (1000-1099)

**Degree (1001)**
```json
{
  "issuer": "University of São Paulo",
  "issue_date": "2020-06-15",
  "subject_identifier": "student_id_12345",
  "institution_code": "USP",
  "field_of_study": "Mechanical Engineering",
  "degree_level": "Bachelor",
  "gpa": "3.8",
  "graduation_date": "2020-06-15",
  "transcript_hash": "QmXxxx...",
  "diploma_hash": "QmYyyy..."
}
```

**Diploma (1002)**
```json
{
  "issuer": "Technical Institute",
  "issue_date": "2021-12-10",
  "subject_identifier": "student_id_67890",
  "program": "Advanced Manufacturing",
  "program_duration_months": 12,
  "completion_date": "2021-12-10",
  "program_hash": "QmZzzz..."
}
```

**Certificate (1003)**
```json
{
  "issuer": "Professional Association",
  "issue_date": "2019-03-20",
  "subject_identifier": "cert_holder_11111",
  "certification_name": "Certified Professional Engineer",
  "certification_body": "IEEE",
  "expiry_date": "2024-03-20",
  "certification_number": "CPE-2019-001",
  "certification_hash": "QmAaaa..."
}
```

#### Licensing Credentials (1100-1199)

**Professional License (1101)**
```json
{
  "issuer": "CREA",
  "issue_date": "2019-05-10",
  "subject_identifier": "engineer_id_22222",
  "license_number": "PE-2019-12345",
  "jurisdiction": "Brazil",
  "discipline": "Mechanical Engineering",
  "expiry_date": "2024-05-10",
  "license_authority": "CREA",
  "license_status": "active",
  "license_hash": "QmBbbb..."
}
```

**Specialty License (1102)**
```json
{
  "issuer": "CREA",
  "issue_date": "2020-01-15",
  "subject_identifier": "engineer_id_22222",
  "base_license_number": "PE-2019-12345",
  "specialty": "Structural Engineering",
  "specialty_code": "SE-001",
  "expiry_date": "2025-01-15",
  "specialty_hash": "QmCccc..."
}
```

**Renewal License (1103)**
```json
{
  "issuer": "CREA",
  "issue_date": "2024-05-10",
  "subject_identifier": "engineer_id_22222",
  "original_license": "PE-2019-12345",
  "renewal_date": "2024-05-10",
  "new_expiry": "2029-05-10",
  "renewal_number": "REN-2024-001",
  "renewal_hash": "QmDddd..."
}
```

#### Employment Credentials (1200-1299)

**Employment History (1201)**
```json
{
  "issuer": "Acme Engineering Corp",
  "issue_date": "2023-12-31",
  "subject_identifier": "employee_id_33333",
  "employer": "Acme Engineering Corp",
  "employer_code": "ACME-001",
  "position": "Senior Mechanical Engineer",
  "department": "Product Development",
  "start_date": "2018-06-01",
  "end_date": "2023-12-31",
  "employment_type": "Full-time",
  "employment_hash": "QmEeee..."
}
```

**Reference (1202)**
```json
{
  "issuer": "Acme Engineering Corp",
  "issue_date": "2024-01-15",
  "subject_identifier": "employee_id_33333",
  "referee_name": "Dr. Jane Smith",
  "referee_title": "VP Engineering",
  "referee_organization": "Acme Engineering Corp",
  "referee_email_hash": "sha256(email)",
  "reference_date": "2024-01-15",
  "reference_type": "professional",
  "reference_hash": "QmFfff..."
}
```

**Skill Certification (1203)**
```json
{
  "issuer": "Dassault Systèmes",
  "issue_date": "2022-09-20",
  "subject_identifier": "professional_id_44444",
  "skill": "CAD Design (CATIA)",
  "certifying_body": "Dassault Systèmes",
  "proficiency_level": "Advanced",
  "certification_date": "2022-09-20",
  "expiry_date": "2025-09-20",
  "skill_code": "CAD-CATIA-ADV",
  "skill_hash": "QmGggg..."
}
```

#### Government Credentials (2000-2999)

**National ID (2001)**
```json
{
  "issuer": "Government Authority",
  "issue_date": "2015-03-10",
  "subject_identifier": "national_id_55555",
  "id_number": "123456789",
  "country": "Brazil",
  "id_type": "CPF",
  "expiry_date": "2030-03-10",
  "id_hash": "QmHhhh..."
}
```

**Passport (2002)**
```json
{
  "issuer": "Government Authority",
  "issue_date": "2018-06-20",
  "subject_identifier": "passport_66666",
  "passport_number": "AB123456",
  "country": "Brazil",
  "expiry_date": "2028-06-20",
  "passport_hash": "QmIiii..."
}
```

**Work Permit (2003)**
```json
{
  "issuer": "Immigration Authority",
  "issue_date": "2023-01-15",
  "subject_identifier": "work_permit_77777",
  "permit_number": "WP-2023-001",
  "country": "Germany",
  "employment_country": "Germany",
  "expiry_date": "2024-01-15",
  "permit_hash": "QmJjjj..."
}
```

## Credential Type Validation Examples

### TypeScript/JavaScript Validation

```typescript
// Validate credential metadata structure
function validateCredentialMetadata(
  credentialType: number,
  metadata: Record<string, any>
): boolean {
  const requiredFields = ['issuer', 'issue_date', 'subject_identifier'];
  
  // Check required fields
  for (const field of requiredFields) {
    if (!metadata[field]) {
      throw new Error(`Missing required field: ${field}`);
    }
  }
  
  // Type-specific validation
  switch (credentialType) {
    case 1001: // Degree
      return validateDegreeMetadata(metadata);
    case 1101: // Professional License
      return validateLicenseMetadata(metadata);
    case 1201: // Employment History
      return validateEmploymentMetadata(metadata);
    default:
      return true;
  }
}

function validateDegreeMetadata(metadata: Record<string, any>): boolean {
  const required = ['field_of_study', 'degree_level', 'graduation_date'];
  for (const field of required) {
    if (!metadata[field]) {
      throw new Error(`Degree credential missing: ${field}`);
    }
  }
  
  // Validate degree level
  const validLevels = ['Bachelor', 'Master', 'PhD', 'Associate'];
  if (!validLevels.includes(metadata.degree_level)) {
    throw new Error(`Invalid degree level: ${metadata.degree_level}`);
  }
  
  return true;
}

function validateLicenseMetadata(metadata: Record<string, any>): boolean {
  const required = ['license_number', 'jurisdiction', 'discipline'];
  for (const field of required) {
    if (!metadata[field]) {
      throw new Error(`License credential missing: ${field}`);
    }
  }
  
  // Validate expiry date
  if (metadata.expiry_date) {
    const expiryDate = new Date(metadata.expiry_date);
    if (expiryDate < new Date()) {
      throw new Error('License has expired');
    }
  }
  
  return true;
}

function validateEmploymentMetadata(metadata: Record<string, any>): boolean {
  const required = ['employer', 'position', 'start_date'];
  for (const field of required) {
    if (!metadata[field]) {
      throw new Error(`Employment credential missing: ${field}`);
    }
  }
  
  // Validate date range
  const startDate = new Date(metadata.start_date);
  const endDate = metadata.end_date ? new Date(metadata.end_date) : new Date();
  
  if (startDate > endDate) {
    throw new Error('Start date cannot be after end date');
  }
  
  return true;
}
```

### Rust Validation

```rust
pub fn validate_credential_metadata(
    credential_type: u32,
    metadata: &str,
) -> Result<(), Error> {
    let metadata_obj: serde_json::Value = serde_json::from_str(metadata)
        .map_err(|_| Error::InvalidMetadataFormat)?;
    
    // Check required fields
    let required_fields = vec!["issuer", "issue_date", "subject_identifier"];
    for field in required_fields {
        if metadata_obj.get(field).is_none() {
            return Err(Error::MissingRequiredField(field.to_string()));
        }
    }
    
    // Type-specific validation
    match credential_type {
        1001 => validate_degree_metadata(&metadata_obj),
        1101 => validate_license_metadata(&metadata_obj),
        1201 => validate_employment_metadata(&metadata_obj),
        _ => Ok(()),
    }
}

fn validate_degree_metadata(metadata: &serde_json::Value) -> Result<(), Error> {
    let required = vec!["field_of_study", "degree_level", "graduation_date"];
    for field in required {
        if metadata.get(field).is_none() {
            return Err(Error::MissingRequiredField(field.to_string()));
        }
    }
    
    // Validate degree level
    let degree_level = metadata["degree_level"]
        .as_str()
        .ok_or(Error::InvalidMetadataFormat)?;
    
    match degree_level {
        "Bachelor" | "Master" | "PhD" | "Associate" => Ok(()),
        _ => Err(Error::InvalidDegreeLevel),
    }
}

fn validate_license_metadata(metadata: &serde_json::Value) -> Result<(), Error> {
    let required = vec!["license_number", "jurisdiction", "discipline"];
    for field in required {
        if metadata.get(field).is_none() {
            return Err(Error::MissingRequiredField(field.to_string()));
        }
    }
    
    // Validate expiry date if present
    if let Some(expiry_str) = metadata["expiry_date"].as_str() {
        let expiry = chrono::DateTime::parse_from_rfc3339(expiry_str)
            .map_err(|_| Error::InvalidDateFormat)?;
        
        if expiry < chrono::Utc::now() {
            return Err(Error::CredentialExpired);
        }
    }
    
    Ok(())
}

fn validate_employment_metadata(metadata: &serde_json::Value) -> Result<(), Error> {
    let required = vec!["employer", "position", "start_date"];
    for field in required {
        if metadata.get(field).is_none() {
            return Err(Error::MissingRequiredField(field.to_string()));
        }
    }
    
    // Validate date range
    let start_str = metadata["start_date"]
        .as_str()
        .ok_or(Error::InvalidMetadataFormat)?;
    let start_date = chrono::DateTime::parse_from_rfc3339(start_str)
        .map_err(|_| Error::InvalidDateFormat)?;
    
    if let Some(end_str) = metadata["end_date"].as_str() {
        let end_date = chrono::DateTime::parse_from_rfc3339(end_str)
            .map_err(|_| Error::InvalidDateFormat)?;
        
        if start_date > end_date {
            return Err(Error::InvalidDateRange);
        }
    }
    
    Ok(())
}
```

## References

- [Credential Expiry and Auto-Revocation](./credential-expiry.md)
- [Trust Slice Model](./trust-slices.md)
- [ZK Verification Design](./zk-verification.md)
- [Threat Model & Security](./threat-model.md)
