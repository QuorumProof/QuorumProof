# Security Audit Checklist — QuorumProof Contracts

Covers all three Soroban contracts: `quorum_proof`, `sbt_registry`, `zk_verifier`.  
Work through each section in order. Mark each item ✅ pass, ❌ fail, or ⚠️ needs review.

---

## 1. Authentication & Authorization

| # | Check | Contract(s) | Status |
|---|-------|-------------|--------|
| 1.1 | Every state-mutating function calls `caller.require_auth()` before any storage write | all | |
| 1.2 | Admin-only functions verify the caller matches the stored `DataKey::Admin` address | all | |
| 1.3 | `revoke_credential` only allows the original issuer (not subject, not third party) | quorum_proof | |
| 1.4 | `pause` / `unpause` are gated to admin only | quorum_proof | |
| 1.5 | `verify_claim` (ZK stub) is gated to admin only until real ZK is implemented | zk_verifier | |
| 1.6 | `mint` in sbt_registry requires owner auth and cross-validates credential via quorum_proof | sbt_registry | |
| 1.7 | Recovery execution (`execute_recovery`) is restricted to the original issuer | quorum_proof | |
| 1.8 | Blacklist add/remove is restricted to the issuer who created the entry | quorum_proof | |

**Remediation**: Any function missing `require_auth()` must have it added before the first storage read or write. Admin checks must compare against the value stored at `DataKey::Admin`, not a constructor argument.

---

## 2. Input Validation

| # | Check | Contract(s) | Status |
|---|-------|-------------|--------|
| 2.1 | `credential_type` is validated `> 0` before issuance | quorum_proof | |
| 2.2 | `metadata_hash` / `metadata_uri` are validated non-empty before storage | quorum_proof, sbt_registry | |
| 2.3 | `threshold` is validated `> 0` and `<= attestors.len()` in `create_slice` | quorum_proof | |
| 2.4 | Attestor and slice arrays are bounded by `MAX_ATTESTORS_PER_SLICE = 20` | quorum_proof | |
| 2.5 | Batch operations are bounded by `MAX_BATCH_SIZE = 50` | quorum_proof | |
| 2.6 | Multisig approver arrays are bounded by `MAX_MULTISIG_SIGNERS = 10` | quorum_proof | |
| 2.7 | All `Address` inputs pass `require_valid_address` before use | quorum_proof | |
| 2.8 | ZK proof `Bytes` are validated non-empty in `verify_claim` | zk_verifier | |
| 2.9 | `holder_commitment` is validated non-empty in `generate_anonymous_proof_request` | zk_verifier | |

**Remediation**: Add explicit bounds checks and `assert!` / `panic_with_error!` guards at the top of each function. Never rely on downstream storage operations to surface invalid inputs.

---

## 3. Soulbound Token Enforcement

| # | Check | Contract(s) | Status |
|---|-------|-------------|--------|
| 3.1 | `transfer` always panics with `SoulboundNonTransferable` — no code path allows transfer | sbt_registry | |
| 3.2 | `mint` checks `OwnerCredential(owner, credential_id)` key to prevent duplicate SBTs | sbt_registry | |
| 3.3 | `mint` cross-calls `quorum_proof.is_revoked` and panics if credential is revoked | sbt_registry | |
| 3.4 | `burn_sbt` is restricted to the token owner or contract admin | sbt_registry | |
| 3.5 | No function in `sbt_registry` updates the `owner` field of a `SoulboundToken` outside of admin-gated recovery | sbt_registry | |

**Remediation**: The `transfer` function must remain a permanent panic. Any future refactor that adds a transfer path must be treated as a critical security regression.

---

## 4. Credential Lifecycle Integrity

| # | Check | Contract(s) | Status |
|---|-------|-------------|--------|
| 4.1 | Revoked credentials cannot be attested | quorum_proof | |
| 4.2 | Revoked credentials cannot have new SBTs minted against them | sbt_registry | |
| 4.3 | Double revocation is rejected with `"credential already revoked"` | quorum_proof | |
| 4.4 | Expired credentials (`expires_at` in the past) are treated as invalid in `is_attested` | quorum_proof | |
| 4.5 | `DuplicateCredential` error is raised when the same issuer issues the same type to the same subject twice | quorum_proof | |
| 4.6 | Credential recovery cannot be initiated for a revoked credential | quorum_proof | |
| 4.7 | Only one pending recovery per credential (`RecoveryAlreadyExists` guard) | quorum_proof | |

**Remediation**: Any path that skips the `revoked` check before a state mutation is a critical bug. Add a dedicated test for each lifecycle transition.

---

## 5. Quorum Slice & Attestation Logic

| # | Check | Contract(s) | Status |
|---|-------|-------------|--------|
| 5.1 | An attestor cannot attest the same credential+slice pair twice (`DuplicateAttestor`) | quorum_proof | |
| 5.2 | An attestor must be a member of the slice to attest (`NotInSlice`) | quorum_proof | |
| 5.3 | Attestation time windows are enforced: attestations outside the window are rejected | quorum_proof | |
| 5.4 | Fork detection fires when two attestors submit conflicting boolean values for the same slice | quorum_proof | |
| 5.5 | `is_attested` correctly counts weighted attestations against the slice threshold | quorum_proof | |
| 5.6 | Attestation expiry (`expires_at`) is respected in `is_attested` | quorum_proof | |

**Remediation**: Weighted threshold logic must be reviewed for integer overflow. Use `saturating_add` for weight accumulation (already present — verify it is not bypassed in any code path).

---

## 6. Storage & TTL Management

| # | Check | Contract(s) | Status |
|---|-------|-------------|--------|
| 6.1 | Every `storage().instance().set()` call is followed by `extend_ttl(STANDARD_TTL, EXTENDED_TTL)` | all | |
| 6.2 | Persistent storage entries (`Token`, `Owner`, `OwnerTokens`) have TTL extended after write | sbt_registry | |
| 6.3 | No storage entry can be silently evicted during normal operation (TTL covers expected credential lifetime) | all | |
| 6.4 | `initialize` is guarded against double-initialization (`already initialized` assert) | all | |

**Remediation**: Missing `extend_ttl` calls cause silent data loss after ledger eviction. Audit every `set()` call and confirm a corresponding `extend_ttl` follows it.

---

## 7. Cross-Contract Call Safety

| # | Check | Contract(s) | Status |
|---|-------|-------------|--------|
| 7.1 | `sbt_registry.mint` validates the `quorum_proof_id` is set before making cross-contract calls | sbt_registry | |
| 7.2 | Cross-contract calls use the stored `DataKey::QuorumProofId`, not a caller-supplied address | sbt_registry | |
| 7.3 | `quorum_proof` calls to `zk_verifier` pass the admin address from storage, not from the caller | quorum_proof | |
| 7.4 | No cross-contract call passes unvalidated user input as a contract address | all | |

**Remediation**: Never allow a caller to supply the target contract address for a cross-contract call. Always read it from initialized storage to prevent contract substitution attacks.

---

## 8. ZK Verifier Stub Risk

| # | Check | Contract(s) | Status |
|---|-------|-------------|--------|
| 8.1 | `verify_claim` is admin-gated and cannot be called by arbitrary users | zk_verifier | |
| 8.2 | All call sites of `verify_claim` in `quorum_proof` pass the stored admin address | quorum_proof | |
| 8.3 | The README and contract doc comment clearly warn that the stub accepts any non-empty proof | zk_verifier | |
| 8.4 | No production credential decision relies solely on `verify_claim` output until v1.1 | quorum_proof | |

**Remediation**: Until Groth16/PLONK verification is implemented (tracked in issue #ZK-IMPL), treat any `verify_claim` result as untrusted. Do not gate access-control decisions on it.

---

## 9. Pause / Emergency Stop

| # | Check | Contract(s) | Status |
|---|-------|-------------|--------|
| 9.1 | `pause` blocks `issue_credential`, `attest`, `revoke_credential`, and `mint` | quorum_proof, sbt_registry | |
| 9.2 | Read-only functions (`get_credential`, `is_attested`, `get_slice`) remain accessible while paused | quorum_proof | |
| 9.3 | `unpause` is restricted to admin only | quorum_proof | |
| 9.4 | There is no way to permanently brick the contract (admin can always unpause) | quorum_proof | |

**Remediation**: Verify `require_not_paused()` is called at the top of every state-mutating function. Read paths must not call it.

---

## 10. Soroban-Specific Security Issues

### 10.1 Host Function Panics

| # | Check | Contract(s) | Status |
|---|-------|-------------|--------|
| 10.1.1 | All host function calls are wrapped in error handling (e.g., `env.storage()`, `env.events()`) | all | |
| 10.1.2 | `env.invoke_contract()` calls validate the target contract address before invocation | all | |
| 10.1.3 | No unwrap() calls on host function results without explicit panic handling | all | |
| 10.1.4 | Serialization/deserialization errors are caught and converted to contract errors | all | |

**Remediation**: Replace `unwrap()` with `?` operator or explicit error handling. Test with malformed inputs to verify graceful degradation.

### 10.2 Ledger Limits & Constraints

| # | Check | Contract(s) | Status |
|---|-------|-------------|--------|
| 10.2.1 | Storage keys are bounded in size (< 64 bytes) | all | |
| 10.2.2 | Storage values are bounded in size (< 64 KB per entry) | all | |
| 10.2.3 | Batch operations respect the transaction size limit (~100 KB) | quorum_proof | |
| 10.2.4 | Vector/collection sizes are bounded to prevent OOM (MAX_ATTESTORS_PER_SLICE, MAX_BATCH_SIZE) | quorum_proof | |
| 10.2.5 | No unbounded loops over user-supplied data | all | |

**Remediation**: Add explicit size checks before storage writes. Use `clamp()` or `min()` to enforce bounds on user inputs.

### 10.3 TTL (Time-To-Live) Management

| # | Check | Contract(s) | Status |
|---|-------|-------------|--------|
| 10.3.1 | Every persistent storage write is followed by `extend_ttl()` with appropriate TTL values | all | |
| 10.3.2 | TTL values are set to at least `STANDARD_TTL = 16,384` ledgers (~2 days) | all | |
| 10.3.3 | Long-lived data (credentials, slices) use `EXTENDED_TTL = 524,288` ledgers (~60 days) | quorum_proof | |
| 10.3.4 | Temporary data (recovery requests, disputes) use shorter TTL values | quorum_proof | |
| 10.3.5 | No critical state is stored without TTL extension | all | |
| 10.3.6 | TTL renewal is tested in the test suite (verify data persists across ledger boundaries) | all | |

**Remediation**: Audit every `storage().instance().set()` call. Confirm a corresponding `extend_ttl()` follows it. Add integration tests that simulate ledger expiry.

### 10.4 Ledger Entry Expiry Handling

| # | Check | Contract(s) | Status |
|---|-------|-------------|--------|
| 10.4.1 | Expired ledger entries are handled gracefully (no panics on missing data) | all | |
| 10.4.2 | `get()` calls check for `None` before dereferencing | all | |
| 10.4.3 | Credentials with expired TTL are treated as non-existent (not as revoked) | quorum_proof | |
| 10.4.4 | Attestations with expired TTL are excluded from `is_attested` calculations | quorum_proof | |

**Remediation**: Use `Option::unwrap_or_default()` or explicit `match` statements. Never assume a key exists in storage.

### 10.5 Event Emission Safety

| # | Check | Contract(s) | Status |
|---|-------|-------------|--------|
| 10.5.1 | Event topics are valid Soroban symbols (max 32 bytes) | all | |
| 10.5.2 | Event data structures are serializable (no circular references) | all | |
| 10.5.3 | Sensitive data (private keys, secrets) is never emitted in events | all | |
| 10.5.4 | Event emission does not fail the transaction (wrapped in error handling) | all | |

**Remediation**: Use `symbol_short!()` for event topics. Verify event data is public and non-sensitive.

### 10.6 Contract Invocation Safety

| # | Check | Contract(s) | Status |
|---|-------|-------------|--------|
| 10.6.1 | Cross-contract calls use `env.invoke_contract()` with validated addresses | all | |
| 10.6.2 | Contract addresses are stored in persistent storage, not passed as arguments | all | |
| 10.6.3 | Return values from cross-contract calls are validated before use | all | |
| 10.6.4 | No recursive contract calls without depth limits | all | |

**Remediation**: Store contract addresses in `DataKey` enums. Validate return types match expectations.

### 10.7 Authorization & Signature Verification

| # | Check | Contract(s) | Status |
|---|-------|-------------|--------|
| 10.7.1 | `require_auth()` is called for all state-mutating operations | all | |
| 10.7.2 | Multi-signature scenarios use `require_auth()` for each signer | quorum_proof | |
| 10.7.3 | No custom signature verification (always use `require_auth()`) | all | |
| 10.7.4 | Authorization checks happen before any state mutation | all | |

**Remediation**: Never implement custom signature verification. Always use Soroban's built-in `require_auth()`.

### 10.8 Reentrancy Prevention

| # | Check | Contract(s) | Status |
|---|-------|-------------|--------|
| 10.8.1 | Cross-contract calls do not allow callbacks to the same contract | all | |
| 10.8.2 | State is updated before cross-contract calls (checks-effects-interactions pattern) | all | |
| 10.8.3 | No recursive contract invocations without explicit guards | all | |

**Remediation**: Verify the order of operations: validate → update state → call external contracts.

---

## 11. Audit Procedures

### Pre-Audit Preparation
1. Run `cargo test` — all tests must pass with zero failures.
2. Run `./scripts/mutation_test.sh` — mutation score must be ≥ 80%.
3. Run `cargo clippy -- -D warnings` — zero warnings.
4. Confirm WASM binary sizes are within expected bounds (quorum_proof < 200 KB, others < 50 KB).

### Manual Review Steps
1. For each public function: verify auth check → input validation → business logic → storage write → TTL extension order.
2. Trace every cross-contract call: confirm the target address comes from storage, not caller input.
3. Review every `assert!` and `panic_with_error!`: confirm the error variant is appropriate and the message is not information-leaking.
4. Check all integer arithmetic for overflow: look for `+`, `-`, `*` on `u32`/`u64` without `saturating_*` or `checked_*`.
5. Verify the ZK stub is unreachable without admin auth.
6. **Soroban-Specific**: Verify every `storage().instance().set()` is followed by `extend_ttl()`.
7. **Soroban-Specific**: Check for host function panics — all `env.*()` calls should have error handling.
8. **Soroban-Specific**: Validate ledger entry sizes are within limits (< 64 KB per entry).
9. **Soroban-Specific**: Confirm TTL values are appropriate for data lifetime (STANDARD_TTL for temporary, EXTENDED_TTL for persistent).
10. **Soroban-Specific**: Test graceful handling of expired ledger entries (missing data should not panic).

### Automated Checks
```bash
# Full test suite
cargo test

# Mutation testing
./scripts/mutation_test.sh

# Lint
cargo clippy -- -D warnings

# Check for integer overflow patterns (manual grep)
grep -n '\bu32\b.*+\|\bu64\b.*+' contracts/*/src/lib.rs | grep -v saturating | grep -v checked

# Check for missing TTL extensions
grep -n 'storage().instance().set' contracts/*/src/lib.rs | while read line; do
  file=$(echo "$line" | cut -d: -f1)
  linenum=$(echo "$line" | cut -d: -f2)
  nextline=$((linenum + 5))
  if ! sed -n "${linenum},${nextline}p" "$file" | grep -q 'extend_ttl'; then
    echo "Missing TTL extension: $line"
  fi
done

# Check for unwrap() calls
grep -n 'unwrap()' contracts/*/src/lib.rs | grep -v test | grep -v '//'
```

---

## 12. Remediation Severity Guide

| Severity | Definition | SLA |
|----------|-----------|-----|
| **Critical** | Unauthorized state mutation, bypass of `require_auth`, SBT transfer enabled, ZK stub exposed without admin gate, missing TTL extension on critical data | Fix before any mainnet deployment |
| **High** | Missing TTL extension (data loss risk), missing `require_not_paused`, double-initialization possible, host function panics, ledger entry expiry not handled | Fix before next release |
| **Medium** | Missing input bounds check, integer arithmetic without overflow protection, cross-contract address from caller, event emission of sensitive data | Fix within 2 sprints |
| **Low** | Missing doc comment, inconsistent error message, non-critical lint warning, suboptimal TTL values | Fix in next maintenance window |

---

## 13. Soroban-Specific Testing Checklist

Before mainnet deployment, verify:

- [ ] TTL extension tests pass (data persists across ledger boundaries)
- [ ] Expired ledger entry handling is tested (no panics on missing data)
- [ ] Host function error handling is tested (malformed inputs, network failures)
- [ ] Cross-contract call failures are handled gracefully
- [ ] Event emission does not fail transactions
- [ ] Storage size limits are respected (< 64 KB per entry)
- [ ] Batch operations respect transaction size limits
- [ ] Authorization checks work with multi-signature scenarios
- [ ] Reentrancy is prevented (no recursive calls without guards)

---

## 14. Sign-Off

| Role | Name | Date | Signature |
|------|------|------|-----------|
| Lead Auditor | | | |
| Contract Author | | | |
| Security Reviewer | | | |
| Soroban Specialist | | | |

All **Critical** and **High** findings must be resolved and re-verified before sign-off. Soroban-specific checks (Section 10) must be verified by someone familiar with Soroban host functions and ledger constraints.
