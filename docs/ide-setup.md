# IDE Setup Guide — VS Code for QuorumProof

This guide covers everything you need to get a productive VS Code environment for
QuorumProof — Rust/Soroban contract development, TypeScript API server, and the
React frontend — all in one workspace.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Recommended Extensions](#recommended-extensions)
3. [Opening the Workspace](#opening-the-workspace)
4. [Debug Configurations](#debug-configurations)
5. [Tasks](#tasks)
6. [Rust-Analyzer Tips](#rust-analyzer-tips)
7. [Common Issues and Fixes](#common-issues-and-fixes)

---

## Prerequisites

Install the following before opening the project:

| Tool | Minimum Version | Install |
|------|----------------|---------|
| Rust | 1.70 | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| wasm32 target | — | `rustup target add wasm32-unknown-unknown` |
| native debug target | — | `rustup target add x86_64-unknown-linux-gnu` (Linux) or `aarch64-apple-darwin` (macOS Apple Silicon) |
| Soroban CLI | latest | `cargo install --locked stellar-cli --features opt` |
| Node.js | 20 LTS | via [nvm](https://github.com/nvm-sh/nvm) or package manager |
| CodeLLDB | — | installed via VS Code extension marketplace (see below) |

---

## Recommended Extensions

The file `.vscode/extensions.json` lists all recommended extensions. VS Code will
prompt you to install them when you open the workspace. You can also install them
manually from the Extensions panel (`Ctrl+Shift+X` / `⌘⇧X`).

| Extension ID | Purpose |
|---|---|
| `rust-lang.rust-analyzer` | Rust language server: completions, inlay hints, go-to-definition, inline errors |
| `serayuzgur.crates` | Shows latest crate versions in `Cargo.toml` |
| `tamasfe.even-better-toml` | TOML syntax, formatting, and schema validation |
| `vadimcn.vscode-lldb` | Native debugger backend for Rust (CodeLLDB) |
| `ms-vscode.hexeditor` | Inspect WASM binaries in hex |
| `redhat.vscode-yaml` | YAML language support for CI configs, k8s manifests |
| `esbenp.prettier-vscode` | Formatter for TypeScript, JSON, Markdown |
| `dbaeumer.vscode-eslint` | ESLint integration for the API server and frontend |
| `ms-vscode.vscode-typescript-next` | Nightly TypeScript language features |
| `usernamehw.errorlens` | Surfaces errors and warnings inline in the editor |
| `streetsidesoftware.code-spell-checker` | Catches typos in code and documentation |

---

## Opening the Workspace

Open the repository root directly:

```
File → Open Folder → /path/to/QuorumProof
```

VS Code will automatically pick up `.vscode/settings.json`, `.vscode/tasks.json`,
and `.vscode/launch.json`.

---

## Debug Configurations

Debug configurations live in `.vscode/launch.json`. Open the Run & Debug panel
(`Ctrl+Shift+D` / `⌘⇧D`), pick a configuration from the dropdown, and press F5.

### Debug Rust Tests (quorum_proof / sbt_registry / zk_verifier)

These three configurations use **CodeLLDB** (`vadimcn.vscode-lldb`) to compile
and launch the test binary for a specific Soroban contract package.

**Important:** The `cargo.args` in each configuration pass
`--target x86_64-unknown-linux-gnu` (or the equivalent native target for your
machine). Soroban contracts normally compile to `wasm32-unknown-unknown`, but
debuggers cannot attach to WASM — the native target produces a standard ELF/Mach-O
binary that CodeLLDB can instrument. This is the correct approach for unit tests
because Soroban's `soroban-sdk` test utilities work on native targets.

**Steps:**

1. Set a breakpoint anywhere in `contracts/<name>/src/`.
2. Select e.g. "Debug Rust Tests (quorum_proof)" in the Run & Debug panel.
3. Press F5. VS Code compiles the test binary, then pauses at your breakpoint.

**Filtering to a single test:**

The `args` array in the configuration is passed to the compiled test binary.
You can filter by test name:

```json
"args": ["my_test_name"]
```

or to run a specific module:

```json
"args": ["credential_issuance::"]
```

### Debug API Server

Attach to a running API server process that was started with the `--inspect` flag.

1. Start the server in debug mode:
   ```bash
   cd api-server
   node --inspect ./node_modules/.bin/tsx src/index.ts
   # or via the "Start API Server" task — edit it to add --inspect if needed
   ```
2. Select "Debug API Server" in the Run & Debug panel.
3. Press F5. VS Code attaches to port 9229.

The configuration has `"restart": true`, so it reconnects automatically when the
process restarts (e.g. if you use `nodemon` or `tsx --watch`).

### Debug Frontend Tests

Launches Vitest in debug mode so you can step through test code.

1. Select "Debug Frontend Tests".
2. Press F5. Vitest runs with the Node.js debugger enabled.
3. Set breakpoints in `frontend/src/` or `frontend/src/__tests__/`.

---

## Tasks

Tasks are defined in `.vscode/tasks.json` and can be run from:

- **Terminal → Run Task…** menu
- `Ctrl+Shift+P` / `⌘⇧P` → "Tasks: Run Task"
- Keyboard shortcut: `Ctrl+Shift+B` runs the default build task ("Build Contracts")

| Task | What it does |
|---|---|
| **Build Contracts** (default build) | Runs `scripts/build.sh` — compiles all three contracts to `wasm32-unknown-unknown` |
| **Test Contracts** (default test) | Runs `cargo test` across the entire workspace |
| **Deploy to Testnet** | Runs `scripts/deploy_testnet.sh` — deploys contracts to Stellar testnet |
| **Validate Environment** | Runs `scripts/validate_env.sh` — checks that required env vars and tools are present |
| **Start API Server** | `npm run dev` in `api-server/` — starts the TypeScript API server with `tsx` |
| **Start Frontend** | `npm run dev` in `frontend/` — starts the Vite dev server |
| **Run CLI Help** | `./cli/qp --help` — shows available CLI commands (requires CLI binary from issue #1662) |

Rust tasks ("Build Contracts", "Test Contracts") use the `$rustc` problem matcher,
so compiler errors appear in VS Code's Problems panel and you can navigate to them
with a click.

---

## Rust-Analyzer Tips

### WASM target awareness

The project's `.cargo/config.toml` sets the default build target to
`wasm32-unknown-unknown`. `.vscode/settings.json` propagates this to
rust-analyzer:

```json
"rust-analyzer.cargo.target": "wasm32-unknown-unknown",
"rust-analyzer.cargo.features": "all"
```

This means completions and type-checking reflect the actual WASM build, not a
native build. If you see "target not found" errors on first load, run:

```bash
rustup target add wasm32-unknown-unknown
```

then reload the window (`Ctrl+Shift+P` → "Developer: Reload Window").

### proc-macro support

`rust-analyzer.procMacro.enable` is `true`. The `soroban-sdk` derives
(`#[contractimpl]`, `#[contracttype]`, etc.) are expanded in the editor, giving
accurate completions and hover docs inside contract functions.

### Checking on save

`"rust-analyzer.check.command": "check"` runs `cargo check` on every save, which
is much faster than `cargo build`. Errors appear as squiggles immediately.

### Multiple workspace members

The Cargo workspace has five members (`quorum_proof`, `sbt_registry`, `zk_verifier`,
`integration_tests`, `e2e_tests`). rust-analyzer loads all of them. If you only
want to work on one contract, you can narrow the scope with:

```json
"rust-analyzer.linkedProjects": [
  "contracts/quorum_proof/Cargo.toml"
]
```

Add that to your **user** `settings.json` (not the workspace one) so it doesn't
affect other contributors.

### Inlay hints

Type hints and parameter hints are enabled. Toggle them with `Ctrl+Alt+;` (Linux/Windows)
or `⌃⌥;` (macOS), or via "Rust Analyzer: Toggle Inlay Hints".

---

## Common Issues and Fixes

### "error[E0463]: can't find crate for `std`"

rust-analyzer is trying to check against `wasm32-unknown-unknown` but the target
is not installed.

```bash
rustup target add wasm32-unknown-unknown
```

Reload the window afterwards.

### "proc macro server crashed" / proc-macro expansion fails

```bash
cargo clean
cargo build
```

Then reload the window. This rebuilds the proc-macro crates that rust-analyzer
shells out to.

### CodeLLDB: "Unable to find a suitable build target"

The debug configurations explicitly pass `--target x86_64-unknown-linux-gnu`
(or the equivalent native target). Make sure that target is installed:

```bash
# Linux
rustup target add x86_64-unknown-linux-gnu
# macOS Apple Silicon
rustup target add aarch64-apple-darwin
# macOS Intel
rustup target add x86_64-apple-darwin
```

If you are on a non-Linux host, update the `"args"` in `.vscode/launch.json`
to match your native triple.

### API server debugger won't attach

Make sure the server was started with `--inspect` (or `--inspect-brk` to pause
before the first line). The default `npm run dev` script does not pass `--inspect`;
start it manually or add a separate `dev:debug` npm script:

```json
"dev:debug": "node --inspect ./node_modules/.bin/tsx src/index.ts"
```

Then run "Start API Server" normally and attach.

### rust-analyzer is slow / high CPU

Disable the `contracts/bbs_plus_v1` crate from the workspace if you are not
actively working on it — it's excluded from the Cargo workspace by default
(`exclude` in root `Cargo.toml`) but may still be indexed if you open files
from it. Close those tabs to stop rust-analyzer from analysing it.

### `.env` file not picked up by tasks

Copy the example file and fill in your values:

```bash
cp .env.example .env
```

The "Validate Environment" task will report which variables are missing.

### Spell-checker false positives

Domain-specific words (`soroban`, `groth`, `plonk`, `wasm`, etc.) are already in
the workspace `cSpell.words` list. To add more, open `.vscode/settings.json` and
append to that array.
