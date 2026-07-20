# Cross-Chain Bridge Trust Model (Issue #880 hardening)

This document is the single place to check "what does the bridge actually
verify, and what does it still have to trust?" Read it before relying on
`verified: true` on a `CrossChainAnchor`, and update it if the verification
path changes.

## What changed

Before this hardening pass, `crossChainBridge.ts` computed its proof
commitment as `HMAC-SHA256(BRIDGE_HMAC_SECRET, chainId:txHash:eventData)`,
using a hardcoded default secret (`'quorumproof-bridge'`) whenever the env
var wasn't set — which it typically wasn't. Anyone who knew or leaked that
secret could produce a "valid" commitment for a foreign-chain event that
never happened. Worse, the `/anchors/:id/verify` endpoint didn't check the
commitment at all — it just required a Stellar `admin` address string and
unconditionally called `verify_chain_anchor`. The cross-chain guarantee had
no real dependency on foreign-chain state.

## What's verified now

An anchor can only become `verified: true` via
`verifyAnchorReceiptProof()` (`src/services/crossChainBridge.ts`), which
requires, in order:

1. **A checkpointed header** for the anchor's `(chainId, blockHash)`
   (`src/services/blockHeaderStore.ts`). Checkpointing itself verifies:
   - **Self-consistency**: the claimed block hash is recomputed from the
     full RLP-encoded header via `@ethereumjs/block` and must match exactly.
   - **Finality**: the header was fetched via the chain's `finalized`/`safe`
     RPC tag, or is at least `MIN_CONFIRMATIONS[chainId]` blocks deep.
   - **Non-conflicting**: a later checkpoint can't silently replace an
     already-checkpointed header at the same height with a different hash.
2. **A Merkle-Patricia receipt-inclusion proof** (`src/services/mptProof.ts`)
   verifying the claimed receipt was genuinely included at the claimed
   transaction index under that header's `receiptsRoot`, and that the
   claimed receipt fields (status, logs, etc.) match what the proof actually
   commits to — not just that *some* proof verifies.
3. **ABI-based log decoding** (`src/services/ethAbi.ts`) against the pinned,
   version-controlled ABI in `src/abi/credentialBridgeEvents.ts` — replacing
   env-var topic matching, which silently degraded to `Unknown` on a typo or
   unset var.
4. **Cross-checks** that the decoded event's `credentialId` and the log's
   emitting contract address match what was registered for the anchor.

Anchor and checkpointed-header state is durable (`bridgeStore.ts`,
`blockHeaderStore.ts` — both backed by the fsync'd JSONL `DurableLog` used
elsewhere in this service), not in-memory, so `verified` status and pending
registrations survive a process restart.

## The trust assumption that remains

**We trust the RPC endpoint(s) the relay is connected to to honestly report
which block is canonical/finalized at a given height.**

This module does not implement a full light client: no proof-of-work
difficulty-chain verification, no PoS sync-committee/attestation
verification, no independent determination of "chain of most work." A
relay (or its upstream RPC provider) that is malicious or compromised could
feed the service a self-consistent, internally-valid header for a block
that never became canonical, and nothing here would catch that.

This is narrower and qualitatively different from the old model: previously
the entire guarantee reduced to "does this one HMAC secret leak?", with zero
dependency on real chain state. Now, forging an anchor requires convincing
an honestly-run verification path that a specific, real RPC view of
finalized/canonical chain state is correct — the same trust model most
production bridges that don't run a full light client operate under
(optimistic/attested bridges, oracle-fed bridges, etc.).

Mitigating this further would mean either: cross-checking multiple
independent RPC providers before checkpointing (an operational
relay-diversity concern, not something one service instance can verify
offline), or implementing a real light client (BLS sync-committee
verification for post-Merge Ethereum; a PoW/validator-set client for other
chains) — out of scope here.

## Known limitation: per-chain header RLP schema

Header self-consistency requires knowing exactly which fields a chain's
header RLP includes, which is hardfork/consensus-specific
(`src/services/evmChainConfig.ts`):

- **Ethereum Mainnet / Sepolia**: uses the real, actively-maintained
  hardfork-by-(block number, timestamp) schedule from `@ethereumjs/common`.
  This stays correct as new hardforks activate, with no code change here.
- **Polygon PoS, Goerli, Mumbai**: not tracked chains in
  `@ethereumjs/common`, and Polygon's PoA (Clique-derived) consensus
  produces headers Ethereum's client-side format validation would reject.
  These are pinned to a **fixed, hand-picked hardfork shape** (`london` —
  has `baseFeePerGas`, no beacon-chain fields), which is a best-effort
  approximation, not a real schedule. If the target chain's header format
  changes, checkpointing fails closed (hash mismatch) rather than silently
  computing a wrong hash — but `evmChainConfig.ts` needs a manual update
  when that happens.
