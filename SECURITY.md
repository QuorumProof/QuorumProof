# Security Policy

QuorumProof handles professional credential attestation on Stellar Soroban.
Security issues in the contracts, API server, or ZK verification pipeline can
directly affect the integrity of issued credentials — please report them
responsibly rather than disclosing them publicly.

## Supported Versions

Only the code on the `main` branch and the most recently deployed mainnet
contract versions receive security fixes. There are no separate LTS branches
at this time.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report suspected vulnerabilities privately to:

**security@quorumproof.io**

If the report concerns a deployed smart contract with an active exploit path
(e.g. a bug that lets funds or credentials be stolen or forged right now),
say so explicitly in the subject line so it can be triaged immediately.

### What to Include

- A clear description of the vulnerability and its impact.
- Affected component(s): `contracts/quorum_proof`, `contracts/sbt_registry`,
  `contracts/zk_verifier`, `contracts/bbs_plus_v1`, `api-server`, `frontend`,
  `dashboard`, or infrastructure/CI.
- Steps to reproduce, or a proof-of-concept (a failing test against the
  contract test harness is ideal for on-chain issues).
- The commit hash or deployed contract address you tested against.
- Your assessment of severity and any suggested mitigation, if you have one.

Encrypt your report if it contains exploit details you consider sensitive;
otherwise plain email is fine.

### Response Process

1. **Acknowledgment** — within 3 business days of your report.
2. **Triage** — we confirm the issue, assess severity and affected scope,
   and reply with our initial assessment within 7 business days.
3. **Fix development** — a patch is developed and tested privately. For
   contract bugs this includes a testnet redeployment dry run before any
   mainnet action; see [Disaster Recovery](docs/disaster-recovery.md) for
   the emergency pause/redeploy procedure used if the bug is actively
   exploitable.
4. **Disclosure coordination** — we agree on a disclosure date with you
   (see Embargo Periods below).
5. **Release & credit** — the fix ships, an advisory is published, and you
   are credited (see Credit below) unless you ask to remain anonymous.

### Embargo Periods

We ask for a coordinated disclosure embargo so affected users have time to
act, particularly for anything touching deployed contracts (on-chain fixes
cannot be silently "patched" the way a server can):

| Severity | Target embargo |
|---|---|
| Critical (active fund/credential exploit) | Up to 90 days, or until a fix is deployed and confirmed, whichever is sooner |
| High (exploitable but not actively abused) | Up to 60 days |
| Medium/Low | Up to 30 days, or by mutual agreement |

If a vulnerability is already being actively exploited in the wild, we will
move to emergency disclosure and mitigation (contract pause, key rotation,
etc.) ahead of any embargo — see the emergency procedures in
[docs/disaster-recovery.md](docs/disaster-recovery.md).

We will extend or shorten these windows in discussion with the reporter
based on real-world risk, complexity of the fix, and whether third parties
(exchanges, integrators, custodians) need advance notice.

### Credit

Reporters who follow this policy and give us reasonable time to fix the
issue before public disclosure will be credited by name (or handle) in the
security advisory and release notes, unless they request anonymity. We do
not currently run a paid bug bounty program.

## Scope

**In scope:**
- `contracts/quorum_proof`, `contracts/sbt_registry`, `contracts/zk_verifier`,
  `contracts/bbs_plus_v1` — logic errors, authorization bypass, storage
  corruption, integer overflow, denial-of-service via gas exhaustion,
  cryptographic weaknesses in the ZK verification or BBS+ signing paths.
- `api-server` — authentication/authorization bypass, injection, request
  signing/HMAC weaknesses, rate-limiting/DDoS-protection bypass.
- `frontend`, `dashboard` — XSS, CSRF, key-handling bugs (e.g. exposing a
  wallet secret), dependency vulnerabilities with a real exploit path.
- CI/CD and deployment scripts — anything that could lead to a supply-chain
  compromise of a release artifact or deployed contract.

**Out of scope:**
- Issues requiring physical access to a user's device.
- Social engineering against QuorumProof maintainers or third-party
  institutions issuing credentials.
- Vulnerabilities in third-party dependencies with no demonstrated impact on
  QuorumProof specifically (report those upstream instead).
- Best-practice suggestions with no concrete exploit — open those as a
  normal GitHub issue or discussion instead.

## Background Reading

- [Threat Model & Security Analysis](docs/threat-model.md) — asset
  identification, threat actors, attack vectors and mitigations already
  considered. Please check here first; a report that matches an already
  -documented and accepted risk will be triaged accordingly.
- [Security Best Practices Guide](docs/security-best-practices.md)
- [Security Audit Checklist](docs/security-audit-checklist.md) — internal
  review checklist, useful context for what we already check for.
- [Known Limitations (ZK proof scheme)](docs/zk-proof-scheme-specification.md#13-known-limitations)
- [Disaster Recovery Procedures](docs/disaster-recovery.md) — what happens
  operationally once a critical issue is confirmed (emergency pause,
  redeployment, credential restoration).

## Software Bill of Materials (SBOM) — Issue #1481

QuorumProof generates a **CycloneDX 1.4 JSON** SBOM for every release and
every deployment to testnet so that downstream integrators and security
reviewers have a machine-readable dependency manifest without having to
reconstruct one from `Cargo.lock`.

### What is generated

| Artifact | Tool | Scope |
|---|---|---|
| `rust-workspace.cdx.json` | `cargo-cyclonedx` | All Rust workspace crates (quorum_proof, sbt_registry, zk_verifier, and their transitive Cargo dependencies) |
| `quorum_proof.cdx.json` | `cargo-cyclonedx` | `quorum_proof` crate only |
| `sbt_registry.cdx.json` | `cargo-cyclonedx` | `sbt_registry` crate only |
| `zk_verifier.cdx.json` | `cargo-cyclonedx` | `zk_verifier` crate only |
| `api-server.cdx.json` | `@cyclonedx/cyclonedx-npm` | api-server Node.js dependencies |

### Where to find SBOMs

- **GitHub Actions artifacts** — Every run of `.github/workflows/sbom.yml`
  and `.github/workflows/testnet-deploy.yml` uploads the SBOMs as workflow
  artifacts with 90-day retention.
- **GitHub Releases** — For tagged releases, the SBOM files are attached
  directly to the release as downloadable assets.
- **`sbom/` directory** — CI writes generated files here during the build;
  the directory is tracked in git so the path always exists.

### Format

Files conform to [CycloneDX specification v1.4](https://cyclonedx.org/specification/overview/)
in JSON encoding.  They are consumable by:

- [Dependency-Track](https://dependencytrack.org/)
- [FOSSA](https://fossa.com/)
- GitHub's dependency graph import
- `cargo-deny` and `cargo-audit` for advisory cross-referencing
- Most commercial SCA (Software Composition Analysis) tools

### Generating locally

```bash
# Install the tool (once)
cargo install cargo-cyclonedx --locked

# Generate for the whole workspace
cargo cyclonedx --format json --spec-version 1.4 --all

# Generate for a single crate
cargo cyclonedx --format json --spec-version 1.4 --package quorum_proof

# api-server (Node.js)
cd api-server
npm install --save-dev @cyclonedx/cyclonedx-npm
npx @cyclonedx/cyclonedx-npm --output-format JSON --spec-version 1.4
```

### CI integration

SBOM generation is wired into two workflows:

- **`.github/workflows/sbom.yml`** — Dedicated SBOM workflow; runs on push
  to `main`, on tagged releases, and on workflow dispatch.
- **`.github/workflows/testnet-deploy.yml`** — SBOM generated immediately
  after the contract WASM build so the exact artifact deployed to testnet
  is covered.
