# Environment Parity Guide

This guide explains QuorumProof's environment parity tooling, how to use it,
and how to remediate common configuration drift.

---

## Why environment parity matters

QuorumProof deploys three Soroban contracts to Stellar networks. Each
deployment environment (testnet, mainnet, futurenet, standalone) has its own:

- RPC endpoint
- Network passphrase
- Set of deployed contract IDs

Configuration drift — the state where a `.env` file, a CI secret, or a
teammate's local setup disagrees with the canonical values — is one of the
most common sources of mysterious failures:

- A developer's `.env` still points to old contract IDs after a redeployment.
- A CI job uses a testnet passphrase against a mainnet RPC endpoint.
- A new variable added to `.env.example` is never set in the live `.env`.

The parity tools in `scripts/` catch these problems before they become
incidents.

---

## check_env_parity.sh

Compares two environment files and reports drift across six categories.

### Usage

```bash
./scripts/check_env_parity.sh [OPTIONS]
```

| Flag | Default | Description |
|---|---|---|
| `--env1 <file>` | `.env` | Primary file to check (your live env) |
| `--env2 <file>` | `.env.example` | Reference file to compare against |
| `--report <file>` | — | Write machine-readable drift report to file |
| `--format <text\|json>` | `text` | Format for `--report` output |
| `--fail-on-drift` | off | Exit 1 if any drift is found |
| `--help` | — | Print usage |

### Checks performed

1. **Missing keys** — Variables present in `env2` (reference) but absent from
   `env1`. Typically means `.env.example` was updated but `.env` was not.

2. **Extra keys** — Variables in `env1` but not in `env2`. Usually harmless
   local additions, but reported as warnings so you can confirm they are
   intentional.

3. **Placeholder values** — Variables whose value still contains `<...>` or
   `change-me`. Indicates a configuration step was skipped.

4. **Network consistency** — Checks that `STELLAR_NETWORK` matches a section
   in `environments.toml`, that `STELLAR_RPC_URL` matches the canonical URL
   in that section, and that `VITE_STELLAR_NETWORK` / `VITE_STELLAR_RPC_URL`
   mirror the backend values.

5. **Contract address format** — Contract ID values must be 56-character
   Stellar contract IDs beginning with `C` (Base32, no placeholders). Anything
   else indicates a stale or truncated value.

6. **Required variables** — Ensures `STELLAR_NETWORK`, `STELLAR_RPC_URL`,
   `CONTRACT_QUORUM_PROOF`, `CONTRACT_SBT_REGISTRY`, and
   `CONTRACT_ZK_VERIFIER` are set and not placeholders.

### Examples

**Default — compare `.env` against `.env.example`:**

```bash
./scripts/check_env_parity.sh
```

**Check a specific env file against the example:**

```bash
./scripts/check_env_parity.sh --env1 environments/mainnet.env
```

**Write a JSON report (useful in CI):**

```bash
./scripts/check_env_parity.sh \
  --report reports/env-drift.json \
  --format json \
  --fail-on-drift
```

**Compare two non-default files:**

```bash
./scripts/check_env_parity.sh \
  --env1 environments/testnet.env \
  --env2 environments/mainnet.env
```

---

## compare_environments.sh

Compares multiple named environment snapshots against `environments.toml` and
against each other. Useful when you maintain per-network `.env` files.

### Setup: environment snapshots

The tool reads from `environments/<name>.env` files:

```bash
# One-time setup
mkdir -p environments/

# Create a snapshot of your current env
cp .env environments/testnet.env

# Repeat for other networks
cp .env environments/mainnet.env
```

> The `environments/` directory is intentionally left out of version control
> to avoid committing secrets. Only commit `*.env.example` template files.

### Usage

```bash
./scripts/compare_environments.sh [OPTIONS]
```

| Flag | Default | Description |
|---|---|---|
| `--envs <list>` | all found | Comma-separated environment names to compare |
| `--report-dir <dir>` | — | Write per-comparison reports to this directory |
| `--format <text\|json>` | `text` | Format for reports |
| `--fail-on-drift` | off | Exit 1 if any drift found |
| `--help` | — | Print usage |

### Examples

**Compare all snapshots:**

```bash
./scripts/compare_environments.sh
```

**Compare testnet and mainnet only:**

```bash
./scripts/compare_environments.sh --envs testnet,mainnet
```

**Write JSON reports to a directory:**

```bash
./scripts/compare_environments.sh \
  --envs testnet,mainnet \
  --report-dir reports/env-comparison \
  --format json \
  --fail-on-drift
```

### What it checks

Per snapshot:

- **RPC URL consistency** — `STELLAR_RPC_URL` matches `environments.toml` for
  the declared `STELLAR_NETWORK`.
- **Passphrase consistency** — `STELLAR_NETWORK_PASSPHRASE` (if set) matches
  the passphrase in `environments.toml`.
- **Frontend/backend parity** — `VITE_*` frontend variables mirror their
  non-`VITE_` backend equivalents.
- **Key parity against `.env.example`** — delegates to `check_env_parity.sh`
  for a full missing/extra/placeholder check.

Cross-snapshot:

- **Shared config consistency** — Variables that should be identical across
  all environments (e.g. `RATE_LIMIT_MAX`, `HMAC_SIGNING_SECRET`) are checked
  for unexpected divergence.

---

## Understanding drift reports

### Text format (default stdout)

```
QuorumProof Environment Parity Checker
  env1 (primary):   .env
  env2 (reference): .env.example

[1/6] Missing keys
  ✗ MISSING: WS_INSTANCE_ID  (present in .env.example, absent from .env)

[2/6] Extra keys
  ⚠ EXTRA: MY_LOCAL_DEBUG_FLAG  (present in .env, absent from .env.example)

[3/6] Placeholder values
  ⚠ PLACEHOLDER: CONTRACT_QUORUM_PROOF="<your-contract-id>"

[4/6] Network consistency
  ✓ Network configuration is consistent
    STELLAR_NETWORK=testnet
    STELLAR_RPC_URL=https://soroban-testnet.stellar.org

[5/6] Contract address format
  ✓ All contract address formats look valid

[6/6] Required variables
  ✗ REQUIRED MISSING: CONTRACT_QUORUM_PROOF (contains placeholder: "<your-contract-id>")

━━━ Summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✗ 2 drift issue(s) found
  ⚠ 1 warning(s) (extra keys)
```

Symbols:
- `✓` — check passed
- `✗` — drift found (counts toward `--fail-on-drift`)
- `⚠` — warning (extra keys do not trigger `--fail-on-drift`)

### JSON format (`--format json`)

```json
{
  "generated_at": "2026-09-28T07:28:00Z",
  "env1": "/workspaces/QuorumProof/.env",
  "env2": "/workspaces/QuorumProof/.env.example",
  "drift_count": 2,
  "warning_count": 1,
  "missing_keys": ["WS_INSTANCE_ID"],
  "extra_keys": ["MY_LOCAL_DEBUG_FLAG"],
  "placeholder_vars": ["CONTRACT_QUORUM_PROOF=<your-contract-id>"],
  "network_issues": [],
  "contract_issues": [],
  "required_missing": ["CONTRACT_QUORUM_PROOF (contains placeholder: \"<your-contract-id>\")"]
}
```

---

## Common drift causes and remediation

### Missing env vars after `.env.example` update

**Symptom:** `[1/6] Missing keys` lists one or more variables.

**Cause:** A developer added a new variable to `.env.example` (e.g. for a new
feature), but existing `.env` files were not updated.

**Remediation:**
1. Check what the new variable does: `grep -n "NEW_VAR" .env.example`
2. Add it to `.env` with an appropriate value.
3. If the variable is optional (empty by default), add it with an empty value:
   ```bash
   echo "NEW_VAR=" >> .env
   ```

---

### Stale contract addresses after redeployment

**Symptom:** `[5/6] Contract address format` flags an invalid ID, or
`./scripts/validate_env.sh` reports a contract not found on chain.

**Cause:** The contracts were redeployed (e.g. `deploy_testnet.sh` ran again),
generating new contract IDs, but `.env` still has old values.

**Remediation:**
1. Redeploy and capture the new IDs:
   ```bash
   ./scripts/deploy_testnet.sh
   ```
   The deploy script writes updated IDs to `.env` automatically.
2. Update any snapshot files:
   ```bash
   cp .env environments/testnet.env
   ```
3. Confirm parity:
   ```bash
   ./scripts/check_env_parity.sh --fail-on-drift
   ```

---

### Network mismatch (testnet vars in mainnet `.env`)

**Symptom:** `[4/6] Network consistency` reports an RPC URL mismatch or
`STELLAR_NETWORK=testnet` with `STELLAR_RPC_URL=https://mainnet...`.

**Cause:** Copy-paste from a different environment's file without updating
`STELLAR_NETWORK` and `STELLAR_RPC_URL` together.

**Remediation:**
1. Open `.env` and verify `STELLAR_NETWORK` is the intended value.
2. Look up the canonical RPC URL in `environments.toml`:
   ```bash
   grep -A 2 "\[mainnet\]" environments.toml
   ```
3. Update `STELLAR_RPC_URL` and `VITE_STELLAR_RPC_URL` to match.
4. Update `VITE_STELLAR_NETWORK` if needed.

---

### Placeholder values left unconfigured

**Symptom:** `[3/6] Placeholder values` lists variables ending in `change-me`
or `<your-contract-id>`.

**Cause:** The file was copied from `.env.example` but not fully configured.

**Remediation — contract IDs:**
```bash
# After deploying, the script sets these automatically:
./scripts/deploy_testnet.sh

# Or set manually:
CONTRACT_ID=$(stellar contract deploy ...)
sed -i "s/CONTRACT_QUORUM_PROOF=.*/CONTRACT_QUORUM_PROOF=$CONTRACT_ID/" .env
```

**Remediation — HMAC secrets:**
```bash
# Generate a cryptographically random secret:
python3 -c "import secrets; print(secrets.token_hex(32))"
# Then update .env manually.
```

---

## CI integration

Add a parity check step to your GitHub Actions workflow to catch drift on
every push.

### Example: check `.env` against `.env.example` in CI

```yaml
# .github/workflows/ci.yml
jobs:
  env-parity:
    name: Environment parity
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Create .env from CI secrets
        run: |
          cat > .env <<EOF
          STELLAR_NETWORK=${{ vars.STELLAR_NETWORK }}
          STELLAR_RPC_URL=${{ vars.STELLAR_RPC_URL }}
          CONTRACT_QUORUM_PROOF=${{ secrets.CONTRACT_QUORUM_PROOF }}
          CONTRACT_SBT_REGISTRY=${{ secrets.CONTRACT_SBT_REGISTRY }}
          CONTRACT_ZK_VERIFIER=${{ secrets.CONTRACT_ZK_VERIFIER }}
          VITE_STELLAR_NETWORK=${{ vars.STELLAR_NETWORK }}
          VITE_STELLAR_RPC_URL=${{ vars.STELLAR_RPC_URL }}
          VITE_CONTRACT_QUORUM_PROOF=${{ secrets.CONTRACT_QUORUM_PROOF }}
          VITE_CONTRACT_SBT_REGISTRY=${{ secrets.CONTRACT_SBT_REGISTRY }}
          VITE_CONTRACT_ZK_VERIFIER=${{ secrets.CONTRACT_ZK_VERIFIER }}
          EOF

      - name: Check environment parity
        run: |
          ./scripts/check_env_parity.sh \
            --report reports/env-drift.json \
            --format json \
            --fail-on-drift

      - name: Upload drift report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: env-drift-report
          path: reports/env-drift.json
```

### Example: compare multiple environment snapshots

```yaml
  multi-env-parity:
    name: Multi-environment parity
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Restore environment snapshots
        run: |
          mkdir -p environments/
          echo "${{ secrets.TESTNET_ENV }}" > environments/testnet.env
          echo "${{ secrets.MAINNET_ENV }}" > environments/mainnet.env

      - name: Compare environments
        run: |
          ./scripts/compare_environments.sh \
            --envs testnet,mainnet \
            --report-dir reports/env-comparison \
            --format json \
            --fail-on-drift

      - name: Upload comparison reports
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: env-comparison-reports
          path: reports/env-comparison/
```

---

## Remediation checklist template

Copy this into a GitHub issue or incident note when resolving drift:

```markdown
## Environment Parity Remediation

**Detected by:** check_env_parity.sh / compare_environments.sh / manual
**Date:**
**Affected environment(s):**

### Drift found

- [ ] Missing keys:
- [ ] Placeholder values:
- [ ] Network mismatch:
- [ ] Contract format issues:
- [ ] Required vars missing:

### Root cause

(Describe what caused the drift: redeployment, new .env.example variable,
 copy-paste from wrong environment, etc.)

### Actions taken

- [ ] Updated `.env` with correct values
- [ ] Updated environment snapshots in `environments/`
- [ ] Ran `./scripts/check_env_parity.sh --fail-on-drift` — no drift
- [ ] Ran `./scripts/validate_env.sh` — network valid
- [ ] Updated CI secrets/variables if affected
- [ ] Communicated to team (link to PR / Slack thread)

### Verification

```bash
./scripts/check_env_parity.sh --fail-on-drift
./scripts/compare_environments.sh --fail-on-drift
./scripts/validate_env.sh
```

Output:
```

```
```

---

## Related

- [`scripts/validate_env.sh`](../scripts/validate_env.sh) — Single-environment
  validation: checks network, RPC, and verifies contracts exist on chain.
- [`environments.toml`](../environments.toml) — Canonical network configurations
  (passphrase, RPC URL) for testnet, mainnet, futurenet, standalone.
- [`.env.example`](../.env.example) — Reference template for all environment
  variables.
- [`docs/deployment-checklist.md`](deployment-checklist.md) — Deployment
  checklist that includes environment validation as a gate.
- [`docs/troubleshooting-guide.md`](troubleshooting-guide.md) — Broader
  troubleshooting reference.
