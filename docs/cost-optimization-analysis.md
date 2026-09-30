# Cost Optimization Analysis

**Issue #1657** — Infrastructure costs aren't analyzed. This document covers cost
tracking, attribution, reporting, and concrete optimization opportunities for
QuorumProof's Soroban smart-contract operations and supporting infrastructure.

## Overview

QuorumProof tracks on-chain gas costs (Soroban `minResourceFee` in stroops) for
every contract operation via `api-server/src/services/gasCostTracker.ts` (see the
existing `docs/cost-optimization-guide.md` for the API-level description). This
document extends that foundation with:

- Team-level **cost attribution** for charge-back and budget tracking
- Automated **cost reports** runnable from CI or on demand
- Identified **optimization opportunities** with estimated savings
- A **Terraform module** for tracking infrastructure-level cost tags

## Tooling

### `scripts/cost_report.sh`

Pulls the `/api/costs/report`, `/api/costs/optimizations`, and
`/api/costs/projection` endpoints and renders a human-readable summary.

```bash
# Basic report
./scripts/cost_report.sh

# Save full JSON report
./scripts/cost_report.sh --output /tmp/cost-report.json

# Show top 20 operations
./scripts/cost_report.sh --top 20

# Project cost for 50 000 calls/day over 90 days
./scripts/cost_report.sh --calls 50000 --days 90
```

### `scripts/cost_attribution.sh`

Maps operations to owning teams using `infra/cost-attribution.json` and prints a
per-team breakdown.

```bash
# Default config
./scripts/cost_attribution.sh

# Custom attribution config
./scripts/cost_attribution.sh --config myteam-attribution.json

# Emit JSON for downstream tooling
./scripts/cost_attribution.sh --json --output attr.json
```

### `infra/cost-attribution.json`

Declares which operations belong to which team. Edit this file to reflect your
org structure. Unattributed operations are flagged at report runtime.

### `infra/terraform/modules/cost-tracking/`

Terraform module that adds AWS Cost Allocation Tags to all QuorumProof resources
(ECS tasks, RDS, S3, CloudWatch) so costs are visible in AWS Cost Explorer broken
down by `Project`, `Environment`, `Team`, and `Component`.

---

## Cost Attribution Model

| Team | Owned Operations | Notes |
|------|-----------------|-------|
| `credentials` | `issue_credential`, `get_credential`, `revoke_credential`, `batch_issue_credentials` | Highest volume; primary optimization target |
| `attestation`  | `attest`, `is_attested`, `get_attestors`, `remove_attestor` | Second-highest read volume |
| `zk`           | `verify_groth16_proof`, `verify_plonk_proof`, `verify_claim` | Highest per-call fee; low volume |
| `slices`       | `create_slice`, `get_slice`, `add_attestor` | Low volume; moderate fee |
| `registry`     | `register_sbt`, `get_sbt` | SBT issuance; low volume |
| `infrastructure` | `get_version`, `admin_*`, `upgrade` | Ops overhead; minimal cost |

---

## Identified Optimization Opportunities

### 1. Batch credential issuance (credentials team)

**Issue**: `issue_credential` is called one-at-a-time in integrations that issue
multiple credentials in one session (e.g., during onboarding when degree + license
are issued together).

**Optimization**: Use `batch_issue_credentials` which amortizes transaction
overhead across multiple issuances in a single Soroban invocation.

**Estimated savings**: 30–40% reduction in per-credential fee at volumes > 100/day.

```bash
# Measure current average via the projection endpoint
curl "http://localhost:3001/api/costs/projection?operation=issue_credential&callsPerDay=1000&days=30"
curl "http://localhost:3001/api/costs/projection?operation=batch_issue_credentials&callsPerDay=100&days=30"
```

### 2. Cache `is_attested` read calls (attestation team)

**Issue**: `is_attested` is the highest-volume read operation. It is often called
redundantly (e.g., on every page load) despite the attestation state changing
rarely.

**Optimization**: The existing credential cache (`docs/` → issue #1555) already
caches `get_credential`. Extend it to cache `is_attested` results with a TTL of
5 minutes for attested credentials (revocations still invalidate immediately via
the webhook event stream).

**Estimated savings**: 60–80% reduction in `is_attested` on-chain calls for
production traffic patterns.

### 3. Reduce ZK proof verification compute (zk team)

**Issue**: `verify_groth16_proof` and `verify_plonk_proof` have the highest
per-call fees because BLS12-381 pairing arithmetic is compute-intensive on-chain.

**Optimization**:
- Pre-verify proofs off-chain in the API server before submitting to the contract.
  Reject malformed proofs before paying the on-chain fee.
- Implement a verification result cache keyed on `(proof_hash, verifying_key_hash)`
  with a short TTL to deduplicate repeated verification of the same proof.

**Estimated savings**: 15–25% reduction in paid ZK verification fees (avoids
paying for proofs that would fail anyway).

### 4. RPC simulation before submission

**Issue**: Failed contract invocations still consume the base transaction fee.

**Optimization**: The API server already calls `simulateTransaction` before
submitting. Enforce a hard gate: any simulation that returns an error MUST NOT
be submitted. This is already mostly true but some error paths bypass the guard.

**Estimated savings**: 5–10% reduction in wasted fees on malformed inputs.

### 5. Infrastructure right-sizing (all teams)

**Issue**: ECS task definitions use fixed CPU/memory allocations that were set
conservatively at launch and haven't been revisited.

**Optimization**: Use the Terraform `cost-tracking` module outputs combined with
AWS CloudWatch Container Insights to identify tasks running at < 40% CPU/memory
utilization. Right-size to the next-lower Fargate tier.

**Estimated savings**: 20–35% reduction in compute costs. Use
`infra/terraform/modules/cost-tracking` to tag resources and surface them in
AWS Cost Explorer.

---

## CI Integration

Add the cost report to your CI pipeline to catch regressions:

```yaml
# .github/workflows/cost-check.yml
- name: Cost report
  run: |
    ./scripts/cost_report.sh --output /tmp/cost-report.json
    # Fail if total daily cost exceeds budget (example: 100 XLM/day)
    DAILY_XLM=$(jq -r '.report.dailyAvgXlm // 0' /tmp/cost-report.json)
    awk "BEGIN{if ($DAILY_XLM > 100) {print \"COST BUDGET EXCEEDED\"; exit 1}}"
```

## Cost Monitoring Dashboard

The Grafana dashboard at `monitoring/grafana/dashboards/` can be extended with
cost panels. Add the following PromQL queries:

```promql
# Average fee per operation (stroops)
avg by (operation) (quorumproof_contract_fee_stroops)

# Total daily cost (XLM)
sum(increase(quorumproof_contract_fee_stroops[24h])) / 10000000

# Top 5 cost contributors
topk(5, sum by (operation) (increase(quorumproof_contract_fee_stroops[24h])))
```

## See Also

- [`docs/cost-optimization-guide.md`](cost-optimization-guide.md) — gas cost tracking API reference
- [`infra/cost-attribution.json`](../infra/cost-attribution.json) — team attribution config
- [`scripts/cost_report.sh`](../scripts/cost_report.sh) — on-demand cost report
- [`scripts/cost_attribution.sh`](../scripts/cost_attribution.sh) — team attribution report
- [`infra/terraform/modules/cost-tracking/`](../infra/terraform/modules/cost-tracking/) — AWS cost tags
