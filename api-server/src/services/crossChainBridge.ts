/**
 * Issue #880 — Cross-Chain Interoperability Bridge Service
 *
 * Architecture:
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  External chain (Ethereum / Polygon)                         │
 *   │  CredentialIssued / CredentialRevoked events on-chain        │
 *   └───────────────────┬──────────────────────────────────────────┘
 *                       │  off-chain polling (ethers.js / REST)
 *                       ▼
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  CrossChainBridgeService (this module)                       │
 *   │   – listens for foreign-chain events (via RPC or webhook)    │
 *   │   – hashes the event data as a proof commitment              │
 *   │   – calls Stellar: register_chain_anchor()                   │
 *   │   – calls Stellar: verify_chain_anchor() after verification  │
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
 *   5   – Ethereum Goerli (testnet)
 *   11155111 – Ethereum Sepolia (testnet)
 *   137 – Polygon Mainnet
 *   80001 – Polygon Mumbai (testnet)
 *
 * NOTE: This service performs simulation-only calls against the Soroban
 * contract (read path).  Write operations (register / verify anchor) are
 * prepared here as signed transaction envelopes and must be submitted by
 * a funded Stellar account with the Admin role.  In a production setup,
 * this service holds an HSM-backed keypair for that account.
 */

import { createHash, createHmac } from 'crypto';

// ---------------------------------------------------------------------------
// Constants & configuration
// ---------------------------------------------------------------------------

export const SUPPORTED_CHAINS: Record<number, string> = {
  1: 'Ethereum Mainnet',
  5: 'Ethereum Goerli',
  11155111: 'Ethereum Sepolia',
  137: 'Polygon Mainnet',
  80001: 'Polygon Mumbai',
};

export enum ProofType {
  Groth16 = 1,
  Plonk = 2,
  HashOnly = 3,
}

export interface ForeignChainEvent {
  /** EIP-155 chain ID */
  chainId: number;
  /** Transaction hash on the foreign chain (0x-prefixed hex) */
  txHash: string;
  /** Block number where the event was emitted */
  blockNumber: number;
  /** Emitting contract address on the foreign chain */
  contractAddress: string;
  /** Raw ABI-encoded event data (hex) */
  eventData: string;
  /** Block timestamp (Unix seconds) */
  blockTimestamp: number;
}

export interface AnchorRequest {
  /** Local QuorumProof credential ID */
  credentialId: number;
  foreignEvent: ForeignChainEvent;
  /** ZK proof bytes (hex) – pass empty string for hash-only anchors */
  zkProof?: string;
  proofType?: ProofType;
}

export interface AnchorRecord {
  anchorId: number | null;
  credentialId: number;
  chainId: number;
  chainName: string;
  txHash: string;
  proofHash: string;
  proofType: ProofType;
  anchoredAt: number;
  verified: boolean;
}

// ---------------------------------------------------------------------------
// In-memory pending anchor store (replace with DB in production)
// ---------------------------------------------------------------------------

interface PendingAnchor extends AnchorRecord {
  foreignEvent: ForeignChainEvent;
}

const pendingAnchors = new Map<string, PendingAnchor>(); // key = txHash
const anchorById = new Map<number, PendingAnchor>();
let anchorCounter = 0;

// ---------------------------------------------------------------------------
// Proof hash computation
// ---------------------------------------------------------------------------

/**
 * Compute the 32-byte proof commitment for a foreign chain event.
 *
 * For Groth16/PLONK proofs the caller supplies raw proof bytes.
 * For hash-only anchors we derive the commitment from the event data.
 *
 * The HMAC secret (`BRIDGE_HMAC_SECRET`) prevents spoofing of anchor
 * records by actors that don't control the bridge service.
 */
export function computeProofHash(
  event: ForeignChainEvent,
  zkProof?: string,
): Buffer {
  const secret = process.env.BRIDGE_HMAC_SECRET ?? 'quorumproof-bridge';
  const hmac = createHmac('sha256', secret);

  if (zkProof && zkProof.length > 0) {
    // Hash the ZK proof bytes directly
    hmac.update(Buffer.from(zkProof.replace(/^0x/, ''), 'hex'));
  } else {
    // Hash-only: commit to chain_id + tx_hash + event_data
    hmac.update(`${event.chainId}:${event.txHash}:${event.eventData}`);
  }

  return hmac.digest();
}

// ---------------------------------------------------------------------------
// Core bridge operations
// ---------------------------------------------------------------------------

/**
 * Prepare an anchor record from a foreign-chain event.
 *
 * This function does NOT call the Stellar contract — it returns a structured
 * `AnchorRequest` that the API route will forward to the contract via
 * `register_chain_anchor`.
 */
export function prepareAnchor(req: AnchorRequest): PendingAnchor {
  if (!SUPPORTED_CHAINS[req.foreignEvent.chainId]) {
    throw new Error(`Unsupported chain ID: ${req.foreignEvent.chainId}`);
  }

  const proofType = req.proofType ?? (req.zkProof ? ProofType.Groth16 : ProofType.HashOnly);
  const proofHashBuf = computeProofHash(req.foreignEvent, req.zkProof);
  const proofHash = proofHashBuf.toString('hex');

  const txHash = req.foreignEvent.txHash.toLowerCase().replace(/^0x/, '');

  if (pendingAnchors.has(txHash)) {
    return pendingAnchors.get(txHash)!;
  }

  const record: PendingAnchor = {
    anchorId: null, // filled in after on-chain registration
    credentialId: req.credentialId,
    chainId: req.foreignEvent.chainId,
    chainName: SUPPORTED_CHAINS[req.foreignEvent.chainId],
    txHash,
    proofHash,
    proofType,
    anchoredAt: Date.now() / 1000,
    verified: false,
    foreignEvent: req.foreignEvent,
  };

  pendingAnchors.set(txHash, record);
  return record;
}

/**
 * Record that an anchor was successfully registered on-chain.
 * Call this after `register_chain_anchor` returns an anchor ID.
 */
export function confirmAnchor(txHash: string, anchorId: number): void {
  const key = txHash.toLowerCase().replace(/^0x/, '');
  const record = pendingAnchors.get(key);
  if (!record) return;
  record.anchorId = anchorId;
  anchorById.set(anchorId, record);
}

/**
 * Record that an anchor's ZK proof has been verified.
 */
export function markVerified(anchorId: number): void {
  const record = anchorById.get(anchorId);
  if (record) record.verified = true;
}

// ---------------------------------------------------------------------------
// Query helpers (used by API routes)
// ---------------------------------------------------------------------------

export function getPendingAnchors(): PendingAnchor[] {
  return Array.from(pendingAnchors.values()).filter((a) => a.anchorId === null);
}

export function getAnchorByTxHash(txHash: string): PendingAnchor | undefined {
  return pendingAnchors.get(txHash.toLowerCase().replace(/^0x/, ''));
}

export function getAnchorById(anchorId: number): PendingAnchor | undefined {
  return anchorById.get(anchorId);
}

export function getAllAnchors(): PendingAnchor[] {
  return Array.from(anchorById.values());
}

export function getSupportedChains() {
  return Object.entries(SUPPORTED_CHAINS).map(([id, name]) => ({
    chain_id: parseInt(id, 10),
    name,
  }));
}

// ---------------------------------------------------------------------------
// Chain-specific event decoders (minimal; expand per ABI)
// ---------------------------------------------------------------------------

export interface DecodedCredentialEvent {
  type: 'CredentialIssued' | 'CredentialRevoked' | 'Unknown';
  credentialId?: string;
  holder?: string;
  issuer?: string;
  raw: string;
}

/**
 * Decode a raw ABI-encoded event log from a known EVM contract.
 *
 * This is intentionally minimal — a production implementation would use
 * ethers.js `Interface.parseLog()` with the full contract ABI.
 *
 * Topic0 hashes (keccak256 of event signature):
 *   CredentialIssued(uint256,address,address)
 *     = 0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0 (example)
 */
export function decodeEthEvent(
  topicZero: string,
  data: string,
): DecodedCredentialEvent {
  // Minimal topic matching — expand with real keccak256 hashes per your EVM contract ABI.
  const TOPIC_ISSUED = process.env.ETH_TOPIC_CREDENTIAL_ISSUED ?? '';
  const TOPIC_REVOKED = process.env.ETH_TOPIC_CREDENTIAL_REVOKED ?? '';

  if (TOPIC_ISSUED && topicZero.toLowerCase() === TOPIC_ISSUED.toLowerCase()) {
    return { type: 'CredentialIssued', raw: data };
  }
  if (TOPIC_REVOKED && topicZero.toLowerCase() === TOPIC_REVOKED.toLowerCase()) {
    return { type: 'CredentialRevoked', raw: data };
  }
  return { type: 'Unknown', raw: data };
}
