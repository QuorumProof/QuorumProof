# QuorumProof Code Snippet Library

This directory contains reusable code snippets for common development patterns across the QuorumProof ecosystem.

## Supported IDEs & Editors

- **Visual Studio Code / Cursor**: `.vscode/quorumproof.code-snippets` (loaded automatically in workspace) and [`vscode/quorumproof.code-snippets`](./vscode/quorumproof.code-snippets).
- **JetBrains IDEs (RustRover, CLion, WebStorm, IntelliJ)**: [`jetbrains/QuorumProof.xml`](./jetbrains/QuorumProof.xml) (Live Templates).
- **Vim / Neovim**: [`ultisnips/rust.snippets`](./ultisnips/rust.snippets) & [`ultisnips/typescript.snippets`](./ultisnips/typescript.snippets).

## Available Snippets

### Rust & Soroban Smart Contracts

| Prefix | Name | Description |
|---|---|---|
| `qp-contract` | Soroban Contract Boilerplate | Scaffold contract struct, `initialize`, and `contractimpl` |
| `qp-contract-test` | Contract Unit Test | Scaffold test module with mock environment and `mock_all_auths` |
| `qp-error-enum` | Contract Error Enum | `#[contracterror]` enum with error codes |
| `qp-storage-get` | Instance Storage Get | Read instance storage with safe error handling |
| `qp-storage-set` | Persistent Storage Set | Write persistent storage and extend TTL |
| `qp-require-auth` | Require Authentication | Caller authentication check |
| `qp-event-publish` | Publish Event | Emit typed Soroban event with topics |
| `qp-quorum-slice` | Quorum Slice Validation | Validate attestor weights against threshold |
| `qp-zk-verify` | ZK Proof Verification | Invoke ZK verifier contract |

### TypeScript & Client SDK

| Prefix | Name | Description |
|---|---|---|
| `qp-invoke-contract` | Contract Invocation | Build and submit Soroban contract call with Stellar SDK |
| `qp-verify-credential` | Credential Verification | Check expiration, signature, and revocation |
| `qp-ws-subscribe` | WebSocket Event Stream | Subscribe to live event stream with reconnection logic |

For complete documentation on installation, configuration, and workflows, see [`docs/code-snippets.md`](../docs/code-snippets.md).
