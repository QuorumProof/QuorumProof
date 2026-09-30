#!/usr/bin/env bash
# scripts/setup_dev.sh — #1663 Local development environment setup.
#
# Sets up a complete local development environment for QuorumProof:
#   - Checks all required prerequisites
#   - Installs the wasm32-unknown-unknown Rust target
#   - Installs soroban-cli if not present
#   - Copies .env.example → .env (non-destructive)
#   - Configures a standalone network identity
#   - Builds contracts
#   - Installs npm dependencies for api-server and frontend
#
# Flags:
#   --skip-docker   Skip Docker/Docker Compose prerequisite checks
#   --skip-build    Skip contract build step
#
# Usage:
#   ./scripts/setup_dev.sh
#   ./scripts/setup_dev.sh --skip-build
#   ./scripts/setup_dev.sh --skip-docker --skip-build

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Colour helpers ─────────────────────────────────────────────────────────────
if [[ -t 1 ]] && command -v tput &>/dev/null && tput setaf 1 &>/dev/null; then
  RED="$(tput setaf 1)"
  GREEN="$(tput setaf 2)"
  YELLOW="$(tput setaf 3)"
  BOLD="$(tput bold)"
  RESET="$(tput sgr0)"
else
  RED="" GREEN="" YELLOW="" BOLD="" RESET=""
fi

info()    { echo "${GREEN}[setup_dev]${RESET} $*"; }
warn()    { echo "${YELLOW}[setup_dev] WARN:${RESET} $*"; }
error()   { echo "${RED}[setup_dev] ERROR:${RESET} $*" >&2; }
step()    { echo ""; echo "${BOLD}==> $*${RESET}"; }
success() { echo "${GREEN}✓${RESET} $*"; }
fail()    { echo "${RED}✗${RESET} $*"; }

# ── Flag parsing ───────────────────────────────────────────────────────────────
SKIP_DOCKER=false
SKIP_BUILD=false

for arg in "$@"; do
  case "$arg" in
    --skip-docker) SKIP_DOCKER=true ;;
    --skip-build)  SKIP_BUILD=true  ;;
    --help|-h)
      echo "Usage: $0 [--skip-docker] [--skip-build]"
      echo ""
      echo "  --skip-docker   Skip Docker and Docker Compose prerequisite checks"
      echo "  --skip-build    Skip contract build step (cargo build --release)"
      exit 0
      ;;
    *)
      error "Unknown flag: $arg"
      echo "Usage: $0 [--skip-docker] [--skip-build]"
      exit 1
      ;;
  esac
done

# ── Helper: version comparison ─────────────────────────────────────────────────
# version_gte A B  → true if A >= B (dot-separated integers)
version_gte() {
  local IFS=.
  local -a a=($1) b=($2)
  local i
  for ((i = 0; i < ${#b[@]}; i++)); do
    local av="${a[i]:-0}" bv="${b[i]:-0}"
    (( av > bv )) && return 0
    (( av < bv )) && return 1
  done
  return 0
}

# ── Prerequisite checks ────────────────────────────────────────────────────────
step "Checking prerequisites"

PREREQ_FAILURES=0

check_cmd() {
  local cmd="$1" label="${2:-$1}"
  if command -v "$cmd" &>/dev/null; then
    success "$label is installed ($(command -v "$cmd"))"
  else
    fail "$label not found"
    PREREQ_FAILURES=$(( PREREQ_FAILURES + 1 ))
  fi
}

# Rust / Cargo
if command -v rustc &>/dev/null; then
  RUST_VER="$(rustc --version | awk '{print $2}')"
  success "rustc $RUST_VER"
else
  fail "rustc not found — install Rust via https://rustup.rs"
  PREREQ_FAILURES=$(( PREREQ_FAILURES + 1 ))
fi
check_cmd cargo

# Node.js >= 18
if command -v node &>/dev/null; then
  NODE_VER="$(node --version | tr -d 'v')"
  if version_gte "$NODE_VER" "18.0.0"; then
    success "node v${NODE_VER} (>= 18 required)"
  else
    fail "node v${NODE_VER} is too old — node >= 18 required"
    PREREQ_FAILURES=$(( PREREQ_FAILURES + 1 ))
  fi
else
  fail "node not found — install Node.js >= 18 via https://nodejs.org or nvm"
  PREREQ_FAILURES=$(( PREREQ_FAILURES + 1 ))
fi

# Docker & Docker Compose (optional via flag)
if [[ "$SKIP_DOCKER" == "true" ]]; then
  warn "Skipping Docker checks (--skip-docker)"
else
  if command -v docker &>/dev/null; then
    DOCKER_VER="$(docker --version | awk '{print $3}' | tr -d ',')"
    success "docker $DOCKER_VER"
  else
    fail "docker not found — install Docker Desktop or Docker Engine"
    PREREQ_FAILURES=$(( PREREQ_FAILURES + 1 ))
  fi

  # Accept both "docker compose" (plugin) and "docker-compose" (standalone)
  if docker compose version &>/dev/null 2>&1; then
    DC_VER="$(docker compose version --short 2>/dev/null || docker compose version | awk '{print $NF}')"
    success "docker compose $DC_VER (plugin)"
  elif command -v docker-compose &>/dev/null; then
    DC_VER="$(docker-compose --version | awk '{print $3}' | tr -d ',')"
    success "docker-compose $DC_VER (standalone)"
  else
    fail "docker compose / docker-compose not found"
    PREREQ_FAILURES=$(( PREREQ_FAILURES + 1 ))
  fi
fi

# Stellar CLI
if command -v stellar &>/dev/null; then
  STELLAR_VER="$(stellar --version 2>&1 | head -1)"
  success "stellar CLI: $STELLAR_VER"
else
  warn "stellar CLI not found — will attempt to install via cargo below"
fi

if [[ $PREREQ_FAILURES -gt 0 ]]; then
  error "$PREREQ_FAILURES prerequisite(s) missing. Fix the issues above and re-run."
  exit 1
fi

# ── Rust WASM target ───────────────────────────────────────────────────────────
step "Installing Rust wasm32 target"

if rustup target list --installed | grep -q "wasm32-unknown-unknown"; then
  success "wasm32-unknown-unknown already installed"
else
  info "Running: rustup target add wasm32-unknown-unknown"
  rustup target add wasm32-unknown-unknown
  success "wasm32-unknown-unknown installed"
fi

# ── soroban-cli ────────────────────────────────────────────────────────────────
step "Checking soroban-cli"

if command -v soroban &>/dev/null; then
  SOROBAN_VER="$(soroban --version 2>&1 | head -1)"
  success "soroban-cli already installed: $SOROBAN_VER"
else
  info "soroban-cli not found — installing via cargo (this may take a few minutes)..."
  cargo install --locked soroban-cli
  success "soroban-cli installed"
fi

# ── Stellar CLI (install if missing after cargo-based tools are set up) ────────
if ! command -v stellar &>/dev/null; then
  step "Installing stellar CLI"
  info "Running: cargo install --locked stellar-cli"
  cargo install --locked stellar-cli
  success "stellar CLI installed"
fi

# ── .env setup (non-destructive) ──────────────────────────────────────────────
step "Setting up .env"

ENV_FILE="$ROOT_DIR/.env"
ENV_EXAMPLE="$ROOT_DIR/.env.example"

if [[ -f "$ENV_FILE" ]]; then
  warn ".env already exists — skipping copy (non-destructive). Edit it manually if needed."
else
  if [[ -f "$ENV_EXAMPLE" ]]; then
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    success "Copied .env.example → .env"
    info "Edit $ENV_FILE to configure your local environment."
  else
    warn ".env.example not found at $ENV_EXAMPLE — skipping .env creation."
  fi
fi

# ── Standalone network identity ────────────────────────────────────────────────
step "Configuring standalone network identity"

if stellar keys address dev --network standalone &>/dev/null 2>&1; then
  DEV_ADDR="$(stellar keys address dev --network standalone 2>/dev/null || true)"
  success "Standalone key 'dev' already exists${DEV_ADDR:+ (address: $DEV_ADDR)}"
else
  info "Generating standalone identity 'dev'..."
  # Allow failure — standalone network may not be running yet; the key is still
  # generated locally and funding happens when the network is available.
  if stellar keys generate dev --network standalone 2>/dev/null; then
    DEV_ADDR="$(stellar keys address dev --network standalone 2>/dev/null || true)"
    success "Generated standalone key 'dev'${DEV_ADDR:+ → $DEV_ADDR}"
  else
    warn "Could not generate standalone key (standalone network not yet running?)."
    warn "Run 'stellar keys generate dev --network standalone' once the network is up."
  fi
fi

# ── Build contracts ────────────────────────────────────────────────────────────
if [[ "$SKIP_BUILD" == "true" ]]; then
  warn "Skipping contract build (--skip-build)"
else
  step "Building contracts"
  info "Running: $SCRIPT_DIR/build.sh"
  "$SCRIPT_DIR/build.sh"
  success "Contracts built successfully"
fi

# ── API server dependencies ────────────────────────────────────────────────────
step "Installing API server npm dependencies"

API_DIR="$ROOT_DIR/api-server"
if [[ -d "$API_DIR" ]]; then
  info "Running: npm ci in $API_DIR"
  npm ci --prefix "$API_DIR"
  success "api-server dependencies installed"
else
  warn "api-server directory not found at $API_DIR — skipping."
fi

# ── Frontend dependencies ──────────────────────────────────────────────────────
step "Installing frontend npm dependencies"

FRONTEND_DIR="$ROOT_DIR/frontend"
if [[ -d "$FRONTEND_DIR" ]]; then
  info "Running: npm ci in $FRONTEND_DIR"
  npm ci --prefix "$FRONTEND_DIR"
  success "frontend dependencies installed"
else
  warn "frontend directory not found at $FRONTEND_DIR — skipping."
fi

# ── Next steps summary ─────────────────────────────────────────────────────────
echo ""
echo "${BOLD}${GREEN}════════════════════════════════════════════════════════════════${RESET}"
echo "${BOLD}${GREEN}  QuorumProof local dev environment is ready!${RESET}"
echo "${BOLD}${GREEN}════════════════════════════════════════════════════════════════${RESET}"
echo ""
echo "  ${BOLD}Start the full stack with Docker Compose:${RESET}"
echo "    docker compose -f docker-compose.dev.yml up"
echo ""
echo "  ${BOLD}Or run services individually:${RESET}"
echo "    # Start standalone Stellar node"
echo "    docker compose -f docker-compose.dev.yml up stellar-standalone -d"
echo ""
echo "    # Deploy contracts to standalone"
echo "    ./scripts/deploy_standalone.sh   # (if available) or:"
echo "    stellar contract deploy \\"
echo "      --wasm target/wasm32-unknown-unknown/release/quorum_proof.wasm \\"
echo "      --source dev --network standalone"
echo ""
echo "    # Start the API server"
echo "    cd api-server && npm run dev"
echo ""
echo "    # Start the frontend"
echo "    cd frontend && npm run dev"
echo ""
echo "  ${BOLD}Run unit tests:${RESET}"
echo "    cargo test                # Rust / contract tests"
echo "    cd api-server && npm test # API server tests"
echo ""
echo "  ${BOLD}Useful links (once running):${RESET}"
echo "    Stellar RPC:  http://localhost:8000/soroban/rpc"
echo "    API server:   http://localhost:3000"
echo "    Frontend:     http://localhost:5173"
echo ""
echo "  See ${BOLD}docs/local-dev-setup.md${RESET} for full documentation."
echo ""
