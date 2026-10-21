# Development Hot Reload

This guide covers how to iterate quickly on the API server and the Soroban
contracts without restarting services by hand (issue #1676).

| Component | Command | What triggers a reload |
|---|---|---|
| API server | `npm run dev` (in `api-server/`) | Any change under `api-server/src/` (tsx watch) |
| Contracts | `./scripts/dev-watch-contracts.sh` | Any change to `contracts/**/*.rs` or `Cargo.toml` (rebuilds WASM) |
| Development config | `api-server/.env.development.example` | Copied and sourced once per shell |

---

## API server

`npm run dev` runs `tsx watch` on `src/index.ts`. When a file changes, tsx
stops the running process and starts a new one. Restarts are full process
restarts, so in-memory state (rate-limit counters, WebSocket connections,
caches) is reset on each reload.

```bash
cd api-server
npm ci                 # first time only
npm run dev            # watch mode (hot restart on save)
npm run dev:once       # single run, no watching (e.g. to reproduce a clean start)
```

Notes:

- `dev` clears nothing between restarts (`--clear-screen=false`), so earlier
  logs stay visible while you debug.
- Only `src/` is watched by default. After changing `.env` values, restart
  the command by hand: values are read from the environment at start.
- The API server does not read `.env` files. Export the values first (see
  [Development configuration](#development-configuration)).

---

## Contracts

The contracts are WebAssembly and cannot be hot-swapped into a running
network. The watcher's job is to keep the local build current, so that a
redeploy or a local test run uses the latest code.

```bash
./scripts/dev-watch-contracts.sh
```

The script:

1. Fingerprints every `*.rs` and `Cargo.toml` under `contracts/` (build output
   under `target/` is excluded).
2. When the fingerprint changes, runs
   `cargo build --target wasm32-unknown-unknown -p quorum_proof`.
3. Keeps running after a failed build, so the next save can fix it.

### Options

| Variable | Default | Effect |
|---|---|---|
| `CONTRACT_PACKAGES` | `quorum_proof` | Space-separated packages to build, e.g. `"quorum_proof sbt_registry zk_verifier"` |
| `WATCH_PROFILE` | `dev` | `release` uses `--release` and matches the artifacts CI and deploy scripts produce |
| `WATCH_INTERVAL` | `2` | Polling interval in seconds (polling mode only) |

If [`cargo-watch`](https://crates.io/crates/cargo-watch) is installed, the
script uses it instead of polling:

```bash
cargo install --locked cargo-watch
```

### Before you deploy

Debug builds are for iteration only. Run a release build before deploying:

```bash
WATCH_PROFILE=release CONTRACT_PACKAGES="quorum_proof sbt_registry zk_verifier" \
  ./scripts/dev-watch-contracts.sh
```

The release build applies `wasm-opt`, so debug and release artifacts differ in
size and should not be compared directly.

---

## Development configuration

`api-server/.env.development.example` holds local-only values: a development
`NODE_ENV`, a local port, testnet RPC, and placeholder HMAC secrets. Use it
like this:

```bash
cp api-server/.env.development.example api-server/.env.development
set -a; source api-server/.env.development; set +a
cd api-server && npm run dev
```

Rules for this file:

- The `dev-only-*` secrets are placeholders. Do not reuse them outside
  development.
- Never commit a filled-in `.env.development`. The root `.gitignore` covers
  `.env` files; check `git status` before committing.
- After `scripts/deploy_testnet.sh` writes contract IDs to `.env`, copy the
  `CONTRACT_*` values into your `.env.development`.

---

## Troubleshooting

- **The API server restarts in a loop.** Usually a startup error. Run
  `npm run dev:once` to see the first failure without the watch loop.
- **Contract changes are not picked up.** Confirm the file is under
  `contracts/` and is `.rs` or `Cargo.toml`. Changes outside those paths are
  not watched.
- **No reaction on save inside a container.** Inotify events may not reach
  the container. Polling mode is the default fallback; if `cargo-watch` is
  installed, it may need a bind mount that supports file events.
- **Build fails on wasm target.** Install the target:
  `rustup target add wasm32-unknown-unknown`.
