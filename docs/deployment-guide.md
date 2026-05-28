# Production Deployment Guide — QuorumProof

This guide covers deploying QuorumProof to Stellar mainnet. Follow every section in order. Do not skip the security checklist.

---

## Prerequisites

- Rust 1.70+ with `wasm32-unknown-unknown` target: `rustup target add wasm32-unknown-unknown`
- Stellar CLI: `cargo install --locked stellar-cli`
- A funded mainnet Stellar account for the deployer key
- A separate funded mainnet Stellar account for the admin key (must be different from deployer)

---

## 1. Environment Setup

### 1.1 Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` for mainnet:

```env
STELLAR_NETWORK=mainnet
STELLAR_RPC_URL=https://mainnet.sorobanrpc.com

# Populated after deployment (step 3)
CONTRACT_QUORUM_PROOF=
CONTRACT_SBT_REGISTRY=
CONTRACT_ZK_VERIFIER=

# Frontend
VITE_STELLAR_NETWORK=mainnet
VITE_STELLAR_RPC_URL=https://mainnet.sorobanrpc.com
VITE_CONTRACT_QUORUM_PROOF=
VITE_CONTRACT_SBT_REGISTRY=
VITE_CONTRACT_ZK_VERIFIER=
```

### 1.2 Configure deployer key

Import your funded mainnet deployer key:

```bash
stellar keys add deployer --secret-key
# Enter your secret key (S...) when prompted
```

Verify the account is funded:

```bash
stellar account show deployer --network mainnet
```

---

## 2. Build

Build all three contracts from a clean state:

```bash
./scripts/build.sh
```

Verify the WASM artifacts exist:

```bash
ls -lh target/wasm32-unknown-unknown/release/*.wasm
```

Expected output: `quorum_proof.wasm`, `sbt_registry.wasm`, `zk_verifier.wasm`.

Run the full test suite before deploying:

```bash
cargo test
```

All tests must pass. Do not deploy with failing tests.

---

## 3. Contract Deployment

Deploy each contract in order. The deployer key pays the deployment fees.

```bash
# Deploy quorum_proof
CONTRACT_QUORUM_PROOF=$(stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/quorum_proof.wasm \
  --source deployer \
  --network mainnet)
echo "CONTRACT_QUORUM_PROOF=$CONTRACT_QUORUM_PROOF"

# Deploy sbt_registry
CONTRACT_SBT_REGISTRY=$(stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/sbt_registry.wasm \
  --source deployer \
  --network mainnet)
echo "CONTRACT_SBT_REGISTRY=$CONTRACT_SBT_REGISTRY"

# Deploy zk_verifier
CONTRACT_ZK_VERIFIER=$(stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/zk_verifier.wasm \
  --source deployer \
  --network mainnet)
echo "CONTRACT_ZK_VERIFIER=$CONTRACT_ZK_VERIFIER"
```

Record all three contract IDs immediately. Update `.env` with the values.

---

## 4. Admin Initialization

### 4.1 Initialize contracts

Initialize each contract with the admin address. Use a dedicated admin account — not the deployer.

```bash
ADMIN_ADDRESS=<your-admin-stellar-address>

stellar contract invoke \
  --id $CONTRACT_QUORUM_PROOF \
  --source deployer \
  --network mainnet \
  -- initialize \
  --admin $ADMIN_ADDRESS

stellar contract invoke \
  --id $CONTRACT_SBT_REGISTRY \
  --source deployer \
  --network mainnet \
  -- initialize \
  --admin $ADMIN_ADDRESS \
  --quorum-proof-id $CONTRACT_QUORUM_PROOF

stellar contract invoke \
  --id $CONTRACT_ZK_VERIFIER \
  --source deployer \
  --network mainnet \
  -- initialize \
  --admin $ADMIN_ADDRESS
```

### 4.2 Configure admin as multisig (required)

The admin account must be a multisig before any admin operations are performed. A single-key admin is a critical security risk.

Set up 2-of-3 multisig on the admin account:

```bash
stellar account set-options \
  --source admin \
  --network mainnet \
  --master-weight 1 \
  --med-threshold 2 \
  --high-threshold 2 \
  --signer <signer2-public-key>,1 \
  --signer <signer3-public-key>,1
```

Verify the multisig configuration:

```bash
stellar account show $ADMIN_ADDRESS --network mainnet
```

Confirm `med_threshold` and `high_threshold` are both `2` and three signers are listed.

### 4.3 Verify initialization

```bash
# Confirm admin is set correctly on each contract
stellar contract invoke \
  --id $CONTRACT_QUORUM_PROOF \
  --network mainnet \
  -- get_admin
```

---

## 5. Security Checklist

Complete every item before going live. This checklist is a minimum — also review `docs/security-audit-checklist.md`.

### Key Management

- [ ] Deployer key and admin key are different accounts
- [ ] Admin account is configured as multisig (2-of-3 minimum)
- [ ] All signing keys are stored in hardware wallets (Ledger or equivalent)
- [ ] No secret keys are stored in `.env`, version control, CI logs, or shell history
- [ ] A secondary admin key is registered on-chain as a backup (see `docs/disaster-recovery.md` §1.1)
- [ ] Key rotation schedule is documented (recommended: every 90 days)

### Contract State

- [ ] All three contracts are initialized (admin set, cross-contract addresses linked)
- [ ] `verify_claim` (ZK stub) is confirmed admin-gated — do not expose to public callers
- [ ] Contract IDs are recorded in a team password manager and `.env.example` comments
- [ ] Deployment transaction hashes are recorded for audit trail

### Rate Limiting & Access Control

- [ ] RPC endpoint is authenticated (use a private RPC node or API key, not the public endpoint)
- [ ] Frontend/API layer enforces rate limiting on contract invocations
- [ ] Admin functions are not exposed via any public API endpoint

### Audit Logging

- [ ] Contract event monitoring is configured (Stellar Horizon event stream or equivalent)
- [ ] Alerts are set for: `pause` events, `revoke_credential` events, unusual dispute volume
- [ ] Logs are retained for a minimum of 2 years

### ZK Verifier Warning

- [ ] Team is aware that `verify_claim` is a non-functional stub (see README warning)
- [ ] No production credential decision relies on `verify_claim` output
- [ ] `verify_claim` access is restricted to admin only

---

## 6. Rollback Procedures

### 6.1 Contract upgrade rollback

If a contract upgrade introduces a regression, roll back by re-deploying the previous WASM:

```bash
# Install the previous WASM and get its hash
stellar contract install \
  --wasm <path-to-previous.wasm> \
  --source deployer \
  --network mainnet
# Note the returned WASM hash

# Invoke upgrade with the previous hash (requires admin multisig)
stellar contract invoke \
  --id $CONTRACT_QUORUM_PROOF \
  --source admin \
  --network mainnet \
  -- upgrade \
  --admin $ADMIN_ADDRESS \
  --new-wasm-hash <PREVIOUS_WASM_HASH>
```

See `docs/contract-upgrade-strategy.md` for the full upgrade and rollback procedure.

### 6.2 Emergency pause

If a critical vulnerability is discovered, pause the contract immediately:

```bash
stellar contract invoke \
  --id $CONTRACT_QUORUM_PROOF \
  --source admin \
  --network mainnet \
  -- pause \
  --admin $ADMIN_ADDRESS
```

Pausing blocks `issue_credential`, `attest`, and `revoke_credential`. Read-only functions remain accessible. Unpause only after the vulnerability is resolved and a patched contract is deployed.

### 6.3 Full redeployment

If contracts must be redeployed from scratch (e.g., key compromise with no backup):

1. Deploy new contracts following Section 3
2. Re-initialize with a new admin key (Section 4)
3. Coordinate with all issuers to re-issue credentials — on-chain state from the old contracts is not migrated automatically
4. Update all `.env` files, frontend configs, and notify credential holders

See `docs/disaster-recovery.md` for the full recovery procedure.

---

## 7. Troubleshooting

**`Error: account not found`**
The deployer or admin account is not funded on mainnet. Fund the account with at least 10 XLM before deploying.

**`Error: contract already initialized`**
`initialize` was called twice. The contract is already set up — verify the admin address with `get_admin` and proceed.

**`Error: insufficient funds for fee`**
Increase the deployer account balance. Contract deployment on mainnet requires ~1–2 XLM per contract.

**`Error: invalid wasm`**
The WASM artifact is missing or corrupt. Re-run `./scripts/build.sh` and verify the files exist before deploying.

**Contract invocation returns `HostError: unauthorized`**
The caller is not the admin or the admin multisig threshold was not met. Ensure all required signers have signed the transaction.

**RPC timeout or connection refused**
The public RPC endpoint may be rate-limiting. Switch to a private RPC node or add an API key to `STELLAR_RPC_URL`.

---

## 8. Post-Deployment Verification

After deployment, run these checks to confirm everything is working:

```bash
# Issue a test credential (requires an issuer account)
stellar contract invoke \
  --id $CONTRACT_QUORUM_PROOF \
  --source issuer \
  --network mainnet \
  -- issue_credential \
  --subject <subject-address> \
  --credential-type 1 \
  --metadata-hash <32-byte-hash>

# Verify the credential was stored
stellar contract invoke \
  --id $CONTRACT_QUORUM_PROOF \
  --network mainnet \
  -- get_credential \
  --credential-id 1
```

If both calls succeed, the deployment is functional.

---

## References

- [Disaster Recovery Procedures](disaster-recovery.md)
- [Contract Upgrade Strategy](contract-upgrade-strategy.md)
- [Security Audit Checklist](security-audit-checklist.md)
- [Threat Model & Security](threat-model.md)
- [Stellar CLI Documentation](https://developers.stellar.org/docs/tools/stellar-cli)
- [Soroban Contract Deployment](https://developers.stellar.org/docs/build/smart-contracts/getting-started/deploy-to-testnet)
