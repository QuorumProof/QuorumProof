/**
 * Issue #880 — Cross-Chain Interoperability Bridge Service
 *
 * Architecture:
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  External chain (Ethereum / Polygon)                         │
 *   │  CredentialIssued / CredentialRevoked events on-chain        │
 *   └───────────────────┬──────────────────────────────────────────┘
 *                       │  off-chain relay (ethers.js / REST)
 *                       ▼
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  CrossChainBridgeService (this module)                       │
 *   │   1. register: relay submits a foreign-chain event reference │
 *   │      -> prepareAnchor() -> register_chain_anchor() (pending) │
 *   │   2. checkpoint: relay submits a finalized block header      │
 *   │      -> blockHeaderStore verifies self-consistency+finality  │
 *   │   3. verify: relay submits a Merkle-Patricia receipt proof   │
 *   │      for the event, checked against the checkpointed header  │
 *   │      -> verify_chain_anchor() only on successful proof       │
 *   └──────────────────────────────────────────────────────────────┘
 *                       │
 *                       ▼
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  QuorumProof Soroban Contract                                │
 *   │  CrossChainAnchor stored on-chain                            │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Supported chains (by EIP-155 chain_id):
 *   1   – Ethereum Mainnet
 *   5   – Ethereum Goerli (testnet, deprecated)
 *   11155111 – Ethereum Sepolia (testnet)
 *   137 – Polygon Mainnet
 *   80001 – Polygon Mumbai (testnet, deprecated)
 *
 * NOTE: This service performs simulation-only calls against the Soroban
 * contract (read path).  Write operations (register / verify anchor) are
 * prepared here as signed transaction envelopes and must be submitted by
 * a funded Stellar account with the Admin role.  In a production setup,
 * this service holds an HSM-backed keypair for that account.
 *
 * TRUST MODEL: step 3 (`verifyAnchorReceiptProof`) is what makes an anchor
 * `verified`, and it is backed by cryptographic MPT proof verification
 * against a self-consistency-checked, finality-gated header — see
 * `blockHeaderStore.ts` for the three available finality modes and their
 * precise trust assumptions. For Ethereum mainnet/Sepolia, checkpointing a
 * header via `{ mode: 'light-client' }` verifies real BLS sync-committee
 * finality (`beaconLightClient.ts`) instead of trusting the relay's RPC —
 * see that module for how to bootstrap and feed it updates. This replaces a
 * prior design where `verified` could be set from an HMAC keyed by a single
 * shared secret (`BRIDGE_HMAC_SECRET`) with no dependency on real chain
 * state at all.
 */
import {
  ProofType,
  getDefaultBridgeStore,
  type AnchorRecord,
  type ForeignChainEvent,
  type BridgeStore,
} from './bridgeStore.js';
import { SUPPORTED_CHAINS } from './evmChainConfig.js';
import {
  getDefaultBlockHeaderStore,
  HeaderVerificationError,
  type BlockHeaderStore,
  type CheckpointHeaderInput,
  type CheckpointedHeader,
} from './blockHeaderStore.js';
import { verifyReceiptProof, ReceiptProofError, type ReceiptProof } from './mptProof.js';
import {
  getDefaultBeaconLightClientStore,
  LightClientError,
  type BeaconLightClientStore,
  type LightClientBootstrap,
  type LightClientUpdate,
  type LightClientHeader,
} from './beaconLightClient.js';
import { decodeCredentialLog, UnrecognizedLogError, type DecodedCredentialEvent } from './ethAbi.js';
import { createHash } from 'crypto';

export { SUPPORTED_CHAINS, ProofType };
export type { ForeignChainEvent, AnchorRecord };
export { HeaderVerificationError, ReceiptProofError, UnrecognizedLogError };
export type { CheckpointHeaderInput, CheckpointedHeader, ReceiptProof, DecodedCredentialEvent };

export interface AnchorRequest {
  /** Local QuorumProof credential ID */
  credentialId: number;
  foreignEvent: ForeignChainEvent;
  proofType?: ProofType;
}

export class AnchorVerificationError extends Error {}

// ---------------------------------------------------------------------------
// Non-security content digest (dedup / display only)
// ---------------------------------------------------------------------------

/**
 * A plain content digest for the anchor, used only for logging/display and
 * as the `proof_hash` bytes forwarded to `register_chain_anchor` (which
 * expects some fixed-size commitment). This is NOT a security mechanism —
 * anyone can compute it, and it proves nothing about whether the event
 * actually happened on the foreign chain. The actual proof-of-occurrence is
 * `verifyAnchorReceiptProof()`, checked against a cryptographically
 * verified receipt trie inclusion proof before an anchor is ever marked
 * `verified`.
 */
export function computeProofHash(event: ForeignChainEvent): Buffer {
  return createHash('sha256')
    .update(`${event.chainId}:${event.txHash}:${event.blockHash}:${event.contractAddress}`)
    .digest();
}

// ---------------------------------------------------------------------------
// Core bridge operations
// ---------------------------------------------------------------------------

function chainName(chainId: number): string {
  const name = SUPPORTED_CHAINS[chainId];
  if (!name) throw new Error(`Unsupported chain ID: ${chainId}`);
  return name;
}

/**
 * Prepare an anchor record from a foreign-chain event reference. This does
 * NOT establish that the event happened — it's an unauthenticated claim
 * from the relay, recorded so a subsequent `verifyAnchorReceiptProof` call
 * can be matched against it. It also does NOT call the Stellar contract;
 * the API route forwards the result to `register_chain_anchor`.
 */
export function prepareAnchor(req: AnchorRequest, store: BridgeStore = getDefaultBridgeStore()): AnchorRecord {
  const name = chainName(req.foreignEvent.chainId); // throws if unsupported

  const proofType = req.proofType ?? ProofType.HashOnly;
  const proofHash = computeProofHash(req.foreignEvent).toString('hex');
  const txHash = req.foreignEvent.txHash.toLowerCase().replace(/^0x/, '');

  return store.prepare({
    credentialId: req.credentialId,
    chainId: req.foreignEvent.chainId,
    chainName: name,
    txHash,
    proofHash,
    proofType,
    anchoredAt: Date.now() / 1000,
    verified: false,
    foreignEvent: { ...req.foreignEvent, txHash },
  });
}

export function confirmAnchor(txHash: string, anchorId: number, store: BridgeStore = getDefaultBridgeStore()): void {
  store.confirm(txHash, anchorId);
}

export interface VerifyAnchorInput {
  anchorId: number;
  logIndexInReceipt: number;
  receiptProof: ReceiptProof;
}

export interface VerifyAnchorResult {
  anchor: AnchorRecord;
  decoded: DecodedCredentialEvent;
  header: CheckpointedHeader;
}

/**
 * Verify an anchor's foreign-chain event via Merkle-Patricia receipt-inclusion
 * proof against a previously checkpointed, finalized block header, then mark
 * the anchor verified. This is the sole path by which `verified` becomes
 * `true` — there is no fallback that trusts a submitted hash/HMAC instead.
 *
 * Throws (never marks verified) if:
 *   - no header has been checkpointed for the anchor's (chainId, blockHash)
 *   - the receipt proof doesn't verify against that header's receiptsRoot
 *   - the claimed log at `logIndexInReceipt` doesn't decode against the
 *     pinned credential-bridge ABI
 *   - the decoded event doesn't match the anchor's registered credentialId
 *     or the log's emitting contract doesn't match the registered contract
 */
export async function verifyAnchorReceiptProof(
  input: VerifyAnchorInput,
  bridgeStore: BridgeStore = getDefaultBridgeStore(),
  headerStore: BlockHeaderStore = getDefaultBlockHeaderStore(),
): Promise<VerifyAnchorResult> {
  const anchor = bridgeStore.getById(input.anchorId);
  if (!anchor) throw new AnchorVerificationError(`Unknown anchor ${input.anchorId}`);

  const header = headerStore.getByHash(anchor.chainId, anchor.foreignEvent.blockHash);
  if (!header) {
    throw new AnchorVerificationError(
      `No checkpointed header for chain ${anchor.chainId} block ${anchor.foreignEvent.blockHash}. ` +
        `Checkpoint the block header before verifying anchors against it.`,
    );
  }
  if (header.blockNumber !== anchor.foreignEvent.blockNumber) {
    throw new AnchorVerificationError('Checkpointed header block number does not match the anchor\'s registered block number');
  }

  // Throws ReceiptProofError on any mismatch — including a caller supplying
  // claim fields that don't match what's actually committed in the trie.
  await verifyReceiptProof(header.receiptsRoot, input.receiptProof);

  const log = input.receiptProof.claim.logs[input.logIndexInReceipt];
  if (!log) {
    throw new AnchorVerificationError(`Receipt has no log at index ${input.logIndexInReceipt}`);
  }
  if (log.address.toLowerCase() !== anchor.foreignEvent.contractAddress.toLowerCase()) {
    throw new AnchorVerificationError(
      `Log emitter ${log.address} does not match the anchor's registered contract ${anchor.foreignEvent.contractAddress}`,
    );
  }

  const decoded = decodeCredentialLog(log);
  if (decoded.credentialId !== String(anchor.credentialId)) {
    throw new AnchorVerificationError(
      `Decoded credentialId ${decoded.credentialId} does not match anchor's registered credentialId ${anchor.credentialId}`,
    );
  }

  bridgeStore.markVerified(input.anchorId);
  return { anchor: { ...anchor, verified: true }, decoded, header };
}

// ---------------------------------------------------------------------------
// Query helpers (used by API routes)
// ---------------------------------------------------------------------------

export function getPendingAnchors(store: BridgeStore = getDefaultBridgeStore()): AnchorRecord[] {
  return store.getPending();
}

export function getAnchorByTxHash(txHash: string, store: BridgeStore = getDefaultBridgeStore()): AnchorRecord | undefined {
  return store.getByTxHash(txHash);
}

export function getAnchorById(anchorId: number, store: BridgeStore = getDefaultBridgeStore()): AnchorRecord | undefined {
  return store.getById(anchorId);
}

export function getAllAnchors(store: BridgeStore = getDefaultBridgeStore()): AnchorRecord[] {
  return store.getAll();
}

export function getSupportedChains() {
  return Object.entries(SUPPORTED_CHAINS).map(([id, name]) => ({
    chain_id: parseInt(id, 10),
    name,
  }));
}

// ---------------------------------------------------------------------------
// Block header checkpointing (thin re-export for route convenience)
// ---------------------------------------------------------------------------

export function checkpointHeader(
  input: CheckpointHeaderInput,
  store: BlockHeaderStore = getDefaultBlockHeaderStore(),
): CheckpointedHeader {
  return store.checkpoint(input);
}

// ---------------------------------------------------------------------------
// Beacon-chain light client (thin re-export for route convenience — see
// beaconLightClient.ts for the actual BLS sync-committee verification)
// ---------------------------------------------------------------------------

export { LightClientError, getDefaultBeaconLightClientStore };
export type { LightClientBootstrap, LightClientUpdate };

export function bootstrapLightClient(
  chainId: number,
  trustedBlockRoot: Uint8Array,
  bootstrap: LightClientBootstrap,
  store: BeaconLightClientStore = getDefaultBeaconLightClientStore(),
): void {
  store.bootstrap(chainId, trustedBlockRoot, bootstrap);
}

export function applyLightClientUpdate(
  chainId: number,
  update: LightClientUpdate,
  store: BeaconLightClientStore = getDefaultBeaconLightClientStore(),
): LightClientHeader {
  return store.applyUpdate(chainId, update);
}
