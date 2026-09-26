# Continuous Security Testing

> Issue #1631. Complements [security-audit-checklist.md](./security-audit-checklist.md)
> and [threat-model.md](./threat-model.md).

`.github/workflows/security.yml` runs on every push to `main`/`develop`, on
every pull request, every night at 03:00 UTC (so newly published advisories are
caught even when the code hasn't changed), and on demand.

## Pipeline

```
 ┌──────────── SAST ───────────┐ ┌──────── Dependencies ────────┐ ┌──── Containers ────┐
 │ semgrep  codeql  clippy     │ │ cargo-audit cargo-deny npm   │ │ trivy-image  fs    │
 └──────────────┬──────────────┘ └──────────────┬───────────────┘ └─────────┬──────────┘
                └───────── raw reports uploaded as artifacts ───────────────┘
                                         │
                              report (aggregate_reports.py)
                     ├─ job summary + sticky PR comment
                     ├─ SARIF → GitHub code scanning
                     ├─ security-report.{md,json} artifact
                     └─ fail if any finding ≥ FAIL_ON (default: high)
```

Each scanner job always succeeds and only produces a report. Pass or fail is
decided once, in the `report` job, so one noisy tool can't hide the results of
the others.

## Scanners

| Area | Tool | Scope | Output |
|---|---|---|---|
| SAST | Semgrep | Rust contracts, TS/JS, GitHub Actions, secrets, plus the project rules in `.semgrep.yml` | `semgrep.sarif` |
| SAST | CodeQL (`security-extended`) | `frontend/`, `dashboard/`, `api-server/` | `codeql-*.sarif` |
| SAST | Clippy with security lints (`unwrap_used`, `panic`, `indexing_slicing`, `arithmetic_side_effects`, ...) | Rust workspace | `clippy.sarif` |
| Dependencies | cargo-audit | `Cargo.lock` against RustSec | `cargo-audit.json` |
| Dependencies | cargo-deny | advisories, yanked crates, banned deps, unknown sources (existing `deny.toml`) | `cargo-deny.txt` |
| Dependencies | npm audit | `frontend`, `api-server` lockfiles | `npm-audit-<project>.json` |
| Containers | Trivy image | Image built from `api-server/Dockerfile`: OS packages, npm packages, secrets, misconfig | `trivy-image-api-server.sarif` |
| Containers / IaC | Trivy fs | Repository: lockfile vulns, committed secrets, Dockerfile and workflow misconfig | `trivy-fs.sarif` |

The existing `security` job in `ci.yml` (cargo-audit, cargo-deny, TruffleHog)
still runs as a blocking check on every build. This workflow adds wider
coverage and a single aggregated report on top of it.

### Project-specific Semgrep rules (`.semgrep.yml`)

| Rule | Catches |
|---|---|
| `soroban-upgrade-without-admin-check` | `update_current_contract_wasm` called without checking the stored admin (the gap fixed in #1630 for `sbt_registry` / `zk_verifier`) |
| `soroban-privileged-fn-missing-require-auth` | An `admin`-taking function writes storage without `admin.require_auth()` |
| `api-server-logs-secret` | Secret keys or env values sent to `console.*` |
| `express-error-leaks-stack` | Stack traces returned in HTTP responses |

## Report aggregation

`scripts/security/aggregate_reports.py` converts every input into one finding
schema:

```json
{ "tool": "trivy", "category": "Container / IaC", "severity": "high",
  "id": "CVE-2024-XXXX", "title": "...", "location": "api-server: express@4.x" }
```

Severity is normalised across tools:

| Source value | Normalised |
|---|---|
| CVSS ≥ 9.0 / `critical` | critical |
| CVSS ≥ 7.0 / `high` / SARIF `error` | high |
| CVSS ≥ 4.0 / `moderate` / `medium` / SARIF `warning` | medium |
| `low` / SARIF `note` | low |
| everything else | info |

Identical findings reported by more than one scanner are deduplicated by
`(tool, id, location)`.

Run it locally against any directory of reports:

```bash
python3 scripts/security/aggregate_reports.py ./reports --fail-on high
```

## Thresholds and triage

- **Default gate:** `high`. Critical or high findings fail the workflow.
  Manual runs can pick another threshold (`critical`/`high`/`medium`/`low`/`none`).
- **False positives:** suppress at the source, with a reason:
  - Semgrep: `// nosemgrep: <rule-id> -- <reason>`
  - cargo-audit / cargo-deny: add the advisory ID to `deny.toml` `[advisories].ignore` with a comment and an expiry date
  - Trivy: add a `.trivyignore` entry with a comment
- **Real findings:** open an issue with the `security` label. Private
  vulnerabilities go through a GitHub security advisory, not a public issue.
- **Nightly failures** on `main` mean a new advisory affects a pinned
  dependency. Treat them as high priority.

## Running scanners locally

```bash
# SAST
semgrep scan --config p/rust --config p/typescript --config .semgrep.yml
cargo clippy --workspace --all-targets -- -W clippy::unwrap_used -W clippy::panic

# Dependencies
cargo audit
cargo deny check advisories bans sources
(cd api-server && npm audit)

# Containers
docker build -t qp-api api-server && trivy image qp-api
trivy fs --scanners vuln,secret,misconfig .
```
