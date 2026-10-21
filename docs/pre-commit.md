# Pre-commit Hooks

QuorumProof uses [pre-commit](https://pre-commit.com) to catch formatting and lint problems
before they reach a pull request. The hooks are defined in
[`.pre-commit-config.yaml`](../.pre-commit-config.yaml). Catching these locally is faster than
waiting for the CI pipeline, which runs the same checks.

## Setup

Codespaces and the devcontainer install the hooks automatically
(see [codespaces.md](codespaces.md)). Locally:

```bash
pip install pre-commit      # or: pipx install pre-commit
pre-commit install          # installs the git hook
```

Run the hooks against specific files (recommended):

```bash
pre-commit run --files path/to/file.rs path/to/other.ts
```

Run a single hook against specific files:

```bash
pre-commit run cargo-fmt --files contracts/quorum_proof/src/lib.rs
```

> **Warning:** avoid `pre-commit run --all-files`. Several fixers (`trailing-whitespace`,
> `end-of-file-fixer`, `mixed-line-ending`) rewrite files in place, and the repo has existing
> whitespace/EOF issues in many unrelated files, so `--all-files` produces a large unrelated diff.
> Hooks run only on staged files during `git commit`, which is the intended scope.

## Hooks

| Hook | What it checks | Matches CI job |
|------|----------------|----------------|
| `trailing-whitespace` | No trailing spaces on lines | — |
| `end-of-file-fixer` | Files end in exactly one newline | — |
| `check-yaml` / `check-json` / `check-toml` | Config files parse (JSONC `.vscode/`, `.devcontainer/` and `tsconfig*.json` are skipped for `check-json`) | — |
| `check-merge-conflict` | No leftover `<<<<<<<` markers | — |
| `check-added-large-files` | No staged file over 1 MB | — |
| `check-executables-have-shebangs` | Executable scripts start with a shebang | — |
| `mixed-line-ending` | Normalises to LF | — |
| `cargo-fmt` | Rust formatting (`cargo fmt --check`) | `ci.yml` / `contracts` |
| `cargo-check` | Contracts type-check for `wasm32-unknown-unknown` | `ci.yml` / `contracts` |
| `unwrap-ratchet` | No new bare `.unwrap()` in contracts (#1391) | `ci.yml` / `contracts` |
| `eslint-frontend` | ESLint on staged files in `frontend/` | `ci.yml` / `frontend` |
| `eslint-dashboard` | ESLint on staged files in `dashboard/src/` | `ci.yml` / `dashboard` |

The Rust hooks need a Rust toolchain with `rustfmt` and the `wasm32-unknown-unknown` target.
The ESLint hooks need the workspace dependencies installed (`npm ci` in `frontend/` or
`dashboard/`).

## Adding a hook

1. Add the hook to `.pre-commit-config.yaml`. Use `language: system` for tools already
   required by the project, so no extra download is needed.
2. Keep the hook fast: scope it with `files:` / `types:` so it runs only on relevant changes.
3. Run `pre-commit run <hook-id> --all-files` and fix or document any existing failures
   before merging.
4. Add a row to the table above.

## Skipping hooks

Avoid skipping. If a hook is wrong, fix the hook. For a genuine one-off, use:

```bash
SKIP=eslint-frontend git commit -m "..."
```

CI still runs every check, so a skipped failure will block the pull request.

## Troubleshooting

- **`cargo: command not found`**: install Rust with [rustup](https://rustup.rs) or use the
  Codespace, which provides it.
- **`npx: eslint not found`**: run `npm ci` in the workspace the hook names.
- **Hook reformats files and the commit fails**: the hook changed files in place (for example
  `end-of-file-fixer`). Review with `git diff`, `git add` them, and commit again.
