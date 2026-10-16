# QuorumProof Infrastructure as Code (Issue #1652)

All QuorumProof cloud infrastructure is declared in Terraform in this
directory. Nothing should be created or changed by hand in the cloud console —
if it is not in this tree, it does not exist.

```
infra/terraform/
├── modules/
│   ├── network/       VPC, public/private subnets, NAT, flow logs
│   ├── compute/       ECS Fargate cluster + api-server service behind an ALB
│   ├── database/      Aurora PostgreSQL (global cluster aware)        (#1650)
│   ├── storage/       Versioned, encrypted S3 bucket with optional CRR (#1650)
│   ├── failover/      Route 53 health checks + failover DNS records    (#1650)
│   └── log-archive/   Log retention + cold-storage archival bucket     (#1653)
├── environments/
│   ├── staging/       Single-region stack
│   └── production/    Multi-region (primary + secondary) stack         (#1650)
└── modules/*/tests/    `terraform test` suites (mock providers, plan only)
```

See [docs/infrastructure-as-code.md](../../docs/infrastructure-as-code.md) for
the full workflow (state backend bootstrap, plan/apply, drift detection and
testing) and [docs/multi-region-failover.md](../../docs/multi-region-failover.md)
for the failover design.

## Quick start

```bash
cd infra/terraform/environments/production
terraform init -backend-config=backend.hcl
terraform plan -out=tfplan
terraform apply tfplan
```

## Conventions

* Terraform `>= 1.9` (cross-variable validation, `terraform test` mocks), AWS provider `~> 5.40` (pinned in each root's `versions.tf`).
* Every resource is tagged with `Project`, `Environment`, `ManagedBy=terraform`
  and `Region` via provider `default_tags`.
* Modules never configure providers; roots pass aliased providers in.
* Remote state lives in S3 with DynamoDB locking; one state file per environment.
* Changes land via PR only — `.github/workflows/terraform.yml` runs
  `fmt`, `validate`, `tflint`, `checkov` and `terraform test` and posts the
  plan on the PR.
