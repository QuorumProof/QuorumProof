# Git Workflow

This guide standardizes how changes move from a local branch into `main`. It
covers the branching strategy, pull request guidelines, commit message
conventions, and the merge strategy. Follow it for every change, including
documentation-only changes.

For the regression-test and code-style rules that apply to the code itself,
see [`CONTRIBUTING.md`](../CONTRIBUTING.md).

---

## Table of Contents

- [Branching strategy](#branching-strategy)
- [Working on a change](#working-on-a-change)
- [Commit message conventions](#commit-message-conventions)
- [Pull request guidelines](#pull-request-guidelines)
- [Merge strategy](#merge-strategy)
- [Keeping a branch up to date](#keeping-a-branch-up-to-date)
- [Release and docs version branches](#release-and-docs-version-branches)
- [Quick reference](#quick-reference)

---

## Branching strategy

`main` is the only long-lived branch and is always expected to be green. Every
change lands on `main` through a pull request. Nobody commits directly to
`main`.

| Branch | Purpose | Lifetime |
|---|---|---|
| `main` | Latest, deployable state. Source of `docs/` "latest". | Permanent |
| `feat/<short-description>` | New functionality | Until merged |
| `fix/<short-description>` | Bug fixes | Until merged |
| `docs/<short-description>` | Documentation-only changes | Until merged |
| `chore/<short-description>` | Tooling, CI, dependency bumps | Until merged |
| `docs/vMAJOR.MINOR` | Documentation maintenance branch for a released line | Permanent (see [documentation-versioning.md](./documentation-versioning.md)) |

Naming rules:

- Use lowercase words separated by hyphens.
- Put the issue number in the name when one exists, for example
  `fix/issue-1362-attestation-duplicate-guard`.
- When a single branch closes several issues, list the numbers, for example
  `feat/issues-1675-1676-1677-1678`.

Branch from the latest `main`:

```bash
git switch main
git pull --ff-only origin main
git switch -c feat/issue-1675-git-workflow-docs
```

---

## Working on a change

1. **Open or find an issue first** for any non-trivial work, so effort is not
   duplicated (see [`CONTRIBUTING.md`](../CONTRIBUTING.md)).
2. **Branch from `main`** using the naming rules above.
3. **Make small, focused commits.** One logical change per commit makes review
   and bisecting easier.
4. **Run the checks that CI runs** for the paths you touched before pushing.
   The most common ones are:

   | Touched path | Local command |
   |---|---|
   | `contracts/**` | `./scripts/test.sh` and `./scripts/check_unwraps.sh` |
   | `api-server/**` | `cd api-server && npm test` |
   | `docs/**` | `./scripts/check_docs_index.sh` |
   | `docs/versions.json` | `python3 scripts/docs_versions.py check` |

5. **Push the branch** and open a pull request against `main`.

---

## Commit message conventions

Commits use the [Conventional Commits](https://www.conventionalcommits.org/)
format:

```
<type>(<optional scope>): <short summary>

<optional body explaining why, wrapped at ~72 columns>

<optional footer, e.g. Closes #1675>
```

**Types** used in this repository:

| Type | Use for |
|---|---|
| `feat` | A new feature |
| `fix` | A bug fix |
| `docs` | Documentation only |
| `test` | Adding or correcting tests |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `perf` | Performance improvement |
| `ci` | CI workflow changes |
| `chore` | Tooling, dependency bumps, housekeeping |

**Rules:**

- Keep the summary under 72 characters, in the imperative mood
  (`add`, not `added`).
- Do not end the summary with a period.
- Use the scope to name the area, for example `docs(snippets): ...` or
  `feat(api-server): ...`.
- Reference the issue in the footer (`Refs #1676`, or `Closes #1676` on the
  commit that fully resolves it).
- Explain *why* in the body when the reason is not obvious from the diff.

Good example:

```
docs: add git workflow guide

Standardize branching, PR, commit, and merge conventions so contributors
do not have to infer them from history. Refs #1675
```

---

## Pull request guidelines

- **Title:** under 70 characters, same conventions as commit summaries.
- **Description:** explain what changed and why. Link the issue(s) with
  `Closes #N` so they close automatically on merge.
- **Size:** keep a PR to one reviewable concern. If it grows past a few hundred
  changed lines of hand-written code, consider splitting it.
- **Draft PRs:** open a draft while work is in progress. Mark it ready only
  when CI is green locally and the description is complete.
- **Checks:** every required CI job must pass before merge. Do not merge with
  a failing job, and do not disable a check to get a PR through. If a check is
  wrong, fix the check in its own PR.
- **Review:** at least one approving review is required. Address every
  comment, either with a change or a reply explaining why not.
- **Scope of a PR that closes several issues:** when one PR closes multiple
  issues, list each issue in the description with a `Closes #N` line and state
  briefly what each commit does.

---

## Merge strategy

- **Squash and merge** is the default for feature and fix branches. It keeps
  `main` history to one commit per change. The squashed commit message should
  follow the conventions above.
- **Rebase and merge** is acceptable when the branch has a short series of
  commits that each pass CI and are worth keeping individually.
- **Merge commits** are not used, to keep `main` history linear.
- Delete the source branch after merge.

---

## Keeping a branch up to date

Rebase onto `main` rather than merging `main` into the branch:

```bash
git fetch origin
git rebase origin/main
# resolve conflicts, then:
git push --force-with-lease
```

Use `--force-with-lease`, never `--force`, so you do not overwrite commits you
have not seen. Rewriting history is only acceptable on your own branch before
review is complete.

---

## Release and docs version branches

Release lines get a `docs/vMAJOR.MINOR` branch cut from the release commit so
older documentation stays readable. These branches are maintained with
backports only. The full policy, including how to cut and deprecate a version,
is in [documentation-versioning.md](./documentation-versioning.md) and is
managed by `scripts/docs_versions.py`.

---

## Quick reference

```bash
# Start a change
git switch main && git pull --ff-only origin main
git switch -c feat/issue-NNNN-short-description

# Commit
git add <files>
git commit -m "feat(scope): short imperative summary" -m "Body. Refs #NNNN"

# Publish and open a PR
git push -u origin HEAD
gh pr create --base main --title "..." --body "Closes #NNNN"

# Catch up with main
git fetch origin && git rebase origin/main
git push --force-with-lease
```
