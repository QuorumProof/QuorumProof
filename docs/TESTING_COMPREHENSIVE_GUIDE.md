# QuorumProof Testing Comprehensive Guide

This document provides an overview of all testing capabilities implemented in QuorumProof, including end-to-end testing, fuzzing, contract testing, and snapshot testing.

## Table of Contents

1. [Overview](#overview)
2. [Testing Strategy](#testing-strategy)
3. [Running Tests](#running-tests)
4. [Testing Technologies](#testing-technologies)
5. [CI/CD Pipeline](#cicd-pipeline)
6. [Best Practices](#best-practices)

## Overview

QuorumProof implements a comprehensive testing strategy across multiple layers:

```
┌─────────────────────────────────────────────────────────┐
│          End-to-End Testing (Testnet/Futurenet)        │
│   - Real Stellar network integration tests              │
│   - Network condition simulation                        │
│   - Deployment validation                              │
└─────────────────────────────────────────────────────────┘
                            ↑
┌─────────────────────────────────────────────────────────┐
│    API Contract & Snapshot Testing (TypeScript)        │
│   - Consumer-driven contract verification              │
│   - Response snapshot comparison                       │
│   - Breaking change detection                          │
└─────────────────────────────────────────────────────────┘
                            ↑
┌─────────────────────────────────────────────────────────┐
│       Security Fuzzing (libFuzzer)                      │
│   - Verification function testing                      │
│   - BBS+ operation fuzzing                            │
│   - Edge case and crash detection                      │
└─────────────────────────────────────────────────────────┘
                            ↑
┌─────────────────────────────────────────────────────────┐
│     Local Unit & Integration Testing (Soroban)         │
│   - Contract logic verification                        │
│   - State management testing                           │
│   - Upgrade safety validation                          │
└─────────────────────────────────────────────────────────┘
```

## Testing Strategy

### Level 1: Unit Tests (Local)
- **What:** Individual contract functions
- **Tools:** Soroban SDK testutils
- **Run:** `cargo test --lib --workspace`
- **CI:** Every PR, fast feedback

### Level 2: Integration Tests (Local)
- **What:** Multi-contract flows, state transitions
- **Tools:** Soroban SDK, integration_tests crate
- **Run:** `cargo test -p integration_tests`
- **CI:** Every PR, before merge to main

### Level 3: Fuzzing (Security-Focused)
- **What:** Verification functions, BBS+ operations
- **Tools:** libFuzzer, cargo-fuzz
- **Run:** `cargo +nightly fuzz run fuzz_verification_functions`
- **CI:** Every PR (30s), Nightly (5min), Weekly (1hr)

### Level 4: Contract Testing (API)
- **What:** API request/response contracts, breaking changes
- **Tools:** Vitest, supertest
- **Run:** `npm test -- contract-tests.test.ts`
- **CI:** Every PR, blocks merge if broken

### Level 5: Snapshot Testing (API)
- **What:** API response structure validation
- **Tools:** Vitest snapshots
- **Run:** `npm test -- snapshots.test.ts`
- **CI:** Every PR, requires review for changes

### Level 6: End-to-End Testing (Network)
- **What:** Real Stellar network integration
- **Tools:** Soroban RPC client
- **Run:** `./scripts/run_e2e_tests.sh`
- **CI:** Scheduled, optional in PR checks

## Running Tests

### Quick Local Testing
```bash
# All unit and integration tests (fastest)
cargo test

# With coverage
./scripts/coverage.sh

# API tests
cd api-server && npm test
```

### Comprehensive Testing
```bash
# All unit + integration tests
cargo test --workspace

# Fuzzing (security)
cd fuzz && cargo +nightly fuzz run fuzz_verification_functions -- -max_total_time=60

# E2E on testnet
./scripts/run_e2e_tests.sh

# API contract + snapshot tests
cd api-server && npm test -- contract-tests.test.ts snapshots.test.ts
```

### By Test Category

#### Unit Tests
```bash
cargo test --lib --workspace
```

#### Integration Tests
```bash
cargo test -p integration_tests
```

#### Fuzzing
```bash
cd fuzz

# Single target
cargo +nightly fuzz run fuzz_verification_functions -- -max_total_time=30

# All targets (sequential)
for target in fuzz_*.rs; do
    name=$(basename "$target" .rs)
    echo "Fuzzing $name..."
    cargo +nightly fuzz run "$name" -- -max_total_time=30
done
```

#### API Contract Tests
```bash
cd api-server
npm test -- contract-tests.test.ts
```

#### Snapshot Tests
```bash
cd api-server

# Run and compare
npm test -- snapshots.test.ts

# Update snapshots (review first!)
npm test -- snapshots.test.ts -u
```

#### E2E Tests
```bash
# Testnet
STELLAR_NETWORK=testnet ./scripts/run_e2e_tests.sh

# Futurenet
STELLAR_NETWORK=futurenet ./scripts/run_e2e_tests.sh

# Local standalone
STELLAR_NETWORK=standalone ./scripts/run_e2e_tests.sh
```

## Testing Technologies

### 1. Soroban SDK Testutils
- **Purpose:** Unit and integration testing of smart contracts
- **Language:** Rust
- **Location:** `contracts/*/src/lib.rs` tests
- **Docs:** [Soroban Testing](https://developers.stellar.org/docs/learn/testing)

### 2. libFuzzer
- **Purpose:** Automated security testing via input fuzzing
- **Language:** Rust
- **Location:** `fuzz/fuzz_targets/`
- **Docs:** [libFuzzer Documentation](https://llvm.org/docs/LibFuzzer/)

### 3. Vitest
- **Purpose:** Fast unit and integration testing for TypeScript/JavaScript
- **Language:** TypeScript
- **Location:** `api-server/tests/`
- **Docs:** [Vitest Guide](https://vitest.dev/)

### 4. Supertest
- **Purpose:** HTTP assertion library for API testing
- **Language:** TypeScript
- **Location:** `api-server/tests/`
- **Docs:** [Supertest](https://github.com/visionmedia/supertest)

### 5. Soroban RPC Client
- **Purpose:** Integration with real Stellar networks
- **Language:** Rust/TypeScript
- **Location:** `contracts/e2e_tests/src/lib.rs`
- **Docs:** [Soroban RPC](https://developers.stellar.org/docs/learn/soroban-rpc)

## CI/CD Pipeline

### Workflow 1: Continuous Integration (`ci.yml`)
Runs on every PR and push to main/develop:

1. **Contracts Job** (10-15 min)
   - Build contracts (wasm32)
   - Run unit tests
   - Run integration tests
   - Run migration verification
   - Run upgrade safety tests

2. **API Contract Tests Job** (5 min)
   - Run consumer-driven contract tests
   - Run snapshot tests
   - Flag breaking changes

3. **Frontend Job** (5 min)
   - Lint
   - Unit tests
   - Build

4. **Security Job** (2 min)
   - Cargo audit (dependency scanning)
   - TruffleHog (secret detection)

**Status:** Must pass before PR merge

### Workflow 2: Fuzzing (`fuzz.yml`)
Automated security testing:

**On PR/Push:**
- Run each fuzz target for 30 seconds
- Log any crashes found
- Continue on error (doesn't block merge)

**Nightly (Daily at 2 AM UTC):**
- Run each fuzz target for 5 minutes
- Archive crash artifacts
- Alert on failures

**Configuration:** `.github/workflows/fuzz.yml`

### Workflow 3: E2E Testing (`e2e.yml`)
Network integration testing:

**On PR/Push:**
- Test on testnet (30 min timeout)
- Test on futurenet (30 min timeout)
- Continue on error (doesn't block merge)

**Canary (Every 6 hours):**
- Extended test runs
- Upload test results
- Notify on failure

**Configuration:** `.github/workflows/e2e.yml`

## Test Coverage

### Contracts
- Unit tests: ~85% coverage of contract logic
- Integration tests: All critical workflows
- Fuzzing: Verification and BBS+ functions
- E2E: Credential issuance, attestation, verification

### API
- Contract tests: All endpoints and error cases
- Snapshot tests: Response structure validation
- Unit tests: Utility functions and services

### Expected Results

```
✅ Contracts
  ✓ 45 unit tests passing
  ✓ 12 integration tests passing
  ✓ Migration verification passing
  ✓ Upgrade safety passing

✅ API
  ✓ Contract tests: 30+ passing
  ✓ Snapshot tests: 25+ passing

✅ Security
  ✓ No dependency vulnerabilities
  ✓ No hardcoded secrets
  ✓ Fuzzing: No crashes (after initial runs)

✅ E2E (Network Dependent)
  ⊘ Testnet reachability check
  ⊘ Futurenet reachability check
```

## Best Practices

### 1. Test Early and Often
```bash
# Before committing
cargo test && cd api-server && npm test

# Before pushing
cargo test --workspace && cargo test -p integration_tests
```

### 2. Review Snapshot Changes
```bash
# See what changed
npm test -- snapshots.test.ts

# Review before approving
git diff api-server/tests/__snapshots__/

# Then update
npm test -- snapshots.test.ts -u
```

### 3. Run Fuzzing Locally
```bash
# Find bugs before they reach production
cd fuzz
cargo +nightly fuzz run fuzz_verification_functions -- -max_total_time=120
```

### 4. Use Contract Tests for API Changes
```bash
# Verify API changes don't break consumers
npm test -- contract-tests.test.ts

# If tests fail, adjust contract or API
```

### 5. Monitor E2E Test Results
```bash
# Check if testnet/futurenet are healthy
./scripts/run_e2e_tests.sh

# Use standalone for faster iteration
STELLAR_NETWORK=standalone ./scripts/run_e2e_tests.sh
```

## Troubleshooting

### Test Failures

**Contracts:**
```
Error: Contract panicked
```
→ Check `src/lib.rs` for assertion failures
→ Review test setup and mock environment

**API:**
```
Contract violation: Missing required field
```
→ Check `contract-tests.test.ts` for expected contract
→ Fix API response to match contract

**Fuzzing:**
```
SEGV: Segmentation fault
```
→ Check `fuzz/artifacts/` for crash input
→ Reproduce with minimal input
→ File bug with crash report

**E2E:**
```
Connection refused
```
→ Check network status: https://status.stellar.org
→ Try futurenet instead of testnet
→ Use standalone for local testing

### Performance Issues

- **Slow contracts tests:** Build in release mode
- **Slow API tests:** Use in-memory database
- **Slow fuzzing:** Limit input size with `-max_len`
- **Slow E2E:** Use futurenet (faster blocks) or standalone

## Documentation

Detailed guides for each testing level:

- [E2E Testing](./E2E_TESTING.md) — Network integration guide
- [Fuzzing](./FUZZING.md) — Security testing guide
- [API Contract Testing](./API_CONTRACT_TESTING.md) — Consumer-driven contracts
- [Snapshot Testing](./SNAPSHOT_TESTING.md) — Response validation

## Support

### Getting Help
- Check test documentation in `docs/`
- Review test examples in `contracts/*/src/lib.rs` and `api-server/tests/`
- File issues with test-related labels
- Slack: `#testing` channel

### Contributing Tests
1. Add new test with clear purpose
2. Document in appropriate guide
3. Ensure CI passes
4. Get code review approval
5. Merge to main

## Key Metrics

- **Test Coverage:** ~85% contracts, ~75% API
- **Average Test Time:** ~15 minutes (PR CI)
- **E2E Network Tests:** ~30 minutes per network
- **Fuzzing:** 30s-5min per target (configurable)
- **Deployment:** Tests must pass before prod deploy

## Related Resources

- [Stellar Documentation](https://developers.stellar.org/docs)
- [Soroban Testing Guide](https://developers.stellar.org/docs/learn/testing)
- [Rust Testing Guide](https://doc.rust-lang.org/book/ch11-00-testing.html)
- [Vitest Docs](https://vitest.dev/)
- [libFuzzer Reference](https://llvm.org/docs/LibFuzzer/)
