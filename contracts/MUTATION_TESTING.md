# Mutation Testing for QuorumProof Contracts

This document describes the mutation testing setup and strategy for the QuorumProof smart contracts (Issue #1246).

## Overview

**Mutation testing** systematically introduces small bugs ("mutants") into the code and runs the test suite to verify that tests catch these bugs. A test suite that misses mutants has gaps in coverage.

### Why Mutation Testing?

- **100% line coverage ≠ good tests**: A test could execute a line but never verify its behavior.
- **Detects weak assertions**: Tests that don't fail when they should.
- **Identifies corner cases**: Mutants reveal logic your tests don't exercise.

Example: A function that should return `true` but returns `false`:
```rust
// Original code
fn is_valid() -> bool {
    amount > 0  // Returns true if amount is positive
}

// Mutant (operator replacement)
fn is_valid() -> bool {
    amount < 0  // Returns true if amount is negative
}
```

If no test asserts on a positive amount, this mutant survives undetected.

## Setup

### Installation

Install `cargo-mutants`:

```bash
cargo install cargo-mutants
```

### Configuration

Configuration lives in `cargo-mutants.toml` at the project root. Key settings:

| Setting | Purpose |
|---------|---------|
| `packages` | Crates to mutate (`quorum_proof`, `sbt_registry`, `zk_verifier`) |
| `exclude_globs` | Files to skip (test snapshots, build artifacts) |
| `exclude_patterns` | Code patterns to skip (mock implementations) |
| `timeout_multiplier` | Per-mutant timeout (2.0x normal test time) |
| `print_missed` | Show mutants that tests didn't catch (true for debugging) |

## Running Mutation Tests

### Basic Run

```bash
cd /workspaces/QuorumProof
cargo mutants
```

Runs ~100-500 mutants depending on code size. Each mutant is tested independently.

### For a Single Contract

```bash
cargo mutants -p sbt_registry
```

### Show Missed Mutants (to improve tests)

```bash
cargo mutants --list-mutants | grep -i "sbt"
```

Then run with detailed output:

```bash
cargo mutants --verbose
```

### Run a Specific Mutant Number

```bash
cargo mutants --mutant 42
```

Useful for debugging why a specific mutant survived.

## Output Interpretation

### Summary Format

```
Running mutation tests
  Mutation testing in /workspaces/QuorumProof
  Finished: 15 mutants/3 scenarios, killed 14, missed 1, timeouts 0, unviable 0
  Mutation score: 93.3%
```

**Mutation Score** = Killed Mutants / (Killed + Missed)

- **93.3%** = Good (most bugs caught)
- **<80%** = Gap in tests (improve test coverage)
- **100%** = Perfect (no survived mutants)

### Missed Mutant Example

```
sbt_registry: src/lib.rs:1500 replace >= with >
  Function: initiate_sbt_clawback
  Location: expires_at >= current_time + timelock_seconds

  Mutant: >= -> >
  Summary: Mutation survived
  
  Recommendation: Add test case where current_time + timelock_seconds == expires_at
```

This tells you that your tests never check the boundary condition (exact equality).

## Mutation Operators

Common mutations introduced by `cargo-mutants`:

| Original | Mutant | Example |
|----------|--------|---------|
| `>` | `>=` | `count > 10` → `count >= 10` |
| `<` | `<=` | `index < len` → `index <= len` |
| `==` | `!=` | `status == "active"` → `status != "active"` |
| `&&` | `\|\|` | `auth && balance > 0` → `auth \|\| balance > 0` |
| `+` | `-` | `expires_at = now + 1000` → `now - 1000` |
| `true` | `false` | `return true` → `return false` |
| Function removal | (call site panic) | Removes function call entirely |

## Strategy: Priority Mutation Testing

Given resource constraints, focus on high-risk areas:

### Tier 1: Security-Critical (Priority)

Focus mutation testing on:

- **Authorization checks** (`require_auth()`, permission validation)
- **Timelock enforcement** (clawback expiry, grace periods)
- **Atomic operations** (all-or-nothing batch operations)
- **Boundary conditions** (off-by-one, edge cases)
- **State transitions** (status changes, ownership updates)

### Tier 2: Consistency (Important)

- Data structure invariants
- Counter increments
- List operations (add, remove, search)

### Tier 3: Low-Risk (Nice to Have)

- Event emission (no state change, logs only)
- Metadata retrieval
- Read-only queries

## Test Coverage Goals (Issue #1246)

### For Issue #1243 (Clawback)

Tests added for mutation coverage:

1. **`test_initiate_sbt_clawback_creates_request`**
   - Mutants: `sbt_id` assignment, `expires_at` calculation, status field
   - Gap: Ensures all fields stored correctly

2. **`test_execute_clawback_after_expiry_succeeds`**
   - Mutants: `>=` → `>`, timestamp comparison
   - Gap: Validates exact timelock boundary

3. **`test_execute_clawback_before_expiry_panics`**
   - Mutants: Removed timelock check, comparison operator flip
   - Gap: Ensures timelock is enforced

4. **`test_duplicate_clawback_panics`**
   - Mutants: Removed duplicate check, wrong condition
   - Gap: Verifies mutual exclusion

5. **`test_cancel_sbt_clawback_succeeds`**
   - Mutants: Status not updated, entry not removed
   - Gap: Verifies full state cleanup

### For Issue #1244 (Batch Operations)

Tests added for mutation coverage:

1. **`test_batch_mint_creates_tokens_in_order`**
   - Mutants: Token ID counter, off-by-one, skipped entries
   - Gap: Ensures all tokens minted, IDs unique

2. **`test_batch_burn_empty_returns_empty`**
   - Mutants: Removed empty check, wrong return
   - Gap: Handles degenerate input

3. **`test_batch_burn_returns_credential_ids`**
   - Mutants: Skipped credential lookup, wrong return
   - Gap: Ensures correct credential returned

4. **`test_batch_transfer_admin_only`**
   - Mutants: Removed admin check, wrong owner assignment
   - Gap: Verifies auth + ownership change

5. **`test_is_valid_batch_size`** & **`test_get_max_batch_size`**
   - Mutants: Boundary changes (`1000` → `999`), removed checks
   - Gap: Pagination limits enforced

## Improving Mutation Score

### When a Mutant Survives

1. **Identify the missed mutant**:
   ```bash
   cargo mutants --verbose 2>&1 | grep -A5 "survived"
   ```

2. **Understand what was mutated**:
   - Read the mutation description (e.g., `>=` → `>`)
   - Locate the line in the code

3. **Write a test that would catch it**:
   - If boundary condition: test exact equality/inequality
   - If removed check: test condition that makes check fail
   - If operator flip: test both sides of comparison

4. **Run mutation tests again**:
   ```bash
   cargo mutants -p sbt_registry
   ```

### Example: Catching an Off-By-One Mutation

**Scenario**: A loop mutates from `i < 10` to `i <= 10` (adds one extra iteration).

**Original Test** (weak):
```rust
#[test]
fn test_batch_mint() {
    let entries = vec![/* 10 items */];
    let ids = client.batch_mint(&entries);
    assert_eq!(ids.len(), 10);  // Passes for both original and mutant!
}
```

**Improved Test** (strong):
```rust
#[test]
fn test_batch_mint_exact_count() {
    let entries = vec![/* 10 items */];
    let ids = client.batch_mint(&entries);
    assert_eq!(ids.len(), 10);  // Catches `len < 10` mutations
    
    // Test with different sizes to catch loop bounds
    let entries_5 = vec![/* 5 items */];
    let ids_5 = client.batch_mint(&entries_5);
    assert_eq!(ids_5.len(), 5);
}

#[test]
fn test_batch_mint_uniqueness() {
    // Ensures no duplicate IDs (catches ID reuse mutations)
    let ids = ...;
    for i in 0..ids.len() {
        for j in i+1..ids.len() {
            assert_ne!(ids[i], ids[j]);
        }
    }
}
```

The second test catches mutations that would duplicate IDs or skip entries.

## Integration with CI/CD

### GitHub Actions Example

```yaml
- name: Run mutation tests
  run: cargo mutants
  
- name: Check mutation score
  run: |
    SCORE=$(cargo mutants --output-format json 2>/dev/null | jq '.mutation_score')
    if (( $(echo "$SCORE < 80" | bc -l) )); then
      echo "Mutation score too low: $SCORE%"
      exit 1
    fi
```

### Interpreting CI Results

- **Failure**: Mutation score < threshold (default 80%)
- **Action**: Review missed mutants, add tests before merging

## Common Pitfalls

### 1. Test Too Simple (Mutation Passes)

```rust
// Weak: no side effect verification
#[test]
fn test_mint() {
    let id = client.mint(&owner, &cred_id, &uri);
    assert!(id > 0);  // Passes even if token not stored
}

// Strong: verify full state change
#[test]
fn test_mint() {
    let id = client.mint(&owner, &cred_id, &uri);
    let token = client.get_token(&id);
    assert_eq!(token.owner, owner);
    assert_eq!(token.credential_id, cred_id);
}
```

### 2. Missing Edge Cases

```rust
// Weak: no boundary testing
#[test]
fn test_clawback_timelock() {
    let clawback_id = initiate(..., 1000);
    // Test only passes with huge timelock
}

// Strong: test boundary
#[test]
fn test_clawback_timelock_exactly_at_expiry() {
    env.ledger().set_timestamp(expires_at);  // Exactly at boundary
    execute(...);  // Should succeed at exact time
}
```

### 3. Ignoring Panic Cases

```rust
// Weak: no panic testing
#[test]
fn test_unauthorized_burn() {
    // Never actually calls burn_sbt as wrong caller
}

// Strong: explicit panic expectation
#[test]
#[should_panic(expected = "UnauthorizedBurn")]
fn test_unauthorized_burn_panics() {
    client.burn_sbt(&wrong_owner, &token_id, &proof);
}
```

## Maintenance

### After Each Feature Release

1. Run mutation tests:
   ```bash
   cargo mutants -p sbt_registry
   ```

2. Review missed mutants:
   ```bash
   cargo mutants --verbose 2>&1 | grep -B3 "survived"
   ```

3. Add tests for any gaps
4. Aim for 85%+ mutation score before releasing

### Quarterly Reviews

- Archive mutation reports
- Track score trends over time
- Identify high-mutation-count modules (candidates for refactoring)

## Further Reading

- [cargo-mutants Documentation](https://mutants.rs/)
- ["Mutation Testing" by Pitest](https://pitest.org/)
- [Google Testing Blog: Mutation Testing](https://testing.googleblog.com/2015/06/mutation-testing-and-test-suites.html)
