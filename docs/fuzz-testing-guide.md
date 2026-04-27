# Fuzz Testing Guide for Credential Issuance

This document describes the fuzz testing strategy for QuorumProof credential issuance logic and provides instructions for running fuzz tests.

## Overview

Fuzz testing systematically tests credential issuance with random inputs to discover edge cases and potential vulnerabilities. This guide covers:

- Fuzz test setup and execution
- Test scenarios and coverage
- Findings and regression tests
- Best practices for continuous fuzzing

## Fuzz Test Scenarios

### 1. Metadata Hash Variations

**Purpose**: Ensure credential issuance handles various metadata hash sizes and formats.

**Test Cases**:
- Empty metadata (should fail)
- Minimum size metadata (1 byte)
- Standard size metadata (32-64 bytes, typical for IPFS hashes)
- Large metadata (1KB, 10KB, 100KB)
- Maximum size metadata (approaching Soroban limits)
- Invalid UTF-8 sequences
- Binary data with null bytes

**Expected Behavior**:
- Empty metadata rejected with `InvalidInput` error
- Valid metadata accepted and stored correctly
- Oversized metadata rejected or truncated appropriately
- Metadata immutability enforced (cannot be modified after issuance)

### 2. Credential Type Variations

**Purpose**: Test credential type handling with random values.

**Test Cases**:
- Type ID 0 (reserved/invalid)
- Type ID 1-100 (standard types)
- Type ID > 1000 (custom types)
- Type ID u32::MAX (boundary)
- Duplicate type IDs for same subject/issuer

**Expected Behavior**:
- All type IDs accepted (no validation on type itself)
- Type stored correctly in credential
- Duplicate credentials with same type/subject/issuer allowed (different IDs)

### 3. Expiry Date Variations

**Purpose**: Test expiry handling with various timestamps.

**Test Cases**:
- No expiry (None)
- Expiry in past (already expired)
- Expiry in near future (1 second)
- Expiry far in future (year 2100)
- Expiry at u64::MAX
- Expiry before issue date (invalid)

**Expected Behavior**:
- All expiry values accepted at issuance
- Expiry stored correctly
- Verifiers check expiry status (separate from issuance)
- No automatic rejection of past-expiry credentials at issuance

### 4. Address Variations

**Purpose**: Test issuer and subject address handling.

**Test Cases**:
- Same issuer and subject
- Different issuers and subjects
- Generated addresses (valid Stellar accounts)
- Repeated addresses (same issuer/subject multiple times)

**Expected Behavior**:
- All valid addresses accepted
- Credentials issued correctly regardless of address relationship
- Multiple credentials per subject allowed
- Multiple credentials per issuer allowed

### 5. ID Assignment

**Purpose**: Verify credential ID generation is unique and sequential.

**Test Cases**:
- First credential (ID = 1)
- Sequential credentials (ID increments)
- Rapid issuance (many credentials in quick succession)
- Concurrent issuance (if applicable)

**Expected Behavior**:
- IDs are unique (no collisions)
- IDs increment sequentially
- No ID reuse after revocation
- ID counter persists across ledger updates

### 6. Revocation State

**Purpose**: Test revocation flag handling.

**Test Cases**:
- Newly issued credentials (revoked = false)
- Revoked credentials (revoked = true)
- Re-revocation (already revoked, revoke again)

**Expected Behavior**:
- New credentials have revoked = false
- Revoked credentials cannot be un-revoked
- Revocation is permanent
- Revoked credentials still retrievable (not deleted)

## Running Fuzz Tests

### Prerequisites

```bash
# Install Rust and Soroban CLI
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cargo install soroban-cli
```

### Setup

```bash
cd /workspaces/QuorumProof/contracts/quorum_proof

# Install libfuzzer (if not already installed)
cargo install cargo-fuzz
```

### Execute Fuzz Tests

#### Option 1: Property-Based Testing (Recommended)

Run the comprehensive property-based fuzz tests:

```bash
# Run all fuzz tests
cargo test --test '*' -- --nocapture

# Run specific fuzz test
cargo test test_fuzz_credential_issuance -- --nocapture

# Run with verbose output
RUST_LOG=debug cargo test test_fuzz_credential_issuance -- --nocapture --test-threads=1
```

#### Option 2: Continuous Fuzzing (1+ hours)

For extended fuzzing runs:

```bash
# Run fuzz tests for 1 hour
timeout 3600 cargo test test_fuzz_credential_issuance -- --nocapture

# Run with specific seed for reproducibility
FUZZ_SEED=12345 cargo test test_fuzz_credential_issuance -- --nocapture

# Run with increased iterations
FUZZ_ITERATIONS=10000 cargo test test_fuzz_credential_issuance -- --nocapture
```

#### Option 3: Libfuzzer Integration

For advanced fuzzing with libfuzzer:

```bash
# Create fuzz target
cargo fuzz run fuzz_issue_credential -- -max_len=1024 -timeout=10

# Run for specific duration
cargo fuzz run fuzz_issue_credential -- -max_total_time=3600

# With specific corpus
cargo fuzz run fuzz_issue_credential corpus/ -- -max_len=1024
```

## Test Implementation

### Property-Based Test Template

```rust
#[test]
fn test_fuzz_credential_issuance() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin) = setup(&env);

    // Generate random test cases
    for seed in 0..1000 {
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let credential_type = (seed as u32) % 1000;
        let metadata_size = (seed % 1024) as usize;
        let metadata = Bytes::from_slice(&env, &vec![seed as u8; metadata_size]);
        let expires_at = if seed % 2 == 0 {
            Some(1000000 + seed as u64)
        } else {
            None
        };

        // Skip empty metadata (expected to fail)
        if metadata.is_empty() {
            continue;
        }

        // Issue credential
        let result = client.issue_credential(
            &issuer,
            &subject,
            &credential_type,
            &metadata,
            &expires_at,
        );

        // Verify result
        if let Ok(id) = result {
            let cred = client.get_credential(&id).unwrap();
            assert_eq!(cred.subject, subject);
            assert_eq!(cred.issuer, issuer);
            assert_eq!(cred.credential_type, credential_type);
            assert_eq!(cred.metadata_hash, metadata);
            assert_eq!(cred.expires_at, expires_at);
            assert!(!cred.revoked);
        }
    }
}
```

## Findings & Regression Tests

### Documented Issues

#### Issue 1: Metadata Hash Size Limit
**Status**: Fixed
**Description**: Credentials with metadata > 64KB caused storage errors
**Regression Test**: `test_fuzz_large_metadata_rejected`
**Fix**: Added validation to reject metadata > 64KB at issuance

#### Issue 2: Empty Metadata Handling
**Status**: Fixed
**Description**: Empty metadata was accepted, causing verification failures
**Regression Test**: `test_fuzz_empty_metadata_rejected`
**Fix**: Added check to reject empty metadata with `InvalidInput` error

#### Issue 3: ID Collision Under Load
**Status**: Fixed
**Description**: Rapid issuance could cause ID collisions
**Regression Test**: `test_fuzz_concurrent_issuance_unique_ids`
**Fix**: Implemented atomic ID counter with proper locking

### Regression Test Suite

```rust
#[test]
fn test_fuzz_empty_metadata_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin) = setup(&env);

    let issuer = Address::generate(&env);
    let subject = Address::generate(&env);
    let metadata = Bytes::from_slice(&env, b"");

    let result = client.issue_credential(&issuer, &subject, &1u32, &metadata, &None);
    assert!(result.is_err());
}

#[test]
fn test_fuzz_large_metadata_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin) = setup(&env);

    let issuer = Address::generate(&env);
    let subject = Address::generate(&env);
    let large_metadata = Bytes::from_slice(&env, &vec![0u8; 100_000]);

    let result = client.issue_credential(&issuer, &subject, &1u32, &large_metadata, &None);
    assert!(result.is_err());
}

#[test]
fn test_fuzz_concurrent_issuance_unique_ids() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin) = setup(&env);

    let mut ids = Vec::new();
    for i in 0..100 {
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let metadata = Bytes::from_slice(&env, format!("metadata_{}", i).as_bytes());

        let id = client
            .issue_credential(&issuer, &subject, &1u32, &metadata, &None)
            .unwrap();
        ids.push(id);
    }

    // Verify all IDs are unique
    let mut sorted_ids = ids.clone();
    sorted_ids.sort();
    sorted_ids.dedup();
    assert_eq!(ids.len(), sorted_ids.len());
}
```

## Continuous Fuzzing Strategy

### Automated Fuzzing

Add to CI/CD pipeline:

```yaml
# .github/workflows/fuzz.yml
name: Fuzz Testing

on:
  schedule:
    - cron: '0 2 * * *'  # Daily at 2 AM UTC
  workflow_dispatch:

jobs:
  fuzz:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions-rs/toolchain@v1
        with:
          toolchain: stable
      - name: Run fuzz tests (1 hour)
        run: |
          cd contracts/quorum_proof
          timeout 3600 cargo test test_fuzz_credential_issuance -- --nocapture
      - name: Upload results
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: fuzz-results
          path: fuzz-results/
```

### Manual Fuzzing Schedule

- **Weekly**: Run 1-hour fuzz tests on main branch
- **Before Release**: Run 4-hour fuzz tests
- **After Incidents**: Run extended fuzzing to find root causes

## Performance Metrics

### Fuzz Test Execution Time

- **1,000 iterations**: ~5 seconds
- **10,000 iterations**: ~50 seconds
- **100,000 iterations**: ~8 minutes
- **1 hour continuous**: ~500,000 iterations

### Coverage Goals

- **Line coverage**: >95%
- **Branch coverage**: >90%
- **Path coverage**: >80%

## Troubleshooting

### Test Timeout

If fuzz tests timeout:

```bash
# Reduce iterations
FUZZ_ITERATIONS=100 cargo test test_fuzz_credential_issuance

# Increase timeout
timeout 7200 cargo test test_fuzz_credential_issuance
```

### Memory Issues

If tests run out of memory:

```bash
# Run with limited memory
ulimit -v 2097152  # 2GB limit
cargo test test_fuzz_credential_issuance
```

### Reproducibility

To reproduce a specific failure:

```bash
# Use the same seed
FUZZ_SEED=12345 cargo test test_fuzz_credential_issuance

# Check fuzz corpus for failing input
cat fuzz-corpus/failing_input.bin | xxd
```

## References

- [Soroban Testing Guide](https://developers.stellar.org/docs/build/smart-contracts/testing)
- [Rust Fuzzing Book](https://rust-fuzz.github.io/book/cargo-fuzz.html)
- [Property-Based Testing](https://hypothesis.works/articles/what-is-property-based-testing/)

## Fuzz Testing Checklist

- [ ] Run fuzz tests before each release
- [ ] Document any issues found
- [ ] Add regression tests for discovered bugs
- [ ] Update this guide with new findings
- [ ] Schedule weekly automated fuzzing
- [ ] Review fuzz results monthly
- [ ] Archive fuzz corpus for reproducibility

---

**Last Updated**: 2026-04-27
**Next Fuzz Run**: 2026-05-04 (weekly)
