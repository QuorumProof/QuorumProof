# QuorumProof CLI (`qp`)

A bash-based command-line toolkit for deploying QuorumProof contracts, verifying credentials, and analyzing quorum slices directly against any Stellar network.

---

## Contents

- [Installation](#installation)
- [Environment Setup](#environment-setup)
- [Commands](#commands)
  - [deploy](#deploy)
  - [verify](#verify)
  - [analyze](#analyze)
- [Exit Codes](#exit-codes)
- [Output Formats](#output-formats)
- [Scripting & CI Integration](#scripting--ci-integration)
- [Troubleshooting](#troubleshooting)

---

## Installation

The CLI lives entirely in `cli/` at the project root — no build step required.

```bash
# Make scripts executable (one-time setup)
chmod +x cli/qp cli/commands/deploy.sh cli/commands/verify.sh cli/commands/analyze.sh
```

Optionally add the `cli/` directory to your `PATH` for convenience:

```bash
export PATH="$PATH:/workspaces/QuorumProof/cli"
# then you can call:
qp deploy --network testnet
```

### Prerequisites

| Tool | Purpose | Required |
|------|---------|----------|
| `stellar` CLI | Contract deployment and invocation | **Yes** |
| `jq` | JSON pretty-printing and parsing | Recommended |
| `bash` 4+ | Script execution | **Yes** |

Install the Stellar CLI: https://developers.stellar.org/docs/tools/developer-tools/cli/install-and-setup

---

## Environment Setup

Copy the example `.env` file and populate it:

```bash
cp .env.example .env
```

Key variables used by the CLI:

```env
# Network selection
STELLAR_NETWORK=testnet

# Contract addresses (set after first deployment)
CONTRACT_QUORUM_PROOF=<your-contract-id>
CONTRACT_SBT_REGISTRY=<your-contract-id>
CONTRACT_ZK_VERIFIER=<your-contract-id>

# Optional: custom WASM output directory
WASM_DIR=target/wasm32-unknown-unknown/release
```

The CLI sources `.env` automatically from the project root. Command-line flags always override environment variables.

Networks are defined in `environments.toml`:

| Name | Description |
|------|-------------|
| `testnet` | Stellar test network (default) |
| `mainnet` | Stellar mainnet |
| `futurenet` | Stellar future network |
| `standalone` | Local development node |

---

## Commands

### Global options

```
./cli/qp --help       Show help
./cli/qp --version    Show version
```

---

### `deploy`

Deploy one or all QuorumProof contracts to a Stellar network.

```
./cli/qp deploy [options]
```

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--network <name>` | Target network | `testnet` / `$STELLAR_NETWORK` |
| `--contract <name>` | `quorum_proof`, `sbt_registry`, `zk_verifier`, or `all` | `all` |
| `--wasm-dir <path>` | Directory containing compiled `.wasm` files | `target/wasm32-unknown-unknown/release` |
| `--dry-run` | Print commands without executing | off |
| `--manifest <path>` | JSON manifest output path | `deployment-<network>.json` |
| `--source <key>` | Stellar signing key name | `deployer` |
| `--help` | Show help | — |

**Examples:**

```bash
# Build contracts first
./scripts/build.sh

# Deploy all contracts to testnet
./cli/qp deploy --network testnet

# Deploy only the zk_verifier
./cli/qp deploy --network testnet --contract zk_verifier

# Preview deployment commands without executing
./cli/qp deploy --network testnet --dry-run

# Deploy to mainnet with a named signing key
./cli/qp deploy --network mainnet --source my-prod-key

# Custom WASM directory
./cli/qp deploy --wasm-dir ./target/release --network testnet
```

**Output (success):**

```json
{
  "network": "testnet",
  "deployed_at": "2026-09-28T07:30:00Z",
  "deployer": "GABC...",
  "wasm_dir": "target/wasm32-unknown-unknown/release",
  "contracts": {
    "quorum_proof": "CABC...",
    "sbt_registry": "CDEF...",
    "zk_verifier": "CGHI..."
  }
}
```

The manifest is written to `deployment-<network>.json` (or `--manifest` path). The previous manifest, if any, is preserved as `<manifest>.previous` to support rollback.

---

### `verify`

Verify a credential by ID, checking both its on-chain data and attestation status.

```
./cli/qp verify --credential-id <id> [options]
```

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--credential-id <id>` | Credential ID to look up (**required**) | — |
| `--network <name>` | Network to query | `testnet` / `$STELLAR_NETWORK` |
| `--contract <address>` | `quorum_proof` contract address | `$CONTRACT_QUORUM_PROOF` |
| `--output <format>` | `json`, `table`, or `minimal` | `table` |
| `--source <key>` | Stellar key for simulation | `deployer` |
| `--help` | Show help | — |

**Examples:**

```bash
# Verify credential 42 on testnet (table output)
./cli/qp verify --credential-id 42

# JSON output, useful for piping to jq
./cli/qp verify --credential-id 42 --output json

# Single-line minimal output
./cli/qp verify --credential-id 42 --output minimal

# Query against mainnet with an explicit contract address
./cli/qp verify \
  --credential-id 42 \
  --network mainnet \
  --contract CABC...

# Use in a shell conditional
if ./cli/qp verify --credential-id 42 --output minimal; then
  echo "Credential is attested"
else
  echo "Credential is not attested"
fi
```

**Output formats:**

`table` (default):
```
╔══════════════════════════════════════╗
║     QuorumProof Credential Report    ║
╚══════════════════════════════════════╝

  Credential ID:       42
  Network:             testnet
  Contract:            CABC...
  Queried at:          2026-09-28T07:30:00Z

  Raw credential:
    { "subject": "G...", "credential_type": "EngineeringLicense", ... }

  Attestation status: ✓ ATTESTED
```

`json`:
```json
{
  "queried_at": "2026-09-28T07:30:00Z",
  "network": "testnet",
  "contract": "CABC...",
  "credential_id": 42,
  "attested": true,
  "raw_credential": { ... }
}
```

`minimal`:
```
42 attested:true
```

**Exit codes:** `0` = attested, `1` = not attested or error.

---

### `analyze`

Analyze a quorum slice to see its attestors, threshold, and coverage.

```
./cli/qp analyze --slice-id <id> [options]
```

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--slice-id <id>` | Slice ID to analyze (**required**) | — |
| `--network <name>` | Network to query | `testnet` / `$STELLAR_NETWORK` |
| `--contract <address>` | `quorum_proof` contract address | `$CONTRACT_QUORUM_PROOF` |
| `--output <format>` | `json` or `table` | `table` |
| `--source <key>` | Stellar key for simulation | `deployer` |
| `--help` | Show help | — |

**Examples:**

```bash
# Analyze slice 7 on testnet
./cli/qp analyze --slice-id 7

# JSON output
./cli/qp analyze --slice-id 7 --output json

# Query mainnet
./cli/qp analyze --slice-id 7 --network mainnet

# Use in a pipeline to check quorum before issuing credentials
if ./cli/qp analyze --slice-id 7 --output json | jq -e '.quorum_reached'; then
  echo "Quorum reached — safe to proceed"
fi
```

**Output formats:**

`table` (default):
```
╔══════════════════════════════════════════╗
║      QuorumProof Slice Analysis Report   ║
╚══════════════════════════════════════════╝

  Slice ID:                7
  Network:                 testnet
  Contract:                CABC...
  Queried at:              2026-09-28T07:30:00Z

  Threshold required:      2
  Total attestors:         3
  Attested count:          3
  Coverage:                100%

  Attestors:
    • GABC...
    • GDEF...
    • GHIJ...

  Quorum status: ✓ QUORUM REACHED (3/2 attestors)
```

`json`:
```json
{
  "queried_at": "2026-09-28T07:30:00Z",
  "network": "testnet",
  "contract": "CABC...",
  "slice_id": 7,
  "threshold": "2",
  "total_attestors": 3,
  "attested_count": 3,
  "coverage_pct": 100,
  "quorum_reached": true,
  "attestors": ["GABC...", "GDEF...", "GHIJ..."]
}
```

**Exit codes:** `0` = quorum reached, `1` = quorum not reached or error.

---

## Exit Codes

All `qp` commands follow a consistent exit code convention:

| Code | Meaning |
|------|---------|
| `0` | Success (attested / quorum reached / deploy completed) |
| `1` | Operational error (contract call failed, not attested, quorum not reached) |
| `2` | Usage error (bad arguments, missing required flag) |

---

## Output Formats

### `jq` integration

When `jq` is installed, JSON output is automatically pretty-printed. Without `jq`, raw JSON is printed. Install jq:

```bash
# Debian/Ubuntu
apt-get install jq

# macOS
brew install jq
```

### Piping examples

```bash
# Extract the quorum_proof address from a deployment manifest
jq -r '.contracts.quorum_proof' deployment-testnet.json

# Check if credential is attested in a CI step
./cli/qp verify --credential-id "$CRED_ID" --output json \
  | jq -e '.attested == true'

# Get coverage percentage for a slice
./cli/qp analyze --slice-id 1 --output json | jq '.coverage_pct'

# List all attestor addresses
./cli/qp analyze --slice-id 1 --output json | jq -r '.attestors[]'
```

---

## Scripting & CI Integration

### In GitHub Actions

```yaml
- name: Deploy contracts to testnet
  run: ./cli/qp deploy --network testnet
  env:
    STELLAR_NETWORK: testnet

- name: Verify deployment health
  run: |
    CRED_ID=$(cat deployment-testnet.json | jq -r '.contracts.quorum_proof')
    ./cli/qp verify --credential-id 1 --contract "$CRED_ID" --output json
```

### Combining deploy + smoke test

```bash
# Deploy and capture manifest
./cli/qp deploy --network testnet --manifest ./my-manifest.json

# Read addresses from the manifest
CONTRACT_QUORUM_PROOF=$(jq -r '.contracts.quorum_proof' my-manifest.json)
export CONTRACT_QUORUM_PROOF

# Run existing smoke tests
./scripts/testnet_smoke_test.sh my-manifest.json
```

### Dry-run in PRs

```bash
# Preview what would be deployed without touching the network
./cli/qp deploy --network mainnet --dry-run
```

---

## Troubleshooting

### `stellar: command not found`

Install the Stellar CLI:
```bash
# See https://developers.stellar.org/docs/tools/developer-tools/cli/install-and-setup
cargo install --locked stellar-cli
```

### `Contract address is required`

Set `CONTRACT_QUORUM_PROOF` in `.env` or pass `--contract <address>` explicitly:
```bash
./cli/qp verify --credential-id 42 --contract CABC...
```

### `WASM file not found`

Build the contracts first:
```bash
./scripts/build.sh
```

### `deploy_testnet.sh` vs `qp deploy`

`scripts/deploy_testnet.sh` is the original CI deployment script hardcoded to testnet. `cli/qp deploy` is the interactive CLI wrapper that supports all networks, `--dry-run`, selective contract deployment, and custom manifest paths. Both write compatible JSON manifests.

### Network-specific key requirements

- **testnet / futurenet / standalone**: The deployer key is auto-created and funded if it doesn't exist.
- **mainnet**: The key must already exist (`stellar keys generate deployer` + fund manually before deploying).

### `jq` not available

The CLI works without `jq` but JSON output will not be pretty-printed. Install `jq` for the best experience (see above).

### Permission denied running scripts

```bash
chmod +x cli/qp cli/commands/deploy.sh cli/commands/verify.sh cli/commands/analyze.sh
```

### Debugging contract call failures

Set `STELLAR_RPC_URL` in `.env` to override the default endpoint, and check that the contract addresses in `.env` match the target network.

For more context on contract entry points, see:
- [`contracts/quorum_proof/API.md`](../contracts/quorum_proof/API.md)
- [`docs/zk-verification-implementation.md`](../docs/zk-verification-implementation.md)
- [`docs/troubleshooting-guide.md`](../docs/troubleshooting-guide.md)
