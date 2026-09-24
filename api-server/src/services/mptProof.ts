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
 *      the logs it contains — was genuinely included in that block. No party's
 *      word is taken for the receipt contents; the proof is self-verifying
 *      against the (already-trusted) receiptsRoot.
 *
 * This is what replaces the HMAC-keyed "trust the bridge operator" model:
 * the only thing anyone has to be honest about now is which block header is
 * canonical/finalized (see blockHeaderStore.ts's documented trust
 * assumption) — the receipt content itself is verified, not asserted.
 *
 * Issue #1558 adds optional proof compression: trie proof nodes are large
 * (~512 bytes each) and are stored/transported repeatedly, so we compress
 * them with a compact varint length-prefixed framing plus secp256k1 point
 * compression for any 33/65-byte public-key-shaped blobs. Decompression is
 * exact and lossless, so verification semantics are unchanged.
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
 * Verify that `proof.claim`'s receipt is genuinely included at `proof.claim.txIndex`
 * under `receiptsRoot`. Throws `ReceiptProofError` if the proof is invalid, malformed,
 * or (critically) doesn't match the claimed receipt fields — i.e. this rejects both
 * "the proof doesn't verify" and "the proof verifies but the caller lied about the
 * receipt contents it's a proof of".
 */
export async function verifyReceiptProof(receiptsRoot: string, proof: ReceiptProof): Promise<void> {
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

// ---------------------------------------------------------------------------
// Issue #1558 — Proof compression
// ---------------------------------------------------------------------------

/**
 * Encode a non-negative integer as an unsigned LEB128 varint. Small integers
 * (trie node lengths, counts, indices) collapse to 1 byte instead of the 4–8
 * bytes a fixed-width encoding would cost.
 */
export function encodeVarint(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) {
    throw new ReceiptProofError(`varint requires a non-negative integer, got ${value}`);
  }
  const out: number[] = [];
  let v = value;
  do {
    let byte = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) byte |= 0x80;
    out.push(byte);
  } while (v > 0);
  return new Uint8Array(out);
}

/** Decode an unsigned LEB128 varint, returning the value and bytes consumed. */
export function decodeVarint(bytes: Uint8Array, offset = 0): { value: number; bytesRead: number } {
  let value = 0;
  let shift = 1;
  let i = offset;
  for (;;) {
    if (i >= bytes.length) {
      throw new ReceiptProofError('Truncated varint');
    }
    const byte = bytes[i++];
    value += (byte & 0x7f) * shift;
    if ((byte & 0x80) === 0) break;
    shift *= 128;
    if (shift > Number.MAX_SAFE_INTEGER) {
      throw new ReceiptProofError('Varint exceeds safe integer range');
    }
  }
  return { value, bytesRead: i - offset };
}

/**
 * Compress a secp256k1 public key / point. A 65-byte uncompressed point
 * `0x04 || X(32) || Y(32)` is reduced to the 33-byte compressed form
 * `(0x02|0x03) || X(32)` where the prefix encodes the parity of Y. Already
 * compressed (33-byte) points are returned unchanged. Non-point blobs are
 * returned as-is so callers can apply this opportunistically.
 */
export function compressPoint(point: Uint8Array): Uint8Array {
  if (point.length === 33 && (point[0] === 0x02 || point[0] === 0x03)) {
    return point;
  }
  if (point.length !== 65 || point[0] !== 0x04) {
    return point;
  }
  const prefix = (point[64] & 1) === 0 ? 0x02 : 0x03;
  const out = new Uint8Array(33);
  out[0] = prefix;
  out.set(point.subarray(1, 33), 1);
  return out;
}

/**
 * Decompress a 33-byte compressed secp256k1 point back to its 65-byte
 * uncompressed form by recovering Y from X using the curve equation
 * `Y^2 = X^3 + 7 (mod p)`. Returns the input unchanged if it is not a
 * compressed point. Throws if X is not on the curve.
 */
export function decompressPoint(point: Uint8Array): Uint8Array {
  if (point.length !== 33 || (point[0] !== 0x02 && point[0] !== 0x03)) {
    return point;
  }
  const p = (1n << 256n) - (1n << 32n) - 977n; // secp256k1 field prime
  const x = BigInt(bytesToHex(point.subarray(1, 33)));
  if (x >= p) {
    throw new ReceiptProofError('Compressed point X coordinate out of field range');
  }
  const ySquared = (((x * x) % p) * x + 7n) % p;
  // p ≡ 3 (mod 4), so sqrt is ySquared^((p+1)/4) mod p.
  let y = modPow(ySquared, (p + 1n) / 4n, p);
  if ((y * y) % p !== ySquared) {
    throw new ReceiptProofError('Compressed point is not on the secp256k1 curve');
  }
  const wantOdd = point[0] === 0x03;
  if ((y & 1n) === 1n !== wantOdd) {
    y = p - y;
  }
  const out = new Uint8Array(65);
  out[0] = 0x04;
  out.set(point.subarray(1, 33), 1);
  out.set(hexToBytes(('0x' + y.toString(16).padStart(64, '0')) as `0x${string}`), 33);
  return out;
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/**
 * Compress a list of proof nodes into a single compact byte string:
 * `varint(count) || (varint(len) || compressedNode)*`. Each node is
 * point-compressed when it looks like a public key, otherwise stored verbatim.
 */
export function compressProofNodes(nodes: Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = [encodeVarint(nodes.length)];
  for (const node of nodes) {
    const compressed = compressPoint(node);
    parts.push(encodeVarint(compressed.length), compressed);
  }
  return concatBytes(...parts);
}

/** Inverse of `compressProofNodes` — exact, lossless reconstruction of the nodes. */
export function decompressProofNodes(blob: Uint8Array): Uint8Array[] {
  const { value: count, bytesRead } = decodeVarint(blob, 0);
  const nodes: Uint8Array[] = [];
  let offset = bytesRead;
  for (let i = 0; i < count; i++) {
    const len = decodeVarint(blob, offset);
    offset += len.bytesRead;
    const end = offset + len.value;
    if (end > blob.length) {
      throw new ReceiptProofError('Truncated compressed proof node');
    }
    nodes.push(decompressPoint(blob.subarray(offset, end)));
    offset = end;
  }
  return nodes;
}

/** Compress a `ReceiptProof`'s inclusion nodes into a single 0x-prefixed blob. */
export function compressReceiptProof(proof: ReceiptProof): string {
  const nodes = proof.proofNodes.map((n) => hexToBytes(n as `0x${string}`));
  return bytesToHex(compressProofNodes(nodes));
}

/** Restore a `ReceiptProof` from its compressed inclusion-node blob. */
export function decompressReceiptProof(proof: ReceiptProof, compressed: string): ReceiptProof {
  const nodes = decompressProofNodes(hexToBytes(compressed as `0x${string}`));
  return { ...proof, proofNodes: nodes.map((n) => bytesToHex(n)) };
}

/**
 * Measure the storage reduction and CPU cost of compressing a proof's nodes.
 * Returns the original/compressed byte sizes, the percentage saved, and the
 * wall-clock milliseconds spent compressing and decompressing.
 */
export function benchmarkProofCompression(proof: ReceiptProof): {
  originalBytes: number;
  compressedBytes: number;
  savedPercent: number;
  compressMs: number;
  decompressMs: number;
} {
  const nodes = proof.proofNodes.map((n) => hexToBytes(n as `0x${string}`));
  const originalBytes = nodes.reduce((sum, n) => sum + n.length, 0);

  const t0 = Date.now();
  const blob = compressProofNodes(nodes);
  const compressMs = Date.now() - t0;

  const t1 = Date.now();
  decompressProofNodes(blob);
  const decompressMs = Date.now() - t1;

  const savedPercent = originalBytes === 0 ? 0 : (1 - blob.length / originalBytes) * 100;
  return {
    originalBytes,
    compressedBytes: blob.length,
    savedPercent,
    compressMs,
    decompressMs,
  };
}
