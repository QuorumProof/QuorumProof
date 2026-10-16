# Local Development Setup

This guide walks you through setting up a fully functional QuorumProof development
environment on your local machine. You can run everything with Docker Compose for
the closest approximation to production, or run individual services natively for
faster feedback loops.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Start (automated)](#quick-start-automated)
- [Manual Step-by-Step Setup](#manual-step-by-step-setup)
- [Docker Compose Dev Environment](#docker-compose-dev-environment)
- [Standalone Network Configuration](#standalone-network-configuration)
- [Running Individual Services](#running-individual-services)
- [Deploying Contracts to Standalone](#deploying-contracts-to-standalone)
- [Environment Variable Reference](#environment-variable-reference)
- [Common Issues and Fixes](#common-issues-and-fixes)

---

## Prerequisites

Install the following tools before running setup.

| Tool | Minimum version | Install |
|------|----------------|---------|
| Rust | 1.70 | [rustup.rs](https://rustup.rs) |
| Node.js | 18.x | [nodejs.org](https://nodejs.org) or [nvm](https://github.com/nvm-sh/nvm) |
| Docker Engine | 24.x | [docs.docker.com](https://docs.docker.com/engine/install/) |
| Docker Compose | v2 (plugin) | Bundled with Docker Desktop; standalone: `pip install docker-compose` |
| Stellar CLI | Latest | `cargo install --locked stellar-cli` |
| soroban-cli | Latest | `cargo install --locked soroban-cli` (or included with Stellar CLI) |

> **macOS / Linux**: Docker Desktop ships with Compose v2 as a plugin (`docker compose`).
> On bare Linux you may have the older standalone `docker-compose` binary — both work.

---

## Quick Start (automated)

The `setup_dev.sh` script automates all of the manual steps below.

```bash
# From the repo root
./scripts/setup_dev.sh
```

The script:

1. Verifies all prerequisites are installed
2. Adds the `wasm32-unknown-unknown` Rust target
3. Installs `soroban-cli` if missing
4. Copies `.env.example` → `.env` (only if `.env` doesn't already exist)
5. Generates a `dev` identity for the standalone network
6. Builds contracts (`scripts/build.sh`)
7. Runs `npm ci` in `api-server/` and `frontend/`
8. Prints a next-steps summary

**Flags:**

```bash
./scripts/setup_dev.sh --skip-docker   # Skip Docker/Compose prerequisite checks
./scripts/setup_dev.sh --skip-build    # Skip the contract build step
./scripts/setup_dev.sh --skip-docker --skip-build
```

After the script completes, start everything with:

```bash
docker compose -f docker-compose.dev.yml up
```

---

## Manual Step-by-Step Setup

Follow these steps if you prefer a hands-on setup or if `setup_dev.sh` fails.

### 1. Install Rust and the WASM target

```bash
# Install Rust (if not already installed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# Add the WebAssembly target required by Soroban
rustup target add wasm32-unknown-unknown
```

### 2. Install Soroban and Stellar CLI tools

```bash
cargo install --locked soroban-cli
cargo install --locked stellar-cli
```

Confirm the installations:

```bash
soroban --version
stellar --version
```

### 3. Install Node.js dependencies

```bash
# API server
npm ci --prefix api-server

# Frontend
npm ci --prefix frontend
```

### 4. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` for local development — the defaults work out of the box with
Docker Compose, but you may want to review the values:

```env
STELLAR_NETWORK=standalone
STELLAR_RPC_URL=http://localhost:8000/soroban/rpc
```

See the [Environment Variable Reference](#environment-variable-reference) section
for a full description of every variable.

### 5. Build the contracts

```bash
./scripts/build.sh
# equivalent to: cargo build --release --target wasm32-unknown-unknown
```

Compiled WASM files are placed in `target/wasm32-unknown-unknown/release/`.

### 6. Generate a standalone network identity

```bash
stellar keys generate dev --network standalone
stellar keys address dev
```

This creates a local keypair named `dev` that will be funded automatically by
the Quickstart node when the standalone network boots.

---

## Docker Compose Dev Environment

`docker-compose.dev.yml` in the repo root defines a four-service dev stack.

| Service | Port | Description |
|---------|------|-------------|
| `stellar-standalone` | 8000 | Stellar quickstart (standalone + Soroban RPC) |
| `postgres` | 5432 | PostgreSQL 16 database for the API server |
| `api-server` | 3000 | TypeScript API server with live reload |
| `frontend` | 5173 | Vite/React frontend with HMR |

### Starting the full stack

```bash
docker compose -f docker-compose.dev.yml up
```

Add `-d` to run in the background:

```bash
docker compose -f docker-compose.dev.yml up -d
```

### Starting only infrastructure services

Run Stellar and Postgres locally while developing api-server and frontend natively:

```bash
docker compose -f docker-compose.dev.yml up stellar-standalone postgres -d
```

### Stopping and cleaning up

```bash
# Stop containers, keep volumes
docker compose -f docker-compose.dev.yml down

# Stop containers and remove volumes (resets Postgres data)
docker compose -f docker-compose.dev.yml down -v
```

### Rebuilding a service after a Dockerfile change

```bash
docker compose -f docker-compose.dev.yml build api-server
docker compose -f docker-compose.dev.yml up api-server
```

### Viewing logs

```bash
# All services
docker compose -f docker-compose.dev.yml logs -f

# One service
docker compose -f docker-compose.dev.yml logs -f stellar-standalone
```

---

## Standalone Network Configuration

The standalone network is a single-node Stellar network running entirely on your
machine. It uses an insecure passphrase and mines blocks instantly, making it
ideal for development iteration.

### Network parameters

| Parameter | Value |
|-----------|-------|
| Network passphrase | `Standalone Network ; February 2017` |
| RPC URL | `http://localhost:8000/soroban/rpc` |
| Friendbot (faucet) | `http://localhost:8000/friendbot?addr=<address>` |
| Horizon | `http://localhost:8000` |

These values are stored in `environments.toml`:

```toml
[standalone]
network_passphrase = "Standalone Network ; February 2017"
rpc_url = "http://localhost:8000/soroban/rpc"
```

### Fund an account on standalone

The Quickstart node ships with a Friendbot that funds accounts on demand:

```bash
# Via curl
ADDR=$(stellar keys address dev)
curl "http://localhost:8000/friendbot?addr=${ADDR}"

# Via Stellar CLI (uses Friendbot automatically for standalone/testnet)
stellar keys generate dev --network standalone --fund
```

### Verify the standalone node is responding

```bash
curl -s http://localhost:8000/soroban/rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger","params":{}}' \
  | jq .
```

---

## Running Individual Services

### Contracts (Rust/Soroban)

```bash
# Build
cargo build --release --target wasm32-unknown-unknown

# Run all tests (unit + integration)
cargo test

# Run tests for a single contract
cargo test -p quorum_proof
cargo test -p sbt_registry
cargo test -p zk_verifier

# Watch-and-test
cargo watch -x test
```

### API server

```bash
cd api-server

# Install dependencies
npm ci

# Start in development mode (with file watching)
npm run dev

# Run tests
npm test

# Type-check
npm run typecheck   # if defined in package.json
```

The API server listens on port **3000** (configurable via `PORT` env var).

### Frontend

```bash
cd frontend

# Install dependencies
npm ci

# Start Vite dev server with HMR
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

The Vite dev server listens on port **5173** by default.

---

## Deploying Contracts to Standalone

After the standalone Stellar node is running and your contracts are built:

### Deploy all three contracts

```bash
WASM_DIR="target/wasm32-unknown-unknown/release"

# Deploy quorum_proof
CONTRACT_QUORUM_PROOF=$(stellar contract deploy \
  --wasm "$WASM_DIR/quorum_proof.wasm" \
  --source dev \
  --network standalone)
echo "CONTRACT_QUORUM_PROOF=$CONTRACT_QUORUM_PROOF"

# Deploy sbt_registry
CONTRACT_SBT_REGISTRY=$(stellar contract deploy \
  --wasm "$WASM_DIR/sbt_registry.wasm" \
  --source dev \
  --network standalone)
echo "CONTRACT_SBT_REGISTRY=$CONTRACT_SBT_REGISTRY"

# Deploy zk_verifier
CONTRACT_ZK_VERIFIER=$(stellar contract deploy \
  --wasm "$WASM_DIR/zk_verifier.wasm" \
  --source dev \
  --network standalone)
echo "CONTRACT_ZK_VERIFIER=$CONTRACT_ZK_VERIFIER"
```

### Write addresses to .env

```bash
sed -i "s|CONTRACT_QUORUM_PROOF=.*|CONTRACT_QUORUM_PROOF=$CONTRACT_QUORUM_PROOF|" .env
sed -i "s|CONTRACT_SBT_REGISTRY=.*|CONTRACT_SBT_REGISTRY=$CONTRACT_SBT_REGISTRY|" .env
sed -i "s|CONTRACT_ZK_VERIFIER=.*|CONTRACT_ZK_VERIFIER=$CONTRACT_ZK_VERIFIER|" .env
```

### Invoke a contract function

```bash
stellar contract invoke \
  --id "$CONTRACT_QUORUM_PROOF" \
  --source dev \
  --network standalone \
  -- issue_credential \
  --subject "GABC..." \
  --credential_type "degree" \
  --metadata_hash "abc123"
```

---

## Environment Variable Reference

Copy `.env.example` to `.env` and customise as needed. The table below describes
every variable used in local development.

### Network

| Variable | Default | Description |
|----------|---------|-------------|
| `STELLAR_NETWORK` | `testnet` | Active network: `standalone`, `testnet`, `mainnet`, `futurenet` |
| `STELLAR_RPC_URL` | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint. Use `http://localhost:8000/soroban/rpc` for standalone |

### Contract addresses

| Variable | Description |
|----------|-------------|
| `CONTRACT_QUORUM_PROOF` | On-chain address of the `quorum_proof` contract |
| `CONTRACT_SBT_REGISTRY` | On-chain address of the `sbt_registry` contract |
| `CONTRACT_ZK_VERIFIER` | On-chain address of the `zk_verifier` contract |

### API server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | API server listen port |
| `DATABASE_URL` | — | PostgreSQL connection string, e.g. `postgres://qp:devpassword@localhost:5432/quorumproof` |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window in ms |
| `RATE_LIMIT_MAX` | `100` | Max requests per window |
| `HMAC_SIGNING_SECRET` | — | Secret for HMAC request signing |
| `PUBLIC_APP_BASE_URL` | `http://localhost:3000` | Publicly reachable origin for QR codes / export links |
| `REDIS_URL` | — | Redis URL for WebSocket cross-instance delivery (optional for local dev) |

### Frontend

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_STELLAR_NETWORK` | `testnet` | Network used by the frontend |
| `VITE_STELLAR_RPC_URL` | `https://soroban-testnet.stellar.org` | Soroban RPC for frontend queries |
| `VITE_CONTRACT_QUORUM_PROOF` | — | Contract address for frontend |
| `VITE_CONTRACT_SBT_REGISTRY` | — | Contract address for frontend |
| `VITE_CONTRACT_ZK_VERIFIER` | — | Contract address for frontend |

---

## Common Issues and Fixes

### Port already in use

**Symptom:** `Error: listen EADDRINUSE: address already in use :::3000`

**Fix:** Kill the process holding the port, or change the port in `.env`:

```bash
# Find the process
lsof -i :3000

# Kill it
kill -9 <PID>

# Or change the port
echo "PORT=3001" >> .env
```

For Docker Compose services, change the host-side port in `docker-compose.dev.yml`:
```yaml
ports:
  - "3001:3000"   # host:container
```

### wasm32-unknown-unknown target missing

**Symptom:** `error[E0463]: can't find crate for 'std'` or
`error: ... target 'wasm32-unknown-unknown' not found`

**Fix:**

```bash
rustup target add wasm32-unknown-unknown
```

Confirm the target is installed:

```bash
rustup target list --installed | grep wasm32
```

### Stellar CLI authentication error

**Symptom:** `Error: Missing required option: --source` or
`error: account not found`

**Fix:** Ensure you have a local key generated and the account is funded:

```bash
# Generate a key (standalone) — safe to run again if key already exists
stellar keys generate dev --network standalone 2>/dev/null || true

# Fund via Friendbot
curl "http://localhost:8000/friendbot?addr=$(stellar keys address dev)"

# Verify the key exists
stellar keys list
stellar keys address dev
```

### Docker Compose standalone node unhealthy / not starting

**Symptom:** `stellar-standalone` stays in `starting` or `unhealthy`

**Fix:** Pull the latest quickstart image and give it more startup time:

```bash
docker pull stellar/quickstart:testing
docker compose -f docker-compose.dev.yml up stellar-standalone
```

Check the container logs for specific errors:

```bash
docker compose -f docker-compose.dev.yml logs stellar-standalone
```

The node typically takes 15–30 seconds on first boot. The healthcheck retries
15 times at 10-second intervals (2.5 minutes total).

### PostgreSQL connection refused

**Symptom:** `ECONNREFUSED 127.0.0.1:5432` from the API server

**Fix:** Start Postgres and wait for the health check:

```bash
docker compose -f docker-compose.dev.yml up postgres -d
docker compose -f docker-compose.dev.yml ps   # confirm "healthy"
```

Then set `DATABASE_URL` in your `.env`:

```env
DATABASE_URL=postgres://qp:devpassword@localhost:5432/quorumproof
```

### npm ci fails with ENOENT or integrity error

**Symptom:** `npm ci` fails because `package-lock.json` is missing or stale

**Fix:** Regenerate the lockfile:

```bash
# In api-server/
cd api-server && npm install && cd ..

# In frontend/
cd frontend && npm install && cd ..
```

Then commit the updated lockfiles.

### Cargo build fails: "could not compile soroban-sdk"

**Symptom:** Build fails with linker or dependency errors after a `rustup update`

**Fix:** Pin your Rust toolchain to the version in `rust-toolchain.toml` (if
present), or check `.cargo/config.toml`:

```bash
cat .cargo/config.toml
rustup show active-toolchain
```

If no toolchain file exists, use `stable`:

```bash
rustup default stable
cargo build --release --target wasm32-unknown-unknown
```

### Frontend cannot reach the API server

**Symptom:** CORS errors or `ERR_CONNECTION_REFUSED` in the browser console

**Fix:** Check that `VITE_*` environment variables are set in `frontend/.env`
(not the root `.env`). Vite only injects variables prefixed with `VITE_`:

```bash
cp frontend/.env.example frontend/.env   # if it exists
# or add manually:
echo "VITE_STELLAR_RPC_URL=http://localhost:8000/soroban/rpc" >> frontend/.env
```

Also ensure the API server CORS configuration allows `http://localhost:5173`.

### "Missing STELLAR_RPC_URL" in Docker Compose

**Symptom:** API server container exits with a missing env var error

**Fix:** Ensure the root `.env` file exists before starting Compose — it is
referenced via `env_file: .env` in `docker-compose.dev.yml`:

```bash
cp .env.example .env
docker compose -f docker-compose.dev.yml up
```

---

## See Also

- [Architecture Overview](architecture.md)
- [Contract Module Index](../contracts/quorum_proof/README.md)
- [Testnet Deployment](ci-testnet-deployment.md)
- [Troubleshooting Guide](troubleshooting-guide.md)
- [Error Code Reference](error-codes.md)
- [scripts/README.md](../scripts/README.md) — all available scripts
