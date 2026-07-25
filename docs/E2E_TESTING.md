# End-to-End Testing Guide for QuorumProof

This guide covers end-to-end (E2E) testing on Stellar's testnet and futurenet networks, which validate credential workflows in actual network conditions beyond local unit testing.

## Overview

E2E tests ensure that:
- Credential issuance works on real Stellar networks
- Attestation flows complete correctly with network latency
- Verification operations succeed on-chain
- The system handles network failures gracefully

## Prerequisites

### Required Software
- Rust 1.70+
- Soroban CLI (v21.0+)
- Stellar CLI
- Node.js 18+ (for API server tests)

### Network Access
- Internet connection to reach Stellar RPC endpoints
- (Optional) Funded testnet account for deployment
  ```bash
  stellar keys generate deployer --network testnet
  stellar account fund deployer --testnet
  ```

## Running E2E Tests

### Testnet Tests
```bash
cd contracts/e2e_tests
cargo test --release -- --test-threads=1
```

### Futurenet Tests
Set environment variable and run:
```bash
STELLAR_NETWORK=futurenet cargo test --release -- --test-threads=1
```

### Standalone (Local) Tests
```bash
STELLAR_NETWORK=standalone cargo test
```

## Environment Configuration

Create `.env` file in project root:

```env
# Network selection: testnet, futurenet, or standalone
STELLAR_NETWORK=testnet

# RPC endpoints (auto-detected from STELLAR_NETWORK)
STELLAR_RPC_URL=https://soroban-testnet.stellar.org

# Contract addresses (after deployment)
CONTRACT_QUORUM_PROOF=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4
CONTRACT_SBT_REGISTRY=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4
CONTRACT_ZK_VERIFIER=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4

# Deployer account (for network deployment)
DEPLOYER_SECRET_KEY=S...
```

## CI/CD Integration

E2E tests run automatically on:
1. **Testnet**: Every pull request before merging to main
2. **Canary**: Daily on a schedule to catch network-specific issues
3. **Pre-production**: Before release deployment

See `.github/workflows/e2e.yml` for automated test configuration.

## Test Structure

### Network Health Tests
- Ledger reachability
- RPC endpoint responsiveness
- Network passphrase verification

### Credential Workflow Tests
1. **Issuance Flow**
   - Create new credential on-chain
   - Verify credential storage in registry
   - Confirm immutability

2. **Attestation Flow**
   - Create quorum slice
   - Collect attestations from multiple signers
   - Validate multi-signature threshold

3. **Verification Flow**
   - Submit verification query
   - Process ZK proof (when implemented)
   - Return verification result

### Resilience Tests
- **Network Latency**: Inject delays to simulate real conditions
- **Timeout Handling**: Verify graceful failure on slow responses
- **Retry Logic**: Test exponential backoff and reconnection
- **Rate Limiting**: Validate behavior under RPC rate limits

## Common Issues & Troubleshooting

### "Connection refused" on testnet
- Check internet connectivity
- Verify Stellar RPC endpoint status: https://status.stellar.org
- Try futurenet as alternative: `STELLAR_NETWORK=futurenet cargo test`

### "Insufficient balance" on testnet
- Get testnet XLM: https://laboratory.stellar.org/#create-account
- Or use the Stellar CLI:
  ```bash
  stellar account fund deployer --testnet
  ```

### "Ledger closed" errors
- These are transient network issues - tests retry automatically
- Check ledger availability: `soroban rpc get-ledger --rpc-url <RPC_URL>`

### Rate Limiting
- Testnet has rate limits (100 req/min per IP)
- Futurenet is more lenient for development
- Set `--test-threads=1` to serialize requests

## Writing New E2E Tests

```rust
#[tokio::test]
async fn test_credential_issuance_e2e() {
    let client = StellarE2EClient::new(Network::Testnet).unwrap();
    
    // 1. Verify network is reachable
    assert!(client.health_check().await.unwrap());
    
    // 2. Perform test operations
    let ledger = client.get_ledger().await.unwrap();
    
    // 3. Assert expected outcomes
    assert!(ledger["result"]["sequence"].is_number());
}
```

## Performance Considerations

- **Testnet**: Slower block times, useful for catching real-world delays
- **Futurenet**: Faster feedback, better for rapid testing
- **Standalone**: Instant finality, best for local development

Choose the network based on your testing needs:
- **Development**: Standalone
- **Integration Testing**: Futurenet
- **Pre-release**: Testnet + production simulation

## Network-Specific Behaviors

### Testnet Characteristics
- Network passphrase: "Test SDF Network ; September 2015"
- Block time: ~5 seconds
- Chain reset: Periodically (check Stellar docs)
- Best for: Realistic network conditions before mainnet

### Futurenet Characteristics
- Network passphrase: "Test SDF Future Network ; October 2022"
- Block time: ~2 seconds
- Stable chain: No resets expected
- Best for: Rapid development and experimentation

## Monitoring and Logging

Enable detailed logging:
```bash
RUST_LOG=debug cargo test -- --nocapture --test-threads=1
```

Check Stellar status: https://status.stellar.org

## Next Steps

1. Add contract deployment validation tests
2. Implement automated network failure injection
3. Set up canary deployments with E2E validation
4. Create production smoke tests

For questions or issues, refer to [Stellar Documentation](https://developers.stellar.org/docs).
