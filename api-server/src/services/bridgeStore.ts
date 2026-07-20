/**
 * Durable storage for cross-chain anchors — Issue #880 hardening.
 *
 * Replaces the previous in-memory `Map`-based `pendingAnchors`/`anchorById`
 * stores (which lost all anchor state, including which anchors had been
 * proof-verified, on every process restart). Backed by the same
 * append-only, fsync'd JSONL log (`DurableLog`) used elsewhere in this
 * service (see webhookStore.ts), so anchor state survives a crash/restart.
 */
import path from 'path';
import { DurableLog } from './durableLog.js';

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
  /** Block hash where the event was emitted — required to look up the checkpointed header. */
  blockHash: string;
  /** Emitting contract address on the foreign chain */
  contractAddress: string;
  /** Block timestamp (Unix seconds) */
  blockTimestamp: number;
}

export interface AnchorRecord {
  anchorId: number | null;
  credentialId: number;
  chainId: number;
  chainName: string;
  txHash: string;
  /** Content-addressing digest for dedup/display only — NOT a security boundary. See crossChainBridge.ts. */
  proofHash: string;
  proofType: ProofType;
  anchoredAt: number;
  verified: boolean;
  foreignEvent: ForeignChainEvent;
}

const TX_HASH_KEY_PREFIX = 'tx:';
const ANCHOR_ID_KEY_PREFIX = 'id:';

export class BridgeStore {
  private readonly log: DurableLog<AnchorRecord>;

  constructor(dataDir?: string) {
    const dir = dataDir ?? process.env.BRIDGE_STORE_DATA_DIR ?? path.join(process.cwd(), '.data', 'bridge');
    this.log = new DurableLog<AnchorRecord>(path.join(dir, 'anchors.jsonl'));
  }

  private txKey(txHash: string): string {
    return `${TX_HASH_KEY_PREFIX}${txHash.toLowerCase().replace(/^0x/, '')}`;
  }

  private idKey(anchorId: number): string {
    return `${ANCHOR_ID_KEY_PREFIX}${anchorId}`;
  }

  getByTxHash(txHash: string): AnchorRecord | undefined {
    return this.log.get(this.txKey(txHash));
  }

  getById(anchorId: number): AnchorRecord | undefined {
    return this.log.get(this.idKey(anchorId));
  }

  /** Insert a newly-prepared (not yet on-chain) anchor, or return the existing one for this txHash. */
  prepare(record: Omit<AnchorRecord, 'anchorId'>): AnchorRecord {
    const key = this.txKey(record.txHash);
    const existing = this.log.get(key);
    if (existing) return existing;

    const full: AnchorRecord = { ...record, anchorId: null };
    this.log.set(key, full);
    return full;
  }

  /** Record that an anchor was registered on-chain, allocating its durable anchor ID. */
  confirm(txHash: string, anchorId: number): AnchorRecord | undefined {
    const key = this.txKey(txHash);
    const record = this.log.get(key);
    if (!record) return undefined;

    const updated: AnchorRecord = { ...record, anchorId };
    this.log.set(key, updated);
    this.log.set(this.idKey(anchorId), updated);
    return updated;
  }

  markVerified(anchorId: number): AnchorRecord | undefined {
    const record = this.log.get(this.idKey(anchorId));
    if (!record) return undefined;
    const updated: AnchorRecord = { ...record, verified: true };
    this.log.set(this.idKey(anchorId), updated);
    if (updated.txHash) this.log.set(this.txKey(updated.txHash), updated);
    return updated;
  }

  getPending(): AnchorRecord[] {
    return this.log.values().filter((r) => r.anchorId === null);
  }

  getAll(): AnchorRecord[] {
    return this.log.values().filter((r) => r.anchorId !== null);
  }

  /** Reset state — for testing only. */
  _resetForTest(): void {
    for (const key of this.log.keys()) this.log.delete(key);
  }
}

let defaultStore: BridgeStore | undefined;

export function getDefaultBridgeStore(): BridgeStore {
  if (!defaultStore) defaultStore = new BridgeStore();
  return defaultStore;
}

/** Test-only: force the module to construct a fresh default store (e.g. pointed at a new dataDir). */
export function _setDefaultBridgeStoreForTest(store: BridgeStore | undefined): void {
  defaultStore = store;
}
