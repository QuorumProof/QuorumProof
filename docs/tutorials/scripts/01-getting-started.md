# Tutorial 1 — Getting Started: Build, Deploy, and Run QuorumProof

| | |
|---|---|
| **Audience** | Contributors and integrators new to the codebase |
| **Prerequisites** | Rust (stable) with `wasm32-unknown-unknown`, Stellar CLI, Node.js 20+, Git |
| **Target length** | ~8 minutes |
| **Captions** | [01-getting-started.en.vtt](../captions/01-getting-started.en.vtt) |

**Learning goals** — by the end the viewer can:
1. Explain the three QuorumProof contracts in one sentence each.
2. Build the contracts and run the test suite.
3. Deploy to Stellar testnet with the provided script.
4. Start the API server and hit its health endpoint.

---

### Scene 1 — Introduction (00:00–00:45)

**On screen:** Repository README, scrolling to the "What is QuorumProof?" section.

**Narration**
> Welcome to QuorumProof. In this video we'll go from a fresh clone to a running local stack in about eight minutes. QuorumProof verifies engineering credentials using quorum slices: a university, a licensing body, and past employers co-sign a soulbound token on Stellar. Let's get it running.

### Scene 2 — The three contracts (00:45–01:45)

**On screen:** `ls contracts/`, then briefly open `docs/architecture.md`.

**Narration**
> The project has three core Soroban contracts. quorum_proof holds credentials, quorum slices, and attestations. sbt_registry mints the non-transferable soulbound tokens. zk_verifier checks zero-knowledge proofs so holders can prove a claim without revealing the whole credential. The architecture doc explains how they fit together.

### Scene 3 — Build and test (01:45–03:30)

**On screen:**
```bash
git clone https://github.com/QuorumProof/QuorumProof.git
cd QuorumProof
rustup target add wasm32-unknown-unknown
./scripts/build.sh
cargo test
```

**Narration**
> Clone the repository and add the WebAssembly target. The build script compiles every contract to WASM. Then run cargo test. The first build takes a few minutes; after that it's incremental. All tests should pass before you change anything.

### Scene 4 — Configure a testnet identity (03:30–04:30)

**On screen:**
```bash
stellar keys generate deployer --network testnet
stellar keys address deployer
```

**Narration**
> Next, create a testnet identity called deployer. The Stellar CLI generates a key and funds it from Friendbot. Never reuse this key on mainnet, and never paste a secret key into a terminal you're recording.

### Scene 5 — Deploy to testnet (04:30–06:00)

**On screen:**
```bash
./scripts/deploy_testnet.sh
```
Highlight the printed contract IDs.

**Narration**
> Now deploy. The script uploads each contract, initializes it, and wires them together. At the end it prints the contract IDs. Copy them; the API server needs them in its environment file.

### Scene 6 — Run the API server (06:00–07:30)

**On screen:**
```bash
cp .env.example .env   # paste CONTRACT_* IDs
cd api-server
npm install
npm run dev
curl http://localhost:3000/health
```

**Narration**
> Copy the example environment file at the repository root and paste in the contract IDs. Then move into the api-server folder, install dependencies, and start the dev server. Finally, call the health endpoint. A healthy status means the server can reach the database and the Soroban RPC.

### Scene 7 — Recap (07:30–08:00)

**On screen:** Tutorial index (`docs/video-tutorials.md`).

**Narration**
> That's it. You built the contracts, deployed them to testnet, and started the API. In the next video we'll create your first quorum slice.

---

## Recap

- Three contracts: `quorum_proof`, `sbt_registry`, `zk_verifier`.
- `./scripts/build.sh` then `cargo test` before any change.
- `./scripts/deploy_testnet.sh` deploys and prints contract IDs.
- `GET /health` confirms the API server is wired up.

## Links

- [README](../../../README.md)
- [architecture.md](../../architecture.md)
- [deployment-guide.md](../../deployment-guide.md)
- [troubleshooting-guide.md](../../troubleshooting-guide.md)
