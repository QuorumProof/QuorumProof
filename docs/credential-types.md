# Credential Type Registry

This document defines the credential type hierarchy and best practices for defining custom credential types in QuorumProof.

## Overview

Credential types categorize the kind of professional qualification being attested. Each type has:
- **Type ID**: Unique identifier (e.g., `degree`, `license`)
- **Metadata Schema**: Required fields for that credential type
- **Attestors**: Who can issue this type
- **Expiry**: Optional validity period

## Standard Credential Types

### 1. Degree

Represents an academic degree from an accredited institution.

**Type ID**: `degree`

**Metadata Fields**:
```json
{
  "institution": "string",           // University name
  "field_of_study": "string",        // e.g., "Mechanical Engineering"
  "degree_level": "string",          // "bachelor", "master", "phd"
  "graduation_date": "u64",          // Unix timestamp
  "gpa": "optional<f64>",            // Grade point average (0-4.0)
  "honors": "optional<string>"       // "cum laude", "magna cum laude", etc.
}
```

**Attestor**: University registrar or accredited institution

**Expiry**: None (degrees don't expire)

**Example**:
```rust
let metadata = map!(
    ("institution", "MIT"),
    ("field_of_study", "Mechanical Engineering"),
    ("degree_level", "bachelor"),
    ("graduation_date", "1609459200"),  // 2021-01-01
    ("gpa", "3.85"),
    ("honors", "cum laude")
);
```

### 2. Professional License

Represents a government-issued professional license or certification.

**Type ID**: `license`

**Metadata Fields**:
```json
{
  "license_number": "string",        // Official license ID
  "issuing_body": "string",          // e.g., "Professional Engineers Ontario"
  "jurisdiction": "string",          // Country/state code (ISO 3166-1)
  "discipline": "string",            // e.g., "Mechanical Engineering"
  "issue_date": "u64",               // Unix timestamp
  "expiry_date": "u64",              // Unix timestamp
  "status": "string"                 // "active", "suspended", "revoked"
}
```

**Attestor**: National/regional licensing body

**Expiry**: As specified in `expiry_date`

**Example**:
```rust
let metadata = map!(
    ("license_number", "PE-2024-001234"),
    ("issuing_body", "Professional Engineers Ontario"),
    ("jurisdiction", "CA"),
    ("discipline", "Mechanical Engineering"),
    ("issue_date", "1609459200"),
    ("expiry_date", "1672531200"),  // 2023-01-01
    ("status", "active")
);
```

### 3. Employment History

Represents employment at an organization during a specific period.

**Type ID**: `employment`

**Metadata Fields**:
```json
{
  "employer": "string",              // Company name
  "job_title": "string",             // e.g., "Senior Engineer"
  "department": "string",            // e.g., "R&D"
  "start_date": "u64",               // Unix timestamp
  "end_date": "optional<u64>",       // Unix timestamp (null if current)
  "employment_type": "string",       // "full-time", "contract", "part-time"
  "skills": "optional<string>"       // Comma-separated list
}
```

**Attestor**: Employer HR department or manager

**Expiry**: None (historical record)

**Example**:
```rust
let metadata = map!(
    ("employer", "Tesla"),
    ("job_title", "Senior Mechanical Engineer"),
    ("department", "Powertrain"),
    ("start_date", "1609459200"),
    ("end_date", "1640995200"),  // 2022-01-01
    ("employment_type", "full-time"),
    ("skills", "CAD, MATLAB, Thermal Analysis")
);
```

### 4. Certification

Represents a professional certification from a recognized body.

**Type ID**: `certification`

**Metadata Fields**:
```json
{
  "certification_name": "string",    // e.g., "AWS Solutions Architect"
  "issuing_organization": "string",  // e.g., "Amazon Web Services"
  "certification_id": "string",      // Official cert ID
  "issue_date": "u64",               // Unix timestamp
  "expiry_date": "optional<u64>",    // Unix timestamp
  "score": "optional<u64>"           // Exam score if applicable
}
```

**Attestor**: Certification body

**Expiry**: As specified in `expiry_date`

## Custom Credential Types

You can define custom credential types by following this pattern:

### Design Principles

1. **Immutability**: Metadata should not change after issuance
2. **Minimalism**: Include only essential fields; avoid redundancy
3. **Standardization**: Use ISO standards where applicable (dates, country codes, etc.)
4. **Privacy**: Don't include sensitive personal data (SSN, passport numbers, etc.)
5. **Auditability**: Include dates and issuing body for verification

### Creating a Custom Type

1. **Define the Type ID**: Use lowercase, hyphenated names (e.g., `security-clearance`)

2. **Design Metadata Schema**: List required and optional fields with types

3. **Specify Attestors**: Who is authorized to issue this credential

4. **Document Expiry**: Does this credential expire? If so, include `expiry_date`

5. **Add Examples**: Provide sample metadata for clarity

### Example: Security Clearance

```rust
// Type ID: security-clearance
// Metadata:
{
  "clearance_level": "string",       // "secret", "top-secret", "confidential"
  "issuing_agency": "string",        // e.g., "US Department of Defense"
  "issue_date": "u64",
  "expiry_date": "u64",
  "scope": "optional<string>"        // e.g., "Nuclear Weapons"
}

// Attestor: Government security agency
// Expiry: Yes, as specified in expiry_date
```

## Best Practices

### 1. Use Consistent Date Formats
Always use Unix timestamps (seconds since epoch) for dates. This ensures consistency across systems and timezones.

```rust
// Good
("graduation_date", "1609459200")

// Avoid
("graduation_date", "2021-01-01")
("graduation_date", "01/01/2021")
```

### 2. Normalize String Values
Use lowercase, standardized values for enums:

```rust
// Good
("degree_level", "bachelor")
("employment_type", "full-time")

// Avoid
("degree_level", "Bachelor's")
("employment_type", "Full-Time")
```

### 3. Use ISO Standards
For country codes, use ISO 3166-1 alpha-2 (e.g., "US", "CA", "DE"):

```rust
("jurisdiction", "CA")  // Canada
("jurisdiction", "DE")  // Germany
```

### 4. Avoid Redundant Fields
Don't duplicate information that can be derived:

```rust
// Avoid
{
  "start_date": "1609459200",
  "end_date": "1640995200",
  "duration_months": "12"  // Redundant
}

// Good
{
  "start_date": "1609459200",
  "end_date": "1640995200"
}
```

### 5. Include Verification Metadata
Add fields that help verifiers confirm authenticity:

```rust
{
  "license_number": "PE-2024-001234",  // Verifiable ID
  "issuing_body": "Professional Engineers Ontario",
  "jurisdiction": "CA"
}
```

### 6. Plan for Privacy
Don't include sensitive personal data in metadata:

```rust
// Avoid
{
  "ssn": "123-45-6789",
  "date_of_birth": "1990-01-01"
}

// Good: Use ZK proofs for age verification instead
{
  "age_verified": true,
  "verification_date": "1609459200"
}
```

## Type Registry

To register a new credential type, add it to the `CredentialType` enum in the contract:

```rust
pub enum CredentialType {
    Degree,
    License,
    Employment,
    Certification,
    // Add custom types here
    Custom(String),
}
```

Then document it in this file following the standard template.

## Verification Workflow

When verifying a credential:

1. **Retrieve Type**: Get the credential type from the on-chain record
2. **Validate Metadata**: Ensure all required fields are present
3. **Check Attestors**: Verify signatures from authorized attestors
4. **Verify Expiry**: If applicable, check that credential hasn't expired
5. **Conditional Claims**: Use ZK proofs for selective disclosure

## References

- [Credential Management API](../README.md#credential-management)
- [Trust Slice Model](./trust-slices.md)
- [ZK Verification Design](./zk-verification.md)
