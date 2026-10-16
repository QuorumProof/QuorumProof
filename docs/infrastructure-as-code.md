# Infrastructure as Code (Issue #1652)

All QuorumProof cloud infrastructure is defined in Terraform under
[`infra/terraform/`](../infra/terraform/README.md) and changed only through
pull requests. Manual console changes are treated as drift and reported
automatically.

## Layout

| Path | Purpose |
|---|---|
| `infra/terraform/modules/network` | VPC, public/private subnets across AZs, NAT gateways, VPC flow logs |
| `infra/terraform/modules/compute` | ECS Fargate cluster, api-server service + autoscaling, ALB (HTTPS, `/health/ready` target health) |
| `infra/terraform/modules/database` | Aurora PostgreSQL, Aurora Global Database membership, replication-lag alarm |
| `infra/terraform/modules/storage` | Encrypted, versioned, private S3 bucket with optional cross-region replication |
| `infra/terraform/modules/failover` | Route 53 health checks, failover records, failover SNS alarms |
| `infra/terraform/modules/log-archive` | Log archive bucket, lifecycle tiering, Object Lock, Firehose, Athena |
| `infra/terraform/environments/staging` | Single-region stack (cost-reduced) |
| `infra/terraform/environments/production` | Two-region active/passive stack ([multi-region-failover.md](./multi-region-failover.md)) |

Modules never declare providers; environment roots pass in (aliased)
providers, so the same module is instantiated once per region.

## Prerequisites

* Terraform **1.9+**
* AWS credentials for the target account
* A Route 53 hosted zone and ACM certificates in each region for the API
  hostname (these are account-level and deliberately not managed here)

## Bootstrapping remote state (once per account)

```bash
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
aws s3api create-bucket --bucket "quorumproof-terraform-state-$ACCOUNT" --region us-east-1
aws s3api put-bucket-versioning --bucket "quorumproof-terraform-state-$ACCOUNT" \
  --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "quorumproof-terraform-state-$ACCOUNT" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms"}}]}'
aws s3api put-public-access-block --bucket "quorumproof-terraform-state-$ACCOUNT" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws dynamodb create-table --table-name quorumproof-terraform-locks \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH --billing-mode PAY_PER_REQUEST
```

Then in each environment directory copy `backend.hcl.example` to
`backend.hcl` (git-ignored) and fill in the bucket name.

## Day-to-day workflow

```bash
cd infra/terraform/environments/staging
cp ../production/terraform.tfvars.example terraform.tfvars   # edit values
terraform init -backend-config=backend.hcl
terraform plan -out=tfplan
```

1. Open a PR with the change. CI (`.github/workflows/terraform.yml`) runs:
   * `terraform fmt -check`
   * `terraform validate` on every module and environment
   * `terraform test` (module unit tests, see below)
   * `tflint` (recommended + AWS rulesets)
   * `checkov` security scan (SARIF → code scanning)
   * `terraform plan` for staging and production, posted as a PR comment
2. After review and merge, a maintainer runs the **Terraform** workflow
   manually with `action=apply` and the target environment. Apply jobs use the
   protected `infra-staging` / `infra-production` GitHub environments, which
   require reviewer approval, and assume a dedicated apply role via OIDC — no
   long-lived AWS keys in GitHub.
3. Always apply to **staging first**.

### Required repository secrets

| Secret | Used by |
|---|---|
| `AWS_TERRAFORM_PLAN_ROLE_ARN` | plan + drift jobs (read-only role, OIDC trust on this repo) |
| `AWS_TERRAFORM_APPLY_ROLE_ARN` | apply job (write role, OIDC trust restricted to `main` + environment) |
| `TF_BACKEND_HCL` | contents of `backend.hcl` |
| `TF_VARS_STAGING`, `TF_VARS_PRODUCTION` | contents of each environment's tfvars |

## Version control of infrastructure

* The Terraform code, provider lock files (`.terraform.lock.hcl`, commit them
  after the first `init`) and module tests live in git; state lives in the
  versioned S3 bucket, so every past state is recoverable.
* Provider and Terraform versions are pinned in `versions.tf`.
* Git-ignored: `.terraform/`, `*.tfstate*`, plan files, `backend.hcl`,
  real `*.tfvars` (only `*.tfvars.example` is committed).
* **Drift detection** runs every Monday: a non-empty
  `plan -detailed-exitcode` opens / updates an `infra-drift` GitHub issue.

## Infrastructure testing

| Layer | Tool | Where |
|---|---|---|
| Formatting | `terraform fmt` | CI |
| Static validity | `terraform validate` | CI, every module + root |
| Unit tests | `terraform test` with `mock_provider` (plan-only, no credentials) | `infra/terraform/modules/*/tests/*.tftest.hcl` |
| Lint | `tflint` | `infra/terraform/.tflint.hcl` |
| Security policy | `checkov` | `infra/terraform/.checkov.yml` (each skip justified) |
| Integration | `terraform plan` against real state | CI on PRs |
| Behavioural | failover drills | [multi-region-failover.md](./multi-region-failover.md#failover-test-scenarios) |

Run the unit tests for a module locally:

```bash
cd infra/terraform/modules/failover
terraform init -backend=false
terraform test
```

The tests assert module contracts — e.g. the failover module rejects two
primaries, the log archive enforces ≥ 365-day retention and Object Lock by
default, S3 replication is only configured when a destination is given, a
secondary Aurora cluster never creates its own global cluster.

## Importing existing (manually created) resources

For resources that already exist, use `import` blocks in the environment root
rather than recreating them:

```hcl
import {
  to = module.storage_primary.aws_s3_bucket.this
  id = "existing-bucket-name"
}
```

Run `terraform plan` until it shows no changes for imported resources, then
remove the `import` blocks in a follow-up PR.
