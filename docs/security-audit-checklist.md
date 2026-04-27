# Security Audit Checklist

This checklist provides a systematic approach to auditing QuorumProof smart contracts and infrastructure for security vulnerabilities. Use this before each release and when reviewing security-critical changes.

## General Smart Contract Security

### Reentrancy
- [ ] **No external calls before state updates**: Verify all state changes occur before calling external contracts
- [ ] **Check-Effects-Interactions pattern**: Validate contract state before making external calls
- [ ] **No recursive calls**: Ensure functions cannot call themselves directly or indirectly
- [ ] **Atomic operations**: Multi-step operations are protected by locks or state flags
- [ ] **Test reentrancy scenarios**: Include tests that attempt reentrancy attacks

**Soroban-specific**: Soroban's synchronous execution model prevents most reentrancy, but verify no cross-contract calls occur during state mutations.

### Integer Overflow/Underflow
- [ ] **Use safe math**: Leverage Rust's built-in overflow checks (debug mode catches panics)
- [ ] **Validate arithmetic bounds**: Check inputs before operations that could overflow
- [ ] **Test boundary conditions**: Include tests for max/min values
- [ ] **No unchecked arithmetic**: Avoid `wrapping_*` operations without explicit justification
- [ ] **Timestamp arithmetic**: Verify date calculations don't overflow (use u64 for Unix timestamps)

**Example**:
```rust
// Good: Rust panics on overflow in debug mode
let new_balance = balance.checked_add(amount)?;

// Avoid: Silent overflow
let new_balance = balance.wrapping_add(amount);
```

### Authorization & Access Control
- [ ] **Function access control**: All state-modifying functions check caller authorization
- [ ] **Role-based access**: Verify role assignments are correct (admin, attestor, etc.)
- [ ] **No privilege escalation**: Users cannot elevate their own permissions
- [ ] **Caller verification**: Use `env.invoker()` to verify caller identity
- [ ] **Test unauthorized access**: Include tests that verify unauthorized calls fail

**Soroban-specific**: Use `env.invoker()` for caller verification, not `msg.sender()`.

### Storage & State Management
- [ ] **No uninitialized state**: All storage is initialized before use
- [ ] **State consistency**: Related state changes are atomic or protected
- [ ] **No orphaned data**: Deleted records don't leave dangling references
- [ ] **Proper cleanup**: Revoked credentials are marked, not deleted (for audit trail)
- [ ] **Storage limits**: Verify contract doesn't exceed Soroban storage limits

**Soroban-specific**: 
- Check ledger entry size limits (max 64KB per entry)
- Verify TTL (Time-To-Live) management for persistent entries
- Test storage expiry scenarios

### Input Validation
- [ ] **All inputs validated**: Function parameters checked for valid ranges/formats
- [ ] **No empty collections**: Verify quorum slices have at least one attestor
- [ ] **Threshold validation**: Quorum thresholds are <= number of attestors
- [ ] **Metadata validation**: Credential metadata hashes are non-zero
- [ ] **Address validation**: Attestor addresses are valid Stellar accounts

**Example**:
```rust
// Good: Validate before use
require!(threshold > 0 && threshold <= attestors.len(), Error::InvalidThreshold);

// Avoid: Unchecked input
let slice = QuorumSlice { attestors, threshold };
```

## Credential Management Security

### Credential Issuance
- [ ] **Unique credential IDs**: No ID collisions or reuse
- [ ] **Issuer authorization**: Only authorized parties can issue credentials
- [ ] **Metadata immutability**: Credential metadata cannot be modified after issuance
- [ ] **Timestamp validation**: Issue dates are reasonable (not in future)
- [ ] **Duplicate prevention**: Cannot issue identical credentials twice

### Credential Revocation
- [ ] **Revocation authorization**: Only issuer or credential owner can revoke
- [ ] **Revocation finality**: Revoked credentials cannot be un-revoked
- [ ] **Revocation audit trail**: All revocations are logged with timestamp and reason
- [ ] **Revocation verification**: Verifiers check revocation status before accepting credentials
- [ ] **No revocation bypass**: Revoked credentials cannot be re-issued with same ID

### Credential Expiry
- [ ] **Expiry enforcement**: Expired credentials are rejected by verifiers
- [ ] **Expiry date validation**: Expiry dates are after issue dates
- [ ] **Grace period handling**: Define and test any grace periods
- [ ] **Renewal mechanism**: Clear process for renewing expired credentials
- [ ] **Automatic expiry**: Credentials automatically expire without manual revocation

## Quorum Slice Security

### Slice Creation & Management
- [ ] **Threshold validation**: Threshold is between 1 and number of attestors
- [ ] **Attestor uniqueness**: No duplicate attestors in slice
- [ ] **Slice ownership**: Only owner can modify their slice
- [ ] **Slice immutability**: Cannot change slice after credential attestation
- [ ] **Slice deletion**: Slices can be deleted only by owner

### Attestation Logic
- [ ] **Multi-signature verification**: All required attestors have signed
- [ ] **Signature validation**: Signatures are cryptographically valid
- [ ] **Signature uniqueness**: Same attestor cannot sign twice
- [ ] **Attestor authorization**: Attestors are authorized for credential type
- [ ] **Attestation finality**: Attestations cannot be revoked (only credentials)

### Byzantine Fault Tolerance
- [ ] **Quorum threshold**: Threshold prevents single-point-of-failure
- [ ] **Threshold > 50%**: Majority of attestors required (prevents split-brain)
- [ ] **Attestor diversity**: Attestors are independent entities
- [ ] **Collusion resistance**: Threshold makes collusion expensive
- [ ] **Test Byzantine scenarios**: Include tests with malicious attestors

## Zero-Knowledge Verification Security

### Proof Generation
- [ ] **Proof uniqueness**: Same claim generates different proofs (randomness)
- [ ] **Proof validity**: Only valid proofs are accepted
- [ ] **Proof expiry**: Proofs expire after time limit
- [ ] **Claim specificity**: Proofs only validate claimed attributes
- [ ] **No proof reuse**: Proofs cannot be replayed for different claims

### Proof Verification
- [ ] **Proof format validation**: Proofs match expected format
- [ ] **Cryptographic verification**: Proof verification is cryptographically sound
- [ ] **No false positives**: Invalid proofs are rejected
- [ ] **No false negatives**: Valid proofs are accepted
- [ ] **Timing attack resistance**: Verification time doesn't leak information

**Soroban-specific**: 
- Verify host function calls for cryptographic operations don't panic
- Check proof verification doesn't exceed gas limits
- Test with various proof sizes

## Soroban-Specific Security

### Host Function Safety
- [ ] **No panics on invalid input**: Host functions handle errors gracefully
- [ ] **Gas limits**: Operations don't exceed Soroban gas limits
- [ ] **Cryptographic functions**: Use only Soroban-approved crypto (ed25519, sha256)
- [ ] **No unsafe operations**: Avoid `unsafe` Rust code
- [ ] **Error handling**: All host function calls check for errors

**Common Soroban host functions**:
```rust
// Cryptographic operations
env.crypto_sha256(&data)
env.crypto_ed25519_verify(&public_key, &message, &signature)

// Ledger operations
env.ledger().sequence()
env.ledger().timestamp()

// Storage operations
env.storage().persistent().get(&key)
env.storage().persistent().set(&key, &value)
```

### Ledger Entry Limits
- [ ] **Entry size**: No single entry exceeds 64KB
- [ ] **Entry count**: Total entries don't exceed contract limits
- [ ] **TTL management**: Persistent entries have appropriate TTL
- [ ] **TTL renewal**: Long-lived data renews TTL before expiry
- [ ] **Cleanup strategy**: Old data is archived or deleted

**Example TTL management**:
```rust
// Set TTL for persistent entry
env.storage().persistent().set(&key, &value);
env.storage().persistent().extend_ttl(&key, 1_000_000, 2_000_000);
```

### Timestamp & Ledger Safety
- [ ] **Timestamp monotonicity**: Ledger timestamps always increase
- [ ] **No timestamp manipulation**: Contract doesn't rely on user-provided timestamps
- [ ] **Ledger sequence**: Use for ordering, not timing
- [ ] **Time-based logic**: Careful with time-dependent operations (expiry, delays)
- [ ] **Test time scenarios**: Include tests with various timestamps

## Soulbound Token (SBT) Security

### Non-Transferability
- [ ] **Transfer prevention**: `transfer()` function rejects all transfers
- [ ] **Burn prevention**: Tokens cannot be burned or destroyed
- [ ] **Delegation prevention**: Tokens cannot be delegated or approved
- [ ] **Ownership immutability**: Token owner cannot be changed
- [ ] **Test transfer attempts**: Include tests that verify transfers fail

### SBT Binding
- [ ] **Account binding**: SBT is bound to specific Stellar account
- [ ] **No cross-account transfers**: SBT cannot move between accounts
- [ ] **Account recovery**: Define process if account is compromised
- [ ] **Revocation mechanism**: Issuer can revoke SBT if needed
- [ ] **Test binding**: Verify SBT cannot be transferred to other accounts

## Testing & Verification

### Unit Tests
- [ ] **Happy path**: Normal operations work correctly
- [ ] **Error cases**: Invalid inputs are rejected
- [ ] **Boundary conditions**: Edge cases (empty, max size, etc.) are handled
- [ ] **State transitions**: State changes are correct
- [ ] **Coverage**: >90% code coverage

### Integration Tests
- [ ] **Multi-contract interactions**: Contracts work together correctly
- [ ] **Cross-contract calls**: External calls are handled safely
- [ ] **State consistency**: State is consistent across contracts
- [ ] **Error propagation**: Errors propagate correctly
- [ ] **Gas efficiency**: Operations don't exceed gas limits

### Security Tests
- [ ] **Reentrancy tests**: Attempt reentrancy attacks
- [ ] **Authorization tests**: Unauthorized access is blocked
- [ ] **Overflow tests**: Arithmetic boundaries are enforced
- [ ] **Revocation tests**: Revoked credentials are rejected
- [ ] **Byzantine tests**: Malicious attestors are handled

### Fuzz Testing
- [ ] **Credential issuance**: Fuzz with random metadata
- [ ] **Quorum slices**: Fuzz with random attestor sets
- [ ] **Attestation**: Fuzz with random signatures
- [ ] **Proof verification**: Fuzz with random proofs
- [ ] **Long-running**: Run fuzz tests for >1 hour

## Deployment & Operations

### Pre-Deployment
- [ ] **Code review**: All changes reviewed by security team
- [ ] **Audit completion**: External audit completed (if applicable)
- [ ] **Test coverage**: All tests passing, >90% coverage
- [ ] **Gas optimization**: Operations optimized for gas efficiency
- [ ] **Documentation**: Security assumptions documented

### Deployment
- [ ] **Testnet deployment**: Contract deployed to testnet first
- [ ] **Testnet testing**: Full test suite passes on testnet
- [ ] **Mainnet readiness**: Contract ready for mainnet deployment
- [ ] **Upgrade plan**: Clear plan for contract upgrades
- [ ] **Rollback plan**: Plan to rollback if issues discovered

### Post-Deployment
- [ ] **Monitoring**: Contract events monitored for anomalies
- [ ] **Incident response**: Plan for responding to security incidents
- [ ] **Regular audits**: Schedule regular security audits
- [ ] **Dependency updates**: Keep dependencies up-to-date
- [ ] **Threat model review**: Review threat model quarterly

## Threat Model References

See [threat-model.md](./threat-model.md) for detailed threat analysis including:
- Adversary capabilities and motivations
- Attack vectors and mitigations
- Risk assessment and prioritization
- Incident response procedures

## Security Policy

See [SECURITY.md](../SECURITY.md) for:
- Vulnerability disclosure process
- Security contact information
- Patch release procedures
- Security update timeline

## Audit Checklist Usage

1. **Before each release**: Complete this checklist
2. **Document findings**: Record any issues found and resolutions
3. **Track improvements**: Update checklist based on lessons learned
4. **Share results**: Communicate audit results to team
5. **Archive records**: Keep audit records for compliance

## Checklist Version

- **Version**: 1.0
- **Last Updated**: 2026-04-27
- **Next Review**: 2026-07-27 (quarterly)

---

**Questions or concerns?** Contact the security team or open an issue on GitHub.
