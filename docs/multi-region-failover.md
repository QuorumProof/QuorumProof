# Multi-Region Failover (Issue #1650)

QuorumProof's off-chain services (api-server, its Aurora PostgreSQL database
and S3 data) run **active/passive across two AWS regions**. The on-chain
contracts are already replicated by the Stellar network; this document covers
everything else.

> For Soroban **RPC endpoint** failover (switching between Stellar RPC
> providers) see [multi-region-deployment.md](./multi-region-deployment.md) and
> `scripts/failover.sh`. This document is about moving the whole service
> between AWS regions.

## Architecture

```
                     api.quorumproof.io
                            │
               Route 53 failover records (PRIMARY / SECONDARY)
               + HTTPS health checks on /health/ready (3 checker regions)
                   ┌────────┴────────┐
        us-east-1 (primary)      eu-west-1 (secondary, warm standby)
        ┌──────────────────┐     ┌──────────────────┐
        │ ALB → ECS api ×3 │◄───►│ ALB → ECS api ×2 │   /health/region
        │                  │probe│                  │   (peer detector)
        │ Aurora writer    │────►│ Aurora replica   │   Aurora Global DB (<1s lag)
        │ S3 data bucket   │────►│ S3 data bucket   │   S3 CRR (RTC, 15 min SLA)
        │ KMS MRK primary  │────►│ KMS MRK replica  │
        │ Log archive (S3) │     │ Log archive (S3) │   per-region (#1653)
        └──────────────────┘     └──────────────────┘
```

All of it is declared in Terraform — `infra/terraform/environments/production`
(see [infrastructure-as-code.md](./infrastructure-as-code.md)).

| Component | Replication mechanism | RPO | RTO (automatic part) |
|---|---|---|---|
| API traffic | Route 53 failover DNS | n/a | ~90 s (3 × 10 s checks + 60 s TTL) |
| Database | Aurora Global Database | typically < 1 s | minutes (operator-initiated promotion) |
| Object data / backups | S3 CRR with Replication Time Control | ≤ 15 min (99.99 %) | none needed (already in region) |
| Encryption keys | KMS multi-region keys | 0 | 0 |
| Secrets | Secrets Manager replica secrets | 0 | 0 |

## Failover detection

Detection happens at two independent layers:

1. **Route 53 health checks** (`modules/failover`) probe each region's
   `/health/ready` over HTTPS from three checker locations. After 3
   consecutive failures from a majority of checkers the PRIMARY record is
   withdrawn and DNS answers with the SECONDARY. A CloudWatch alarm per region
   publishes to the `quorumproof-prod-region-failover` SNS topic.
2. **In-application peer detector** (`api-server/src/services/regionFailover.ts`).
   Each region polls the other region's readiness URL
   (`PEER_REGION_HEALTH_URL`) every `FAILOVER_CHECK_INTERVAL_MS` (10 s) with
   hysteresis (`FAILOVER_FAILURE_THRESHOLD` / `FAILOVER_RECOVERY_THRESHOLD`,
   default 3). It exposes:

   * `GET /health/region` — role, peer state, `failoverActive`
   * `GET /health/region/metrics` — `quorumproof_region_peer_up`,
     `quorumproof_region_failover_active`, `quorumproof_region_failovers_total`,
     `quorumproof_region_peer_probe_latency_ms`
   * optional Slack-compatible webhook (`FAILOVER_ALERT_WEBHOOK_URL`) on every transition

   Prometheus rules `RegionFailoverActive` and `RegionPeerUnreachable`
   (`monitoring/prometheus/alerts.yml`) alert on these metrics, so on-call is
   paged even if the AWS alarm path is impaired by the same outage.

The peer state is deliberately **not** part of `/health/ready`: a region must
never fail its own readiness because its peer is down, or both regions could
be withdrawn from DNS simultaneously.

| Env var | Default | Set by |
|---|---|---|
| `REGION_NAME` | `local` | Terraform (`modules/compute`) |
| `REGION_ROLE` | `primary` | Terraform |
| `PEER_REGION_HEALTH_URL` | *(empty — detector disabled)* | Terraform |
| `FAILOVER_CHECK_INTERVAL_MS` | `10000` | optional |
| `FAILOVER_CHECK_TIMEOUT_MS` | `3000` | optional |
| `FAILOVER_FAILURE_THRESHOLD` | `3` | optional |
| `FAILOVER_RECOVERY_THRESHOLD` | `3` | optional |
| `FAILOVER_ALERT_WEBHOOK_URL` | *(unset)* | optional secret |

## Data replication

* **Aurora Global Database** — `modules/database` with
  `global_cluster_identifier` set in both regions. The secondary is read-only
  until promoted; an alarm fires when `AuroraGlobalDBReplicationLag` exceeds
  5 s for 5 minutes.
* **S3 cross-region replication** — `modules/storage` replicates every object
  (including delete markers) from the primary data bucket to the secondary
  with Replication Time Control and replication metrics enabled. Objects are
  re-encrypted with the secondary region's KMS replica key.
* **Secrets** — create each api-server secret with a replica in the secondary
  region (`aws secretsmanager replicate-secret-to-regions`); both regions'
  task definitions resolve the secret by name in their own region.
* **Container images** — pin `api_image` by digest and enable ECR
  cross-region replication (or push to both registries) so the secondary can
  start tasks while the primary registry is unavailable.

## Procedures

All operator actions go through `scripts/region_failover.sh`, which reads
region metadata from `terraform output -json regions` (or `REGIONS_JSON`).
Every mutating command supports `--dry-run` and asks for confirmation.

### Status

```bash
scripts/region_failover.sh status
```

### Unplanned failover (primary region down)

DNS moves automatically. The database does **not** — promotion is a human
decision because automatic promotion during a network partition risks
split-brain.

1. Confirm the primary is really down (AWS Health Dashboard, `status`, both
   alarm paths agree).
2. `scripts/region_failover.sh unplanned` — scales the secondary up, detaches
   the secondary Aurora cluster from the global cluster (it becomes a
   standalone writer), restarts api-server tasks and waits for readiness.
3. Announce on the status page. RPO equals the replication lag at the moment
   of failure (see `status` output / CloudWatch).

### Planned switchover (maintenance, drills)

```bash
scripts/region_failover.sh planned
```

Uses Aurora's managed switchover, which waits for full synchronisation — no
data loss.

### After a failover

Terraform still describes the old topology. Open a PR that swaps
`primary_region` / `secondary_region` (and the CIDR / certificate variables)
in the production tfvars so the Route 53 PRIMARY/SECONDARY records,
`REGION_ROLE` and the global cluster membership match reality. The database
module ignores out-of-band changes to global cluster membership, so an apply
during an incident will not undo the promotion.

### Failback

After an **unplanned** failover the old primary's database has diverged and
must not be reused:

1. Delete (after snapshotting) the old primary regional cluster.
2. Create a new global cluster from the promoted cluster
   (`aws rds create-global-cluster --source-db-cluster-identifier …`).
3. Apply Terraform with the swapped regions — the old region is recreated as
   secondary and re-seeded.
4. Optionally run a **planned** switchover to return to the original region.

## Failover test scenarios

Scenarios are run with `scripts/region_failover.sh drill <scenario>` against
staging first, then in a scheduled production game day. Always start with
`--dry-run` to review the commands.

| Scenario | What it does | Pass criteria |
|---|---|---|
| `primary-api-down` | Scales the primary ECS service to 0, waits, restores it | Route 53 serves the secondary within ~90 s; `RegionFailoverActive` fires on the secondary; SNS + webhook alerts delivered; primary returns to PRIMARY after recovery threshold |
| `health-check-flap` | Inverts the primary Route 53 health check for 60 s | Single alarm/recovery pair, no oscillation; peer detector hysteresis prevents duplicate alerts |
| `db-switchover` | Planned Aurora switchover to the secondary and back | Zero data loss (row counts / latest credential id match); api-server reconnects without manual restart |

Record the observed detection time, DNS convergence time, RPO and RTO for each
drill in the operations log and compare against the targets above.
