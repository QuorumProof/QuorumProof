/**
 * Merkle-Patricia-Trie receipt/log proof verification — Issue #880 hardening.
 *
 * Ethereum (and EVM-equivalent chains like Polygon) commit to every
 * transaction receipt in a block via a Merkle-Patricia trie whose root is
 * the block header's `receiptsRoot`. Given:
 *
 *   1. A block header we already trust the `receiptsRoot` of (see
 *      `blockHeaderStore.ts` for how that trust is established), and
 *   2. An inclusion proof (the trie nodes on the path from the root to the
 *      leaf for a given transaction index) plus the claimed receipt fields,
 *
 * this module cryptographically verifies that the receipt — and therefore
 * the logs it contains — was genuinely included in that block. No party's
 * word is taken for the receipt contents; the proof is self-verifying
 * against the (already-trusted) receiptsRoot.
 *
 * This is what replaces the HMAC-keyed "trust the bridge operator" model:
 * the only thing anyone has to be honest about now is which block header is
 * canonical/finalized (see blockHeaderStore.ts's documented trust
 * assumption) — the receipt content itself is verified, not asserted.
 */
import { RLP } from '@ethereumjs/rlp';
import { createMPT, createMerkleProof, verifyMerkleProof, MerklePatriciaTrie } from '@ethereumjs/mpt';
import {
  bigIntToUnpaddedBytes,
  bytesToHex,
  concatBytes,
  hexToBytes,
  intToUnpaddedBytes,
} from '@ethereumjs/util';
import { createHash } from 'crypto';

export interface RawLog {
  /** 0x-prefixed, 20-byte contract address that emitted the log. */
  address: string;
  /** 0x-prefixed, 32-byte topics (topic0 = event signature hash). */
  topics: string[];
  /** 0x-prefixed ABI-encoded (non-indexed) log data. */
  data: string;
}

export type TxType = 0 | 1 | 2 | 3 | 4;

export interface ReceiptClaim {
  /** Position of the transaction within the block — this is the trie key. */
  txIndex: number;
  /** EIP-2718 transaction type. 0 = legacy (untyped) receipt encoding. */
  txType: TxType;
  status: 0 | 1;
  cumulativeGasUsed: string | bigint;
  /** 0x-prefixed, 256-byte logs bloom. */
  logsBloom: string;
  logs: RawLog[];
}

export interface ReceiptProof {
  claim: ReceiptClaim;
  /** Trie inclusion proof: 0x-prefixed encoded trie nodes, root to leaf. */
  proofNodes: string[];
}

export class ReceiptProofError extends Error {}

/** Trie key for a receipt at `txIndex`, per the consensus receipts-trie encoding. */
export function receiptTrieKey(txIndex: number): Uint8Array {
  return RLP.encode(intToUnpaddedBytes(txIndex));
}

/**
 * Consensus encoding of a receipt: `RLP([status, cumulativeGasUsed, logsBloom, logs])`
 * for legacy (type 0) receipts, or `type || RLP([...])` for EIP-2718 typed
 * receipts (EIP-1559 etc.) — this is exactly the trie *value* at `receiptTrieKey(txIndex)`.
 */
export function encodeReceipt(claim: ReceiptClaim): Uint8Array {
  const statusBytes = claim.status === 0 ? new Uint8Array() : intToUnpaddedBytes(claim.status);
  const cumulativeGasUsedBytes = bigIntToUnpaddedBytes(BigInt(claim.cumulativeGasUsed));
  const logsBloomBytes = hexToBytes(claim.logsBloom as `0x${string}`);
  const logsRlp = claim.logs.map((log) => [
    hexToBytes(log.address as `0x${string}`),
    log.topics.map((t) => hexToBytes(t as `0x${string}`)),
    hexToBytes(log.data as `0x${string}`),
  ]);
  const inner = RLP.encode([statusBytes, cumulativeGasUsedBytes, logsBloomBytes, logsRlp]);
  if (claim.txType === 0) return inner;
  return concatBytes(new Uint8Array([claim.txType]), inner);
}

/**
 * Deterministic hash of a verification request: the trusted `receiptsRoot`
 * plus the exact proof nodes and claimed receipt fields. Two requests that
 * hash identically are guaranteed to produce the same verification outcome,
 * so the result can be safely memoized on this key.
 */
export function proofCacheKey(receiptsRoot: string, proof: ReceiptProof): string {
  const hash = createHash('sha256');
  hash.update(hexToBytes(receiptsRoot as `0x${string}`));
  hash.update(receiptTrieKey(proof.claim.txIndex));
  hash.update(encodeReceipt(proof.claim));
  for (const node of proof.proofNodes) {
    hash.update(hexToBytes(node as `0x${string}`));
  }
  return hash.digest('hex');
}

/**
 * Bounded LRU cache of proof-verification outcomes. Keyed by `proofCacheKey`,
 * so a cache hit is only ever returned for a byte-identical verification
 * request. Bounded by `maxSize` (default 1024) to cap memory; the least
 * recently used entry is evicted when full. `invalidate`/`clear` provide the
 * invalidation strategy for callers that learn a receiptsRoot is no longer
 * canonical (e.g. a reorg).
 */
export class ProofVerificationCache {
  private readonly cache = new Map<string, true>();
  private readonly maxSize: number;

  constructor(maxSize = 1024) {
    this.maxSize = Math.max(1, maxSize);
  }

  get size(): number {
    return this.cache.size;
  }

  /** Returns true only if this exact request previously verified successfully. */
  has(key: string): boolean {
    if (!this.cache.has(key)) return false;
    // Refresh recency: re-insert so this key becomes the most recently used.
    this.cache.delete(key);
    this.cache.set(key, true);
    return true;
  }

  /** Record a successful verification, evicting the LRU entry if at capacity. */
  set(key: string): void {
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, true);
    while (this.cache.size > this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  /** Invalidate a single entry (e.g. when its receiptsRoot is reorged out). */
  invalidate(key: string): void {
    this.cache.delete(key);
  }

  /** Drop every cached outcome — used when the trusted header set changes. */
  clear(): void {
    this.cache.clear();
  }
}

/** Process-wide cache shared by `verifyReceiptProof` callers. */
export const proofVerificationCache = new ProofVerificationCache();

/**
 * Verify that `proof.claim`'s receipt is genuinely included at `proof.claim.txIndex`
 * under `receiptsRoot`. Throws `ReceiptProofError` if the proof is invalid, malformed,
 * or (critically) doesn't match the claimed receipt fields — i.e. this rejects both
 * "the proof doesn't verify" and "the proof verifies but the caller lied about the
 * receipt contents it's a proof of".
 *
 * Successful verifications are memoized on a hash of the full request (see
 * `proofCacheKey`), so repeated verification of the same proof is O(1). Only
 * successes are cached: a cache miss (or a previously-failed request) always
 * falls through to the real cryptographic verification, so correctness is
 * never weakened by the cache.
 */
export async function verifyReceiptProof(
  receiptsRoot: string,
  proof: ReceiptProof,
  cache: ProofVerificationCache = proofVerificationCache,
): Promise<void> {
  const cacheKey = proofCacheKey(receiptsRoot, proof);
  if (cache.has(cacheKey)) return;

  const key = receiptTrieKey(proof.claim.txIndex);
  const claimedValue = encodeReceipt(proof.claim);

  let proven: Uint8Array | null;
  try {
    proven = await verifyMerkleProof(key, proof.proofNodes.map((n) => hexToBytes(n as `0x${string}`)), {
      root: hexToBytes(receiptsRoot as `0x${string}`),
    });
  } catch (err) {
    throw new ReceiptProofError(`Invalid Merkle-Patricia proof: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (proven === null) {
    throw new ReceiptProofError(`No receipt found at index ${proof.claim.txIndex} under the given receiptsRoot`);
  }
  if (bytesToHex(proven) !== bytesToHex(claimedValue)) {
    throw new ReceiptProofError('Proof verified but does not match the claimed receipt fields — rejecting');
  }

  cache.set(cacheKey);
}

/** Build a trie from a full set of block receipts — used by relays/tests to generate proofs. */
export async function buildReceiptTrie(receipts: ReceiptClaim[]): Promise<MerklePatriciaTrie> {
  const trie = await createMPT();
  for (const receipt of receipts) {
    await trie.put(receiptTrieKey(receipt.txIndex), encodeReceipt(receipt));
  }
  return trie;
}

/** Generate an inclusion proof for `txIndex` from a trie built via `buildReceiptTrie`. */
export async function createReceiptProof(trie: MerklePatriciaTrie, txIndex: number): Promise<string[]> {
  const proof = await createMerkleProof(trie, receiptTrieKey(txIndex));
  return proof.map((node) => bytesToHex(node));
}

export function receiptsRootHex(trie: MerklePatriciaTrie): string {
  return bytesToHex(trie.root());
}
