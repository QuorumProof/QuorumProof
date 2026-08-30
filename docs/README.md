# QuorumProof — Documentation Index

This directory contains all design, operational, and reference documentation for QuorumProof.
New contributors should start with [Architecture Overview](architecture.md) and
[Trust Slice Model](trust-slices.md) before diving into specific areas.

---

## Quick navigation

| Area | Document |
|---|---|
| Architecture & design | [architecture.md](architecture.md) |
| Trust model (FBA) | [trust-slices.md](trust-slices.md) |
| ZK verification design | [zk-verification.md](zk-verification.md) |
| BBS+ selective disclosure | [bbs-plus-tutorial.md](bbs-plus-tutorial.md) |
| Threat model & security | [threat-model.md](threat-model.md) |
| Credential fraud threat model | [THREAT_MODEL_CREDENTIAL_FRAUD.md](THREAT_MODEL_CREDENTIAL_FRAUD.md) |
| Error code reference | [error-codes.md](error-codes.md) |
| SDK methods reference | [sdk-methods-reference.md](sdk-methods-reference.md) |
| REST API client guide | [api-client-guide.md](api-client-guide.md) |
| Integration patterns | [integration-patterns-guide.md](integration-patterns-guide.md) |
| Issuer security checklist | [issuer-security-checklist.md](issuer-security-checklist.md) |
| Troubleshooting | [troubleshooting-guide.md](troubleshooting-guide.md) |
| Backup & recovery | [backup-system.md](backup-system.md) |
| Roadmap | [roadmap.md](roadmap.md) |
| Privacy guide | [privacy-guide.md](privacy-guide.md) |
| Architecture Decision Records | [adr/README.md](adr/README.md) |

---

## Internal Link Checker

Every pull request and push to `main` that modifies files under `docs/` is
automatically validated by the **Docs Link Check** GitHub Actions workflow
(`.github/workflows/docs-link-check.yml`). The check uses
[lychee](https://github.com/lycheeverse/lychee) in `--offline` mode, which means:

- Only **relative links** within `docs/` are verified.
- External URLs (`https://…`) are **not** checked — this keeps the check fast
  and avoids flaky failures from transient network issues.
- The check **fails the PR** if any dead internal cross-reference is found.

### Running the link checker locally

Before opening a PR that adds or renames docs, run:

```bash
# Install lychee (one-time)
curl -sSfL https://github.com/lycheeverse/lychee/releases/latest/download/lychee-x86_64-unknown-linux-gnu.tar.gz \
  | tar xz -C ~/.local/bin

# Run from the repository root
lychee \
  --offline \
  --no-progress \
  --base docs \
  "docs/**/*.md"
```

A successful run prints a summary and exits `0`. Any `[ERR]` line means a
relative link target does not exist — fix it before pushing.

### What counts as a broken link

The checker flags any `[text](relative-path.md)` where the target file does
not exist at that path relative to `docs/`. This catches:

- Files that were renamed without updating all references
- Files that were planned but never written (stub references)
- ADR number collisions where two files share the same prefix (see below)

### ADR numbering convention

ADR filenames follow the pattern `adr-NNN-<slug>.md`. Each `NNN` must be
**unique**. If two ADRs share the same number, tools and humans will
misidentify them. See [Known doc-drift issues](#known-doc-drift-issues) for
the current duplication.

### Contributor checklist for new docs

When adding a new document to `docs/`:

1. Place it under `docs/` (or `docs/adr/` for architecture decisions).
2. Add an entry to the table above in this file.
3. If it's an ADR, assign the next available number and update `docs/adr/README.md`.
4. Run the local link checker command above and fix any errors before pushing.
5. If your doc references files that don't exist yet, use a `<!-- TODO: link once #NNNN ships -->` comment instead of a broken relative link.

---

## Known doc-drift issues

The following broken links and numbering issues were found by the link checker
on **2026-08-30** when it was first run against the current docs tree. They are
tracked here as follow-up work rather than blocking the link-checker rollout.

> **Note**: These are not fixed in this PR to keep the scope small. Each item
> should be resolved in a dedicated follow-up.

### Broken relative links (3 missing files)

| Missing file | Referenced from | Notes |
|---|---|---|
| `docs/trust-slices.md` | `docs/error-codes.md:373` | File was listed in README but never created; content may be partially in `docs/architecture.md` |
| `docs/trust-slices.md` | `docs/sdk-methods-reference.md:807` | Same missing file |
| `docs/trust-slices.md` | `docs/credential-types.md:858` | Same missing file |
| `docs/trust-slices.md` | `docs/adr/adr-001-fba-trust-model.md:133` | Same missing file |
| `docs/trust-slices.md` | `docs/api-client-guide.md:696` | Same missing file |
| `docs/zk-verification.md` | `docs/credential-types.md:859` | File was listed in README but never created; content exists in `docs/zk-verification-implementation.md` and `docs/zk-proof-scheme-specification.md` |
| `docs/zk-verification.md` | `docs/adr/adr-003-zk-verification.md:167` | Same missing file |
| `docs/zk-verification.md` | `docs/api-client-guide.md:697` | Same missing file |
| `docs/credential-expiry.md` | `docs/credential-types.md:857` | Planned v2.0 feature doc, not yet written |
| `docs/credential-expiry.md` | `docs/adr/adr-002-sbt-non-transferability.md:130` | Same missing file |

**Suggested resolutions**:
- `docs/trust-slices.md` — create as a redirect/summary page pointing to `architecture.md` and the FBA trust model ADR, or write the missing content (estimated: 1–2 hours).
- `docs/zk-verification.md` — create as a redirect/index page pointing to `zk-verification-implementation.md`, `zk-proof-scheme-specification.md`, and ADR-003 (estimated: 30 minutes).
- `docs/credential-expiry.md` — add a stub with a "planned for v2.0" notice so the link resolves and the roadmap context is clear (estimated: 15 minutes).

### ADR number collision

Both of the following files use the prefix `adr-006-`:

- `docs/adr/adr-006-economic-security-model.md`
- `docs/adr/adr-006-quorum-intersection-verification.md`

One of them must be renumbered. The quorum-intersection-verification ADR
appears to have been added later (July 2026); renaming it to `adr-008` (next
available number after `adr-007`) and updating all references is the
recommended resolution. This requires:

1. Renaming the file to `docs/adr/adr-008-quorum-intersection-verification.md`
2. Updating `docs/adr/README.md` index row
3. Searching `docs/**` for any cross-references to `adr-006-quorum-intersection-verification.md` and updating them
4. Updating any external links or issue references

(Estimated: 30 minutes)
