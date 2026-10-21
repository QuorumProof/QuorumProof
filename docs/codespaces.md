# GitHub Codespaces

QuorumProof ships a [dev container](../.devcontainer/devcontainer.json) so you can develop
in GitHub Codespaces or any VS Code / JetBrains dev-container environment without installing
Rust, Node, or Docker locally. This is the fastest way to get a working environment for
review or a first contribution.

## Starting a Codespace

1. Open the repository on GitHub and choose **Code → Codespaces → Create codespace on main**.
2. Wait for the container to build. The `postCreateCommand` runs
   [`.devcontainer/post-create.sh`](../.devcontainer/post-create.sh), which:
   - adds the `wasm32-unknown-unknown` Rust target,
   - runs `npm ci` in `api-server/`, `frontend/`, and `dashboard/`,
   - installs the pre-commit hooks (see [pre-commit hooks](pre-commit.md)).
3. Once the container is ready, a `Dashboard` / `Frontend` / `API server` port list appears in
   the **Ports** panel.

## What is included

| Tool | Version | Source |
|------|---------|--------|
| Rust (stable) + `wasm32-unknown-unknown` | stable | `ghcr.io/devcontainers/features/rust` |
| Node.js | 20 | `ghcr.io/devcontainers/features/node` |
| Python | 3.11 | `ghcr.io/devcontainers/features/python` |
| Docker (Docker-in-Docker) | latest | `ghcr.io/devcontainers/features/docker-in-docker` |

Forwarded ports: `3000` (API server), `5173` (frontend), `5174` (dashboard).

## Running the services

```bash
# API server (port 3000)
cd api-server && npm run dev

# Frontend (port 5173)
cd frontend && npm run dev

# Dashboard (port 5173 by default; Vite moves to 5174 if the frontend is already running)
cd dashboard && npm run dev
```

Contract builds and tests use the same commands as CI:

```bash
cargo build --release --target wasm32-unknown-unknown -p quorum_proof
cargo test --lib --workspace
```

For the full local setup (Soroban CLI, standalone network, `.env`), run
`./scripts/setup_dev.sh --skip-docker` inside the Codespace terminal. See
[local-dev-setup.md](local-dev-setup.md).

## Secrets

Do not commit tokens. Add them as Codespaces secrets (**Settings → Codespaces → Secrets**) and
they will be exposed as environment variables in new Codespaces. Copy `.env.example` to `.env`
and fill in values that are not secrets.

## Testing the Codespaces workflow

Verify the configuration after changing it:

1. Create a fresh Codespace from the branch you changed (not from `main`).
2. Confirm the post-create log ends with `Done.` and no `ERROR` lines.
3. Run `rustup target list --installed` and confirm `wasm32-unknown-unknown` is listed.
4. Run `npm run lint` in `frontend/` and `dashboard/`.
5. Start the API server and confirm the forwarded port `3000` returns a response.

## Troubleshooting

- **Post-create failed on `npm ci`**: the lockfile is out of sync with `package.json`. Run
  `npm install` locally, commit the lockfile, then rebuild the container
  (**Command Palette → Codespaces: Rebuild Container**).
- **Docker commands fail**: Docker-in-Docker starts on first use; wait a few seconds and retry.
- **Port already in use**: stop the other dev server, or set `PORT` for the API server.
