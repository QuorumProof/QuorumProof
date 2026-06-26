# ADR-004: Soroban Smart Contract Platform

## Status
Accepted

## Context
QuorumProof needs a smart contract platform to issue, attest, and verify professional credentials on-chain. The platform must support complex credential logic, privacy-preserving verification (ZK proofs), and long-term storage of credential state. It must also be accessible — minimizing gas costs for universities bulk-importing students — and support the Federated Byzantine Agreement (FBA) trust model.

Several smart contract platforms were evaluated for this purpose.

## Problem Statement
Which smart contract platform should QuorumProof use to implement on-chain credential issuance, attestation, revocation, and zero-knowledge verification?

Key requirements:
1. **Low transaction costs**: Universities may issue thousands of credentials; gas costs must be minimal
2. **FBA-native trust model**: The platform must support or align with FBA for quorum-based attestation
3. **WASM-based execution**: Support for modern, efficient smart contract development in Rust
4. **Deterministic execution**: Credential verification must be deterministic and reproducible
5. **Long-term storage**: Credentials persist on-chain for years; storage costs must be predictable
6. **ZK proof verification**: The platform must support efficient on-chain ZK proof verification
7. **Regulatory compliance**: Must support features needed for GDPR and data protection compliance

## Alternatives Considered

### 1. Ethereum (Solidity/EVM)
- **Description**: Deploy contracts on Ethereum mainnet or L2 (Polygon, Arbitrum, Optimism)
- **Pros**:
  - Largest developer ecosystem and tooling
  - Established ZK proof verification libraries
  - Wide wallet support (MetaMask)
  - Mature audit and security practices
- **Cons**:
  - **High gas costs**: Ethereum L1 gas costs make batch issuance prohibitively expensive for universities
  - **L2 fragmentation**: L2 solutions add complexity; credential data may live on different chains
  - **No FBA alignment**: Ethereum uses PoS, not FBA — the trust model is misaligned
  - **EVM limitations**: Solidity's 256-bit EVM is less efficient for the credential data structures needed
  - **Storage costs**: Ethereum's storage model (20k gas per 32-byte slot) makes long-term credential storage expensive
  - **Account model**: Ethereum's account model doesn't natively support the address-based identity QuorumProof needs

### 2. Solana (Rust/Berkeley Packet Filter)
- **Description**: Deploy contracts (programs) on Solana using Rust or C
- **Pros**:
  - Very low transaction costs (~$0.0002 per tx)
  - Fast block times (~400ms)
  - Rust-based development
  - Large ecosystem
- **Cons**:
  - **Not FBA**: Solana uses Proof of History + PoS; no FBA alignment
  - **Account model complexity**: Solana's account rent and data model adds complexity for credential storage
  - **No native ZK support**: ZK verification requires custom BPF programs, which is less mature
  - **Sequential execution model**: Solana's Sealevel parallel execution is powerful but adds complexity for credential attestation workflows
  - **History pruning**: Validators prune old state, which conflicts with long-term credential persistence needs
  - **Downtime history**: Solana has experienced multiple network outages, which is problematic for credential verification

### 3. Stellar Soroban ✓ **CHOSEN**
- **Description**: Deploy contracts on Stellar's Soroban platform using Rust, compiled to WASM
- **Pros**:
  - **FBA-native**: Stellar uses FBA consensus; QuorumProof's trust model aligns perfectly with the underlying network
  - **Low, predictable fees**: Stellar's fee model is minimal and predictable (base fee ~0.00001 XLM), enabling cost-effective batch issuance
  - **Rust + WASM**: Modern, type-safe development with Rust, compiled to WASM for efficient execution
  - **Deterministic**: Soroban execution is fully deterministic, important for credential verification
  - **Address-based identity**: Stellar addresses (G...) serve as natural on-chain identities
  - **Long-term state**: Soroban's storage model supports persistent credential storage with configurable TTL
  - **No front-running**: Stellar's consensus model prevents MEV and front-running, which could compromise credential operations
  - **Regulatory alignment**: Stellar's compliance features (memo requirements, KYC integration) support regulatory needs
  - **Growing ZK ecosystem**: Soroban's WASM runtime can support ZK verification circuits
  - **Soroban-specific design**: The contract model (one contract per functionality) aligns with QuorumProof's modular architecture
- **Cons**:
  - **Younger ecosystem**: Soroban is newer than Ethereum; fewer established tools and libraries
  - **Smaller developer pool**: Fewer Soroban developers available compared to Solidity or Rust+Solana
  - **Limited ZK library maturity**: ZK proof verification on Soroban is emerging, requiring custom implementation
  - **Future Mainnet readiness**: At the time of this decision, Soroban was in early stages of mainnet rollout

### 4. NEAR Protocol (Rust/WASM)
- **Description**: Deploy contracts on NEAR using Rust, compiled to WASM
- **Pros**:
  - WASM-based execution (similar to Soroban)
  - Low transaction costs
  - Nightshade sharding for scalability
- **Cons**:
  - **No FBA**: NEAR uses Nightshade PoS; no FBA alignment
  - **Storage staking**: NEAR requires staking NEAR tokens for storage, adding cost for credential storage
  - **Smaller ecosystem**: Smaller than Ethereum or Solana
  - **Data model mismatch**: NEAR's account-based data model is less suited for credential indexing

### 5. Polkadot (Ink!/WASM)
- **Description**: Deploy on Polkadot parachains using Ink! and WASM
- **Pros**:
  - WASM-based execution
  - Shared security model
  - Cross-chain interoperability (XCM)
- **Cons**:
  - **Parachain slot auctions**: Expensive and time-limited parachain slots
  - **Complexity**: Polkadot's architecture adds significant complexity
  - **No FBA alignment**: Uses Nominated PoS
  - **Ink! maturity**: Ink! is less mature than Soroban's Rust SDK

## Decision
**Build QuorumProof on Stellar Soroban**, using Rust smart contracts compiled to WASM.

### Architecture
1. **Smart contracts**: Deployed as Soroban WASM contracts on Stellar
2. **Core contract**: `QuorumProofContract` — credential issuance, attestation, slices, revocation
3. **SBT registry**: `SbtRegistryContract` — soulbound token non-transferability enforcement
4. **ZK verifier**: `ZkVerifierContract` — Groth16 and PLONK proof verification
5. **API layer**: TypeScript/Express server that wraps Soroban contract calls via `@stellar/stellar-sdk`

## Rationale

1. **FBA Alignment**: QuorumProof's trust model is Federated Byzantine Agreement — the same consensus model Stellar uses. Building on Soroban means the underlying blockchain's trust model matches the application's trust model, eliminating conceptual mismatches present in PoW/PoS alternatives.

2. **Cost-Effective Bulk Operations**: Soroban's predictable, minimal fee model enables the batch issuance use case. Universities can issue thousands of credentials without prohibitive gas costs — a key requirement that eliminates Ethereum L1.

3. **Rust + WASM Performance**: Rust's type safety and WASM's efficient execution enable complex credential logic (ZK verification, weighted voting, quorum calculations) without the overhead of EVM or the complexity of Solana's BPF.

4. **Address as Identity**: Stellar addresses serve as natural on-chain identifiers. This aligns with W3C DID standards (did:stellar:...) and eliminates the need for a separate identity layer.

5. **Deterministic Verification**: Credential verification must be reproducible. Soroban's deterministic execution ensures that the same inputs always produce the same verification result, which is critical for audit trails and dispute resolution.

6. **No MEV/Front-Running**: Stellar's FBA consensus prevents miner extractable value and front-running, which could be exploited in credential revocation or attestation workflows.

7. **Modular Contract Architecture**: Soroban's contract model supports the separation of concerns — core credentials, SBT enforcement, and ZK verification as separate contracts that communicate via cross-contract calls.

## Consequences

### Positive
- Perfect alignment between application trust model (FBA) and blockchain consensus (Stellar FBA)
- Low, predictable transaction costs enable educational and high-volume use cases
- Rust + WASM provides excellent performance and safety
- Stellar's regulatory compliance features support enterprise adoption
- No MEV or front-running risks
- Deterministic execution ensures verifiable audit trails
- Address-based identity integrates naturally with W3C DID standards

### Negative
- Smaller developer ecosystem compared to Ethereum; harder to find Soroban developers
- ZK proof verification on Soroban requires custom implementation rather than using established EVM libraries
- At deployment time, Soroban mainnet was still maturing; some features may be emergent
- Limited tooling for Soroban contract debugging and testing compared to EVM tooling
- Migrating to another platform would require rewriting contracts if future needs outgrow Soroban

## Implementation Notes

1. **Contract Structure**: Each major concern is a separate Soroban contract:
   - `quorum_proof`: Core credential logic, slices, attestations, RBAC
   - `sbt_registry`: Soulbound token non-transferability and recovery
   - `zk_verifier`: ZK proof verification (Groth16, PLONK)

2. **Cross-Contract Calls**: Contracts communicate via Soroban's cross-contract call mechanism using `Env::invoke_contract()`.

3. **Storage Model**: Credential data stored in Soroban instance storage with TTL management. High-throughput indexes use separate storage keys to avoid contention.

4. **Fee Budgeting**: Batch operations pre-compute fee requirements using Soroban's `Env::budget()` to avoid out-of-resource errors during multi-credential issuance.

5. **WASM Size Optimization**: Contracts use `#![no_std]`, LTO, and release profile optimizations to minimize WASM binary size within Soroban's deployment limits.

## References
- [Soroban Documentation](https://soroban.stellar.org/docs)
- [Stellar Consensus Protocol](https://www.stellar.org/papers/stellar-consensus-protocol.pdf)
- [Soroban Rust SDK](https://github.com/stellar/soroban-sdk)
- [Stellar Fee Model](https://developers.stellar.org/docs/learn/fees)
- [W3C DID Core Specification](https://www.w3.org/TR/did-core/)
- [ADR-001: FBA Trust Model](adr-001-fba-trust-model.md)
- [ADR-002: SBT Non-Transferability](adr-002-sbt-non-transferability.md)
- [ADR-003: ZK Verification](adr-003-zk-verification.md)
