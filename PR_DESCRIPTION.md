## Summary

- Set explicit least-privilege token permissions on all GitHub Actions workflows and add CI checks for missing permissions and floating `@main`/`@master` action refs.
- Pin TruffleHog to v3.99.2 and document the pinned commit.
- Add tests for wallet connection, network switching, the credential issuance wizard, and attestor reputation states.

## Validation

- `scripts/check_workflows.sh` and `git diff --check` pass.
- Frontend tests and lint could not run because frontend dependencies are not installed in this checkout.
- GitHub-hosted CI has not been run for this branch.

Closes #1817
Closes #1816
Closes #1815
Closes #1814
