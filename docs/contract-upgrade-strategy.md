# Contract Upgrade Strategy

## Overview

QuorumProof uses Soroban's built-in contract upgrade mechanism to enable seamless updates without losing state. This document outlines the procedures, migration strategies, and testing protocols for upgrading the QuorumProof contract.

## Upgrade Mechanism

### How Soroban Upgrades Work

Soroban contracts can be upgraded by deploying new WASM code while preserving all stored state. The upgrade is performed via the `env.deployer().update_current_contract_wasm()` function, which:

1. Validates the new WASM hash
2. Replaces the contract code
3. Preserves all storage (DataKey entries remain intact)
4. Maintains the contract address

### Authorization

Upgrades are **admin-only** operations. The `upgrade()` function requires:

```rust
pub fn upgrade(env: Env, admin: Address, new_wasm_hash: soroban_sdk::BytesN<32>) {
    admin.require_auth();
    env.deployer().update_current_contract_wasm(new_wasm_hash);
}
```

Only the address stored in `DataKey::Admin` can authorize upgrades.

## Upgrade Procedures

### Pre-Upgrade Checklist

Before initiating an upgrade:

1. **Code Review**: All changes must be reviewed and approved
2. **Testing**: Run full test suite on testnet
3. **Backward Compatibility**: Ensure new code handles existing storage format
4. **State Snapshot**: Document current contract state
5. **Rollback Plan**: Prepare previous WASM hash for emergency rollback
6. **Communication**: Notify all stakeholders (issuers, holders, verifiers)

### Step-by-Step Upgrade Process

#### 1. Build New WASM

```bash
cd contracts/quorum_proof
cargo build --release --target wasm32-unknown-unknown
```

The compiled WASM is located at:
```
target/wasm32-unknown-unknown/release/quorum_proof.wasm
```

#### 2. Compute WASM Hash

```bash
# Using soroban-cli
soroban contract install --wasm target/wasm32-unknown-unknown/release/quorum_proof.wasm \
  --network testnet

# Output will include the WASM hash (32-byte hex string)
```

#### 3. Invoke Upgrade

```bash
# Using soroban-cli
soroban contract invoke \
  --id <CONTRACT_ID> \
  --network testnet \
  --source-account <ADMIN_ACCOUNT> \
  -- upgrade \
  --admin <ADMIN_ADDRESS> \
  --new-wasm-hash <NEW_WASM_HASH>
```

#### 4. Verify Upgrade

```bash
# Check contract version or call a test function
soroban contract invoke \
  --id <CONTRACT_ID> \
  --network testnet \
  -- get_credential_count
```

### Emergency Rollback

If the upgrade causes critical issues:

1. **Identify Previous WASM Hash**: Retrieve from deployment records
2. **Invoke Rollback**: Call `upgrade()` with previous WASM hash
3. **Verify State**: Confirm all data is intact

```bash
soroban contract invoke \
  --id <CONTRACT_ID> \
  --network testnet \
  --source-account <ADMIN_ACCOUNT> \
  -- upgrade \
  --admin <ADMIN_ADDRESS> \
  --new-wasm-hash <PREVIOUS_WASM_HASH>
```

## Migration Strategy

### Storage Compatibility

QuorumProof uses the `DataKey` enum to manage all storage. When upgrading:

- **Existing DataKeys**: Remain accessible and unchanged
- **New DataKeys**: Can be added without affecting existing data
- **Removed DataKeys**: Old data persists but becomes inaccessible (safe to ignore)
- **Modified DataKeys**: Requires careful migration logic

### Adding New Features

When adding new features that require storage:

1. **Define New DataKey Variants**: Add to the `DataKey` enum
2. **Initialize Defaults**: Use `.unwrap_or()` for missing keys
3. **Lazy Migration**: Populate new storage on first access
4. **No Data Loss**: Existing credentials and slices remain intact

Example:

```rust
// Old code
pub fn get_attestor_count(env: Env, address: Address) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::AttestorCount(address))
        .unwrap_or(0u64)
}

// After upgrade with new feature
pub fn get_holder_attestation_count(env: Env, holder: Address) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::HolderAttestationCount(holder))  // New key
        .unwrap_or(0u64)  // Defaults to 0 if not yet set
}
```

### Modifying Existing Structures

If you need to modify a struct (e.g., `Credential`):

1. **Add New Fields**: Always append, never remove
2. **Use Option Types**: Make new fields `Option<T>` for backward compatibility
3. **Provide Defaults**: Use `.unwrap_or()` when reading old data

Example:

```rust
// Before upgrade
pub struct Credential {
    pub id: u64,
    pub subject: Address,
    pub issuer: Address,
    pub credential_type: u32,
    pub metadata_hash: soroban_sdk::Bytes,
    pub revoked: bool,
    pub expires_at: Option<u64>,
    pub version: u32,
}

// After upgrade (adding new field)
pub struct Credential {
    pub id: u64,
    pub subject: Address,
    pub issuer: Address,
    pub credential_type: u32,
    pub metadata_hash: soroban_sdk::Bytes,
    pub revoked: bool,
    pub expires_at: Option<u64>,
    pub version: u32,
    pub grace_period: Option<u64>,  // New field, optional for compatibility
}
```

### Data Migration Patterns

#### Pattern 1: Lazy Migration

Migrate data on first access:

```rust
pub fn get_credential(env: Env, credential_id: u64) -> Credential {
    let mut credential: Credential = env
        .storage()
        .instance()
        .get(&DataKey::Credential(credential_id))
        .unwrap_or_else(|| panic_with_error!(&env, ContractError::CredentialNotFound));
    
    // Lazy migration: set default if new field is missing
    if credential.grace_period.is_none() {
        credential.grace_period = Some(0);
        env.storage()
            .instance()
            .set(&DataKey::Credential(credential_id), &credential);
    }
    
    credential
}
```

#### Pattern 2: Batch Migration

Migrate all data in a single admin-only call:

```rust
pub fn migrate_credentials(env: Env, admin: Address) {
    admin.require_auth();
    let stored_admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .unwrap_or_else(|| panic_with_error!(&env, ContractError::InvalidInput));
    assert!(admin == stored_admin, "only admin can migrate");
    
    let total: u64 = env
        .storage()
        .instance()
        .get(&DataKey::CredentialCount)
        .unwrap_or(0u64);
    
    for id in 1..=total {
        if let Some(mut credential) = env
            .storage()
            .instance()
            .get::<DataKey, Credential>(&DataKey::Credential(id))
        {
            if credential.grace_period.is_none() {
                credential.grace_period = Some(0);
                env.storage()
                    .instance()
                    .set(&DataKey::Credential(id), &credential);
            }
        }
    }
}
```

## Testing Procedures

### Unit Tests

Run all tests before upgrade:

```bash
cd contracts/quorum_proof
cargo test
```

### Integration Tests

Test on testnet before mainnet:

1. **Deploy to Testnet**: Deploy new contract version
2. **Run Test Suite**: Execute all integration tests
3. **Verify State**: Check that existing credentials are accessible
4. **Test New Features**: Verify new functionality works correctly

### Upgrade Simulation

Simulate the upgrade process:

```bash
# 1. Deploy current version
soroban contract deploy --wasm target/wasm32-unknown-unknown/release/quorum_proof.wasm \
  --network testnet

# 2. Create test data
soroban contract invoke --id <CONTRACT_ID> --network testnet \
  -- issue_credential --subject <ADDR> --credential-type 1 --metadata-hash <HASH>

# 3. Build new version with changes
cargo build --release --target wasm32-unknown-unknown

# 4. Install new WASM and get hash
soroban contract install --wasm target/wasm32-unknown-unknown/release/quorum_proof.wasm \
  --network testnet

# 5. Perform upgrade
soroban contract invoke --id <CONTRACT_ID> --network testnet \
  -- upgrade --admin <ADMIN> --new-wasm-hash <NEW_HASH>

# 6. Verify data is intact
soroban contract invoke --id <CONTRACT_ID> --network testnet \
  -- get_credential --credential-id 1
```

### Regression Testing

After upgrade, verify:

- ✅ All existing credentials are accessible
- ✅ All existing slices are accessible
- ✅ Attestation history is preserved
- ✅ Admin functions still work
- ✅ New features function correctly
- ✅ No data corruption

## Version Management

### Tracking Versions

Store upgrade history in a separate log:

```
Upgrade Log:
- v1.0.0 (Hash: 0x1234...): Initial deployment
- v1.1.0 (Hash: 0x5678...): Added grace period feature
- v1.2.0 (Hash: 0x9abc...): Added whitelist feature
```

### Semantic Versioning

Follow semantic versioning for releases:

- **MAJOR**: Breaking changes (requires migration)
- **MINOR**: New features (backward compatible)
- **PATCH**: Bug fixes (backward compatible)

## Mainnet Upgrade Checklist

Before upgrading on mainnet:

- [ ] Code reviewed by 2+ team members
- [ ] All tests pass on testnet
- [ ] Upgrade tested on testnet with real data
- [ ] Rollback plan documented and tested
- [ ] All stakeholders notified
- [ ] Upgrade window scheduled (low-traffic time)
- [ ] Monitoring alerts configured
- [ ] Post-upgrade verification plan ready

## Troubleshooting

### Issue: Upgrade Fails with "Invalid WASM Hash"

**Solution**: Ensure the WASM hash is correctly computed and the WASM is installed on the network.

### Issue: Contract State Becomes Inaccessible

**Solution**: Rollback to previous version. State is preserved; the issue is likely in the new code.

### Issue: New Features Don't Work After Upgrade

**Solution**: Check that new DataKey variants are properly defined and initialized.

### Issue: Performance Degradation After Upgrade

**Solution**: Profile the new code. Consider optimizing hot paths or rolling back if critical.

## References

- [Soroban Contract Upgrade Documentation](https://developers.stellar.org/docs/learn/storing-data)
- [Stellar Deployer Interface](https://developers.stellar.org/docs/learn/storing-data#deployer)
- [QuorumProof Architecture](./architecture.md)
- [Error Codes Reference](./error-codes.md)
