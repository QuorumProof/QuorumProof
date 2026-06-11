# CI/CD Pipeline — QuorumProof

This document describes the automated CI/CD pipeline for building, testing, and deploying QuorumProof smart contracts.

---

## Overview

| Workflow | File | Trigger |
|---|---|---|
| CI (build, test, security scan) | `ci.yml` | Push/PR to `main` or `develop` |
| Testnet deploy (PR preview) | `deploy-pr.yml` | PR opened/updated against `main` |
| Mainnet deploy (gated) | `deploy-mainnet.yml` | Manual (`workflow_dispatch`) |

---

## Workflows

### 1. CI — `ci.yml`

Runs on every push and pull request to `main` or `develop`.

**Jobs:**

- **contracts** — Builds all Soroban WASM contracts and runs the full test suite.
- **frontend** — Installs dependencies, lints, tests, and builds the frontend.
- **security** — Runs `cargo audit` to check for known vulnerabilities in Rust dependencies, and TruffleHog to detect any hardcoded secrets in the diff.

All three jobs must pass before a PR can be merged.

### 2. Testnet Deploy on PR — `deploy-pr.yml`

Triggered automatically when a PR is opened or updated against `main`.

**What it does:**

1. Builds contracts and runs tests.
2. Deploys all three contracts (`quorum_proof`, `sbt_registry`, `zk_verifier`) to Stellar testnet.
3. Posts a comment on the PR with the deployed contract IDs.

**Required secrets** (configured in the `testnet` GitHub environment):

| Secret | Description |
|---|---|
| `STELLAR_RPC_URL` | Testnet RPC endpoint |
| `STELLAR_SECRET_KEY` | Testnet deployer secret key (S...) |

### 3. Mainnet Deploy — `deploy-mainnet.yml`

Manual-only deployment with two gates:

1. **Confirmation string** — The person triggering the workflow must type `deploy-mainnet` exactly in the input field.
2. **GitHub environment approval** — The `mainnet` environment must be configured with required reviewers in GitHub repository settings. The job will pause and wait for an authorized reviewer to approve before proceeding.

**What it does:**

1. Validates the confirmation string.
2. Waits for manual approval (via GitHub environment protection rules).
3. Builds contracts, runs tests, and runs `cargo audit`.
4. Deploys all three contracts to Stellar mainnet.
5. Outputs contract IDs to the workflow summary.

**Required secrets** (configured in the `mainnet` GitHub environment):

| Secret | Description |
|---|---|
| `MAINNET_RPC_URL` | Mainnet RPC endpoint |
| `MAINNET_SECRET_KEY` | Mainnet deployer secret key (S...) |

---

## GitHub Environment Setup

### testnet environment

1. Go to **Settings → Environments → New environment** → name it `testnet`.
2. Add secrets: `STELLAR_RPC_URL`, `STELLAR_SECRET_KEY`.
3. No approval required (deploys automatically on PR).

### mainnet environment

1. Go to **Settings → Environments → New environment** → name it `mainnet`.
2. Enable **Required reviewers** and add at least one authorized reviewer.
3. Add secrets: `MAINNET_RPC_URL`, `MAINNET_SECRET_KEY`.
4. Optionally set a **deployment branch rule** to restrict to `main` only.

---

## Triggering a Mainnet Deployment

1. Ensure the PR is merged to `main` and all CI checks pass.
2. Go to **Actions → Deploy Mainnet → Run workflow**.
3. In the confirmation field, type exactly: `deploy-mainnet`
4. Click **Run workflow**.
5. An authorized reviewer will receive an approval request — the deployment proceeds only after approval.
6. Contract IDs are shown in the workflow summary after a successful run. Record them in `.env` and the team password manager.

---

## Security Notes

- Never commit secret keys. All keys are stored as GitHub environment secrets.
- The `mainnet` environment requires human approval — automated triggers are intentionally not supported.
- `cargo audit` runs on every CI check and again before every mainnet deployment.
- TruffleHog scans every PR diff for accidentally committed secrets.
- See `docs/deployment-guide.md` for the full manual deployment procedure and post-deployment security checklist.
