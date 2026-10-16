# Container Image Scanning (Issue #1651)

Every container image QuorumProof ships is scanned for known vulnerabilities,
embedded secrets and Dockerfile misconfigurations — on every PR that touches an
image, on every push to `main`, and **daily** so that newly disclosed CVEs in
already-merged images are caught.

| Image | Dockerfile |
|---|---|
| `api-server` | `api-server/Dockerfile` |
| `exporter` | `monitoring/exporter/Dockerfile` |
| `tts` | `services/tts/Dockerfile` |

## Pipeline

`.github/workflows/container-scan.yml`:

1. **`trivy-db`** — downloads the Trivy vulnerability database (and Java DB)
   once, caches it for the day, and shares it with every scan job.
2. **`scan` (matrix per image)** — builds the image (not pushed), then runs
   `scripts/scan_images.sh`, which:
   * scans the image with Trivy (OS packages + language dependencies + secrets),
   * scans the Dockerfile for misconfigurations,
   * writes JSON, SARIF and Markdown reports and a `counts.json` summary,
   * evaluates the blocking policy.
3. **Reporting** — SARIF is uploaded to GitHub code scanning (Security tab →
   *Code scanning*, category `container-<image>`), reports are uploaded as the
   `container-scan-<image>` artifact (90-day retention), and the Markdown
   summary is added to the job summary.
4. **Alerting** — see below.

## Vulnerability database

Trivy aggregates NVD, GitHub Security Advisories, and distribution advisories
(Alpine secdb, Debian security tracker, etc.). The workflow:

* refreshes the DB at most once per day (cache key `trivy-db-YYYY-MM-DD`),
* falls back from `ghcr.io/aquasecurity/trivy-db` to the public ECR mirror to
  avoid GHCR rate limits,
* fails the scan job if the cached DB is missing rather than silently scanning
  with a stale or empty database (`fail-on-cache-miss: true`).

Local runs download the DB on first use into `~/.cache/trivy`.

## Policy

A scan **fails** when the image contains:

* a vulnerability of severity **CRITICAL or HIGH that has a fixed version
  available**, or
* any **secret**.

Unfixed vulnerabilities and MEDIUM/LOW findings are reported but do not
block. Dockerfile misconfigurations are advisory. Override the blocking
severities with `--fail-on` or `SCAN_FAIL_SEVERITY` (e.g. `CRITICAL`).

### Accepting a risk

Add the ID to `.trivyignore` with an expiry (≤ 90 days), owner, justification
and tracking issue:

```
# Not reachable: only affects the `foo` CLI, not present in the runtime stage.
# Owner: @security-team  Tracking: #1234
CVE-2024-00000 exp:2026-12-31
```

Expired entries stop suppressing automatically.

## Alerting

On `main` pushes and scheduled runs:

* a policy violation **opens (or updates) a GitHub issue** titled
  `Container vulnerabilities: <image>` labelled `security`,
  `container-vulnerability`, containing the summary and a link to the reports;
* when a later scan is clean, that issue is **commented on and closed**;
* if the `SLACK_SECURITY_WEBHOOK_URL` repository secret is set, a Slack
  message with severity counts is posted.

On PRs, the check simply fails with the findings in the job summary.

## Running locally

```bash
# one image
docker build -t quorumproof/api-server:dev api-server
scripts/scan_images.sh --image quorumproof/api-server:dev \
  --dockerfile api-server/Dockerfile --name api-server

# every image in the repo
scripts/scan_images.sh --all
```

Reports are written to `scan-reports/<name>/`. Exit codes: `0` clean, `1`
policy violation, `2` scanner / usage error.

## Remediation tips

* Most base-image findings are fixed by rebuilding on the latest patch tag
  (`node:22-alpine`, `python:3.11-slim`) — Dependabot's `docker` ecosystem can
  automate this.
* For npm findings, `npm audit fix` / bump the direct dependency; for
  transitive-only issues use `overrides` in `package.json`.
* Keep build tooling out of runtime stages (multi-stage builds) — anything not
  in the final image is not scanned and cannot be exploited.
