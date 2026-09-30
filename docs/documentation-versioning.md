# Documentation Versioning

> Issue #1642. Operators and integrators on an older release need docs that
> match the contracts and API they actually run. This page covers how
> documentation versions are defined, how to switch between them, how each
> version is maintained, and when a version is deprecated.

---

## Table of Contents

1. [How versions work](#1-how-versions-work)
2. [Switching versions](#2-switching-versions)
3. [Cutting a new version](#3-cutting-a-new-version)
4. [Maintaining older versions](#4-maintaining-older-versions)
5. [Deprecation policy](#5-deprecation-policy)
6. [Manifest reference](#6-manifest-reference)

---

## 1. How versions work

Documentation versions are **git refs**, not copies of `docs/` inside the tree.
Copies would double the size of `docs/`, confuse the docs index and link
checks, and drift the moment someone forgets to update both.

| Version | Git ref | What it documents |
|---|---|---|
| `latest` | `main` | Unreleased work on `main`. Always the default. |
| `MAJOR.MINOR` (e.g. `1.0`) | branch `docs/vMAJOR.MINOR` | The release line with that contract version (see `contracts/quorum_proof/src/version.rs`). |

Patch releases (`1.0.1`, `1.0.2`) share their minor version's docs. A patch
never changes a public interface, so it doesn't need a separate docs version.

The list of versions and their status lives in
[`versions.json`](./versions.json). The interactive docs version switcher
reads it, and `scripts/docs_versions.py` manages it.

---

## 2. Switching versions

**Interactive docs.** Open `docs/interactive/` (see
[interactive-documentation.md](./interactive-documentation.md)) and pick a
version from the **Docs version** menu in the header. Search result links
then open that version's copy of each page on GitHub. If the version is
deprecated or at end of life, a banner shows the dates. Your choice is saved
in the URL (`?v=1.0`), so you can share the link.

The search index is always built from `latest`. A page that was added after
an older version was cut won't exist on that version's branch, and its link
will 404.

**GitHub.** Use the branch selector, or change the ref in the URL:

```
https://github.com/QuorumProof/QuorumProof/blob/main/docs/deployment-guide.md       # latest
https://github.com/QuorumProof/QuorumProof/blob/docs/v1.0/docs/deployment-guide.md  # v1.0
```

**Locally.**

```bash
git fetch upstream
git worktree add ../quorumproof-docs-v1.0 upstream/docs/v1.0
# read ../quorumproof-docs-v1.0/docs/
```

---

## 3. Cutting a new version

A maintainer cuts a docs version as part of every **minor or major** release,
right after the release commit lands on `main`:

```bash
python3 scripts/docs_versions.py cut 1.1          # branch docs/v1.1 from HEAD, add to manifest
git push upstream docs/v1.1
git add docs/versions.json
git commit -m "docs: cut documentation version 1.1"
```

Use `--ref <sha>` to branch from the release commit if `main` has moved on.
Cutting a new version doesn't deprecate the older ones on its own. Apply
[§5](#5-deprecation-policy) as a separate step.

---

## 4. Maintaining older versions

- **Fix on `main` first**, then backport. Cherry-pick the docs commit onto
  every supported `docs/vX.Y` branch it applies to:
  ```bash
  git checkout -b backport/1.0-fix-typo upstream/docs/v1.0
  git cherry-pick -x <sha>
  # open a PR against docs/v1.0
  ```
- **Backport only what's true for that version.** If a fix describes behaviour
  that changed after the version was cut, rewrite it for the old behaviour. Don't
  cherry-pick it as-is.
- **What gets backported**, by version status:

  | Change | `supported` | `deprecated` | `eol` |
  |---|---|---|---|
  | Security advisories / security-relevant corrections | Yes | Yes | Yes (banner only) |
  | Factual errors, broken commands, broken links | Yes | Yes | No |
  | Clarifications, new examples | Yes | No | No |
  | Docs for new features | No: those go in `latest` only | No | No |

- **Pull requests against a `docs/vX.Y` branch** follow the normal review
  process. Put `[docs vX.Y]` at the start of the title so reviewers can see
  which branch it targets.
- The manifest on `main` is the only source of truth for status. Don't edit
  `versions.json` on version branches.

---

## 5. Deprecation policy

Each docs version moves through these states:

```
supported ──(deprecate)──▶ deprecated ──(180 days)──▶ eol
```

| Status | Meaning |
|---|---|
| `current` | `latest` (`main`) only. |
| `supported` | Fully maintained per [§4](#4-maintaining-older-versions). |
| `deprecated` | Security and correctness fixes only. The switcher shows a warning with the EOL date. |
| `eol` | No longer maintained. The branch is kept read-only for history and the switcher shows an end-of-life banner. |

**Rules**

1. We maintain **at least the two most recent minor versions** as `supported`.
2. When a new minor or major version is cut, a version that falls outside that
   window is **deprecated**:
   ```bash
   python3 scripts/docs_versions.py deprecate 1.0            # EOL defaults to +180 days
   python3 scripts/docs_versions.py deprecate 1.0 --eol 2027-06-30
   ```
3. A deprecated version reaches **end of life 180 days** after deprecation,
   unless the release notes announced a longer window. A new **major** version
   gives the previous major a window of at least 365 days.
4. Deprecations are announced in the release notes, and in the docs themselves
   through the switcher banner.
5. When the EOL date passes, a maintainer runs
   `python3 scripts/docs_versions.py eol <version>`. `eol` branches are never
   deleted, because old links must keep working.
6. The contract-level upgrade and migration docs
   ([contract-upgrade-guide.md](./contract-upgrade-guide.md),
   [user-credentials-migration.md](./user-credentials-migration.md)) on
   `latest` must always explain how to upgrade from **every non-EOL
   version**.

---

## 6. Manifest reference

`docs/versions.json`:

```json
{
  "schema": 1,
  "repository": "https://github.com/QuorumProof/QuorumProof",
  "default": "latest",
  "versions": [
    { "version": "latest", "label": "Latest (main)", "ref": "main",
      "status": "current", "released": null, "deprecated": null, "eol": null },
    { "version": "1.0", "label": "v1.0", "ref": "docs/v1.0",
      "status": "deprecated", "released": "2026-10-01",
      "deprecated": "2027-04-01", "eol": "2027-09-28" }
  ]
}
```

| Field | Description |
|---|---|
| `version` | `latest` or `MAJOR.MINOR`. |
| `label` | Name shown in the version switcher. |
| `ref` | Git ref the docs are read from. |
| `status` | `current`, `supported`, `deprecated` or `eol`. |
| `released` / `deprecated` / `eol` | ISO dates (`YYYY-MM-DD`) or `null`. `eol` is required once a version is deprecated. |

To validate the manifest, run `python3 scripts/docs_versions.py check`.
It checks that exactly one version is `current`, that statuses and dates are
valid, and that every deprecated or EOL version has an EOL date.
