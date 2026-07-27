# Operator Health Metrics — Interpretation Guide

This is a quick-reference for the metrics operators actually watch day to day:
storage usage, active credentials, and error rates. For architecture/setup of
the monitoring stack itself, see [`contract-monitoring.md`](contract-monitoring.md)
and [`monitoring-guide.md`](monitoring-guide.md).

All metrics below are sourced from `QuorumProofContract::get_state_metrics`
(see `contracts/quorum_proof/src/state_metrics.rs`), a single unauthenticated,
O(1) read that the exporter polls every scrape interval alongside its normal
event stream.

## Metrics

| Metric | What it means | Healthy pattern | When to worry |
|---|---|---|---|
| `quorumproof_credentials_active_total` | Credentials issued minus revoked. The headline "how much is actually in use" number. | Grows roughly with issuance traffic; never negative. | A sudden drop usually means a revocation spike — cross-check `quorumproof_credentials_revoked_snapshot_total`. |
| `quorumproof_credentials_revoked_snapshot_total` | Cumulative revocations, maintained incrementally on-chain (`DataKey::RevokedCredentialCount`) so it's cheap to read even at large scale. | Grows slowly and steadily. | A step change or a revocation rate above ~30% of recent activity — see the `HighCredentialRevocationRate` alert. |
| `quorumproof_storage_entries_estimate` | Sum of credential + slice + DID counters. **Not a byte count** — Soroban does not expose contract storage size to contract code, so this is a monotonic proxy for storage growth, not an absolute size. | Slope tracks issuance rate. | A sudden jump in slope (see `StorageGrowthAnomaly`) — could be legitimate onboarding or an abuse/spam pattern. |
| `quorumproof_state_version` | The on-chain schema/state version (`DataKey::StateVersion`). | Exactly one value across all exporter instances. | More than one distinct value observed (`StateVersionMismatch`) — usually a partially-rolled-out upgrade or a stale exporter pointed at an old deployment. |
| `quorumproof_contract_paused` | 1 if the contract is currently paused. | 0. | Any 1 reading outside a planned maintenance window — see `ContractPaused` alert. |
| `quorumproof_api_errors_total` (rate/increase) | RPC/contract error volume, labeled by `error_code`. | Near zero. | Sustained rate > 0.1/s (`HighErrorRate`) or a burst > 20 in 10m (`ContractErrorBurst`) — check `Recent Errors by Code` panel to find the dominant code. |

## Dashboards

- **Contract Health** (`monitoring/grafana/dashboards/contract-health.json`) —
  the primary operator view: pause state, error rate, active/revoked
  credentials, storage usage trend, state version, and migration progress, all
  in one screen.
- **Attestation Health**, **API Latency**, **Credential Volume** — see the
  other dashboards under `monitoring/grafana/dashboards/` for
  attestation-specific and traffic-specific views.

## Alert thresholds

Defined in `monitoring/prometheus/alerts.yml`. The ones added alongside this
guide:

- `StorageGrowthAnomaly` — storage entries growing faster than 500/s sustained
  over 15 minutes.
- `HighCredentialRevocationRate` — revocations exceed 30% of recent
  active+revoked activity over an hour.
- `StateVersionMismatch` — more than one `state_version` value observed across
  scraped instances.

As with the pre-existing alerts (`HighErrorRate`, `ContractErrorBurst`,
`ContractPaused`, `LowAttestationRate`), these fire to AlertManager
(`monitoring/prometheus/alertmanager.yml`) using the same `severity` labels
(`critical` pages, `warning` doesn't).

## Adding a metric

1. If the value can be derived from existing on-chain counters, add it to
   `ContractStateMetrics` in `state_metrics.rs` — keep it O(1); never iterate
   an unbounded collection in a metrics call.
2. Add a `Gauge`/`Counter` in `monitoring/exporter/metrics.py`.
3. Set it in `QuorumProofExporter._scrape_state_metrics` (or add a new
   `_scrape_*` method, following the same pattern) in
   `monitoring/exporter/exporter.py`.
4. Add a panel to `contract-health.json` and, if it needs paging or a
   maintenance response, a rule in `alerts.yml`.
5. Document the healthy/unhealthy pattern in the table above.
