# Security-Focused Fuzzing Guide

This document describes the fuzzing infrastructure for QuorumProof, focusing on security-critical functions in Soroban contracts.

## Overview

Fuzzing is an automated testing technique that feeds random, malformed, or edge-case inputs to programs to discover crashes, memory safety issues, and logic bugs. The QuorumProof project uses **libFuzzer** to test cryptographic operations and contract logic.

## Why Fuzzing Matters

Fuzzing discovers edge cases that manual testing misses:
- **Overflow/Underflow**: Integer arithmetic bugs in credential IDs
- **Malformed Proofs**: Invalid ZK proof handling in `verify_claim`
- **Slice Consistency**: Attestor list integrity under random updates
- **Metadata Parsing**: Arbitrary byte sequences as credential metadata

## Fuzz Targets

### 1. `fuzz_verification_functions` (NEW)
**Location:** `fuzz/fuzz_targets/fuzz_verification_functions.rs`

Tests the verification pathway with fuzzy inputs:
- Multiple credential issuances
- Slice creation with varying thresholds
- Attestation status checks
- Attestor retrieval

**What It Catches:**
- Credential ID collision bugs
- Slice threshold validation issues
- Off-by-one errors in attestor lists
- State inconsistency in multi-attestor flows

### 2. `fuzz_bbs_plus_operations` (NEW)
**Location:** `fuzz/fuzz_targets/fuzz_bbs_plus_operations.rs`

Tests BBS+ cryptographic operations:
- Message preprocessing
- Nonce generation
- Proof type handling
- Batch size calculations

**What It Catches:**
- Memory safety issues in curve arithmetic
- Panic conditions on large inputs
- Batch processing edge cases
- Numeric overflow in proof aggregation

### 3. `fuzz_zk_verifier`
**Location:** `fuzz/fuzz_targets/fuzz_zk_verifier.rs`

Tests the ZK verification contract stub:
- Arbitrary proof bytes
- All claim types
- Various credential IDs

**Security Check:** Ensures empty proofs never pass verification.

### 4. `fuzz_credential_issuance`
**Location:** `fuzz/fuzz_targets/fuzz_credential_issuance.rs`

Tests credential creation:
- Metadata hash edge cases
- Credential type boundaries
- Expiration timestamp variations
- ID assignment uniqueness

### 5. `fuzz_quorum_intersection` (NEW — Issue #1396)
**Location:** `fuzz/fuzz_targets/fuzz_quorum_intersection.rs`

Targets the core Byzantine-safety primitives the "Quorum Slice" trust model
depends on: `is_quorum` (via `create_slice` + `check_quorum_intersection`)
and `check_quorum_intersection` itself. Generates two slices with a
controllable attestor overlap — including fully disjoint slices (zero shared
attestors), single-attestor slices, and thresholds pinned to the exact slice
size — and asserts `check_quorum_intersection` never certifies safety
(`is_safe = true`) for a candidate node set that doesn't actually meet both
slices' weighted thresholds. See the invariant doc comment at the top of the
fuzz target for the FBA safety property being tested.

**What It Catches:**
- A certificate being accepted for two slices that share zero attestors
- Off-by-one errors at threshold boundaries (`threshold == total weight`)
- Weight-accumulation bugs that under/over-count a candidate set's power in
  a slice

**Manual run:**
```bash
cd fuzz
cargo +nightly fuzz run fuzz_quorum_intersection -- -max_total_time=60
```

## Running Fuzz Tests

### Build Fuzz Harnesses
```bash
cd fuzz
cargo build --release
```

### Run Individual Fuzz Target
```bash
# Run verification functions fuzzer for 10 seconds
cargo +nightly fuzz run fuzz_verification_functions -- -max_len=4096 -max_total_time=10

# Run BBS+ fuzzer for 60 seconds
cargo +nightly fuzz run fuzz_bbs_plus_operations -- -max_total_time=60
```

### Run All Fuzz Targets (CI)
```bash
./scripts/fuzz_all.sh
```

### Continuous Fuzzing (Production)
```bash
# Run for extended period (useful for CI farms)
cargo +nightly fuzz run fuzz_verification_functions -- -max_total_time=3600 -timeout=10
```

## Interpreting Results

### Success (No Findings)
```
#1000000 INITED cov: 2500 ft: 450 corp: 123
#2000000 pulse cov: 2501 ft: 451 corp: 124 lim: 4096
#3000000 DONE   cov: 2502 ft: 452 corp: 125 lime: 4096
```

All inputs processed without crashes or panics → Target is robust.

### Crash/Panic Detected
```
ERROR: libFuzzer encountered a crash:
    artifact crash-0xde01 with input of length 256
```

Fuzz target has found a reproducible crash. The failing input is saved for investigation.

### Address Sanitizer (ASAN) Findings
```
AddressSanitizer:SEGV on unknown address 0x60...
```

Memory safety issue found (rare in Rust, but possible in C dependencies).

## Reproducing Bugs from Crashes

When fuzzing finds a crash:

1. **Locate Artifact**
   ```bash
   ls fuzz/artifacts/fuzz_verification_functions/
   # Shows: crash-0xabc123...
   ```

2. **Reproduce with Exact Input**
   ```bash
   cargo +nightly fuzz run fuzz_verification_functions fuzz/artifacts/fuzz_verification_functions/crash-0xabc123
   ```

3. **Minimize Crash Input**
   ```bash
   cargo +nightly fuzz cmin fuzz_verification_functions
   ```
   This reduces the crash input to the smallest version that still reproduces the bug.

4. **Add Regression Test**
   ```rust
   #[test]
   fn test_regression_issue_xyzabc() {
       // Use the minimal crash input here
   }
   ```

## CI/CD Integration

Fuzz tests run in CI with these settings:

- **Testnet PR Check**: Run each target for 30 seconds
- **Nightly Build**: Run each target for 5 minutes
- **Weekly**: Run each target for 1 hour with address sanitizer

Configuration: `.github/workflows/fuzz.yml`

## Performance Tuning

### Fuzz Faster
- **Increase Corpus Size:** `corpus_size=1000000`
- **Disable Coverage Instrumentation:** `-disable_coverage=1`
- **Max Input Length:** `-max_len=4096`

### Find More Bugs
- **Extended Time:** `-max_total_time=3600`
- **Multiple Workers:** `-workers=4`
- **Aggressive Mutations:** `-len_control=1`

## Best Practices

1. **Keep Fuzz Targets Simple**
   - Don't add validation logic to fuzz harnesses
   - Let contracts reject invalid inputs
   - Focus on finding crashes, not testing behavior

2. **Minimize External Dependencies**
   - Fuzz targets should compile quickly
   - Avoid heavy initialization in fuzz loops
   - Use mock environments for contract testing

3. **Maintain Corpus**
   - Save interesting inputs in version control
   - Reuse corpus across runs to speed up bug discovery
   - Archive corpus snapshots before breaking API changes

4. **Monitor Trends**
   - Track coverage growth over time
   - Alert if coverage regresses after code changes
   - Aim for >80% coverage of security-critical paths

## Known Limitations

- **Fuzzing is Non-Deterministic**: Same target may find different bugs on different runs
- **Coverage Gaps**: Some code paths may not be reachable with random inputs
- **Performance Trade-off**: Thorough fuzzing takes significant CPU time
- **Proof Verification**: ZK proof fuzzing is limited due to stub implementation

## Future Enhancements

- [ ] Libfuzzer integration with GitHub releases (OSS-Fuzz)
- [ ] Structured fuzzing with custom mutators
- [ ] Differential fuzzing against reference implementation
- [ ] Property-based testing with proptest
- [ ] Coverage-guided fuzzing on deployed contracts

## References

- [libFuzzer Documentation](https://llvm.org/docs/LibFuzzer/)
- [Cargo Fuzz Guide](https://rust-fuzz.github.io/book/cargo-fuzz.html)
- [OWASP Fuzzing Guide](https://owasp.org/www-community/attacks/Fuzzing)

## Support

For issues, crashes, or fuzz target improvements:
1. File a GitHub issue with the crash artifact
2. Include the reproduction steps
3. Attach minimized input if available
