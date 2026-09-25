/**
 * Minimal SSZ merkleization primitives — just enough to hash and verify
 * Merkle branches for the fixed-shape beacon-chain containers the light
 * client (`beaconLightClient.ts`) needs (`BeaconBlockHeader`, `SyncCommittee`,
 * `ForkData`, `SigningData`). This is not a general-purpose SSZ library: it
 * hand-implements exactly the container/vector shapes those types need,
 * following the SSZ merkleization spec
 * (https://github.com/ethereum/consensus-specs/blob/dev/ssz/simple-serialize.md#merkleization)
 * rather than pulling in a full encoder for types this codebase never
 * constructs (lists, bitlists, unions, ...).
 */
import { sha256 } from '@noble/hashes/sha2.js';

const ZERO_CHUNK = new Uint8Array(32);
const zeroHashCache: Uint8Array[] = [ZERO_CHUNK];

/** zeroHashes[i] = the root of a fully zero-filled subtree of depth i. */
function zeroHash(depth: number): Uint8Array {
  while (zeroHashCache.length <= depth) {
    const prev = zeroHashCache[zeroHashCache.length - 1];
    zeroHashCache.push(sha256(concatBytes(prev, prev)));
  }
  return zeroHashCache[depth];
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function floorLog2(n: number): number {
  if (n < 1) throw new Error(`floorLog2: n must be >= 1, got ${n}`);
  return 31 - Math.clz32(n);
}

function nextPowerOfTwo(n: number): number {
  if (n <= 1) return 1;
  return 2 ** Math.ceil(Math.log2(n));
}

/**
 * merkleize(chunks): pad `chunks` (each exactly 32 bytes) with zero chunks up
 * to the next power of two, then fold pairwise up to a single root.
 */
export function merkleize(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return zeroHash(0);
  for (const c of chunks) {
    if (c.length !== 32) throw new Error(`merkleize: every chunk must be 32 bytes, got ${c.length}`);
  }
  const width = nextPowerOfTwo(chunks.length);
  const depth = floorLog2(width);
  let layer = chunks.slice();
  for (let level = 0; level < depth; level++) {
    const next: Uint8Array[] = [];
    const padValue = zeroHash(level);
    for (let i = 0; i < width >> level; i += 2) {
      const left = layer[i] ?? padValue;
      const right = layer[i + 1] ?? padValue;
      next.push(sha256(concatBytes(left, right)));
    }
    layer = next;
  }
  return layer[0];
}

/** Pack a little-endian uint64 into a single 32-byte (zero-padded) chunk. */
export function packUint64(value: number | bigint): Uint8Array {
  const chunk = new Uint8Array(32);
  const view = new DataView(chunk.buffer);
  view.setBigUint64(0, BigInt(value), true);
  return chunk;
}

/** Pack an arbitrary byte string (<=32 bytes) into a single zero-padded chunk. */
export function packBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 32) throw new Error(`packBytes: ${bytes.length} bytes does not fit in one chunk`);
  const chunk = new Uint8Array(32);
  chunk.set(bytes);
  return chunk;
}

/**
 * hash_tree_root of a fixed-size byte vector (e.g. BLSPubkey/Bytes48,
 * Bytes32), i.e. `merkleize(pack(value))` per the SSZ spec's "vector of
 * basic objects" rule.
 */
export function hashTreeRootBytes(bytes: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += 32) {
    const slice = bytes.subarray(i, i + 32);
    chunks.push(slice.length === 32 ? slice : packBytes(slice));
  }
  return merkleize(chunks);
}

/**
 * Generalized-index Merkle branch verification, per the SSZ spec's
 * `calculate_merkle_root` / `verify_merkle_proof`:
 *
 *   for i, node in enumerate(branch):
 *     leaf = hash(node + leaf) if bit i of gindex else hash(leaf + node)
 *
 * `gindex` must already be resolved to fixed depth `floorLog2(gindex)` —
 * this repo only exercises well-known, non-fork-varying gindices, so unlike
 * `is_valid_normalized_merkle_branch` there is no leading-zero-padding
 * normalization step here.
 */
export function verifyMerkleBranch(
  leaf: Uint8Array,
  branch: Uint8Array[],
  gindex: bigint,
  root: Uint8Array,
): boolean {
  const depth = gindex.toString(2).length - 1;
  if (branch.length !== depth) return false;
  let value = leaf;
  for (let i = 0; i < depth; i++) {
    const bit = (gindex >> BigInt(i)) & 1n;
    value = bit === 1n ? sha256(concatBytes(branch[i], value)) : sha256(concatBytes(value, branch[i]));
  }
  return bytesEqual(value, root);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Custom serialization for large fixed-shape SSZ containers.
 *
 * The generic path (`hashTreeRootBytes` + `merkleize`) re-allocates a fresh
 * 32-byte chunk for every field and re-walks the whole tree on each call,
 * which dominates the contract-state serialization profile for large types
 * (e.g. `SyncCommittee`, whose 512 pubkeys expand to 768 chunks). This
 * serializer writes the container's fixed-size fields directly into a single
 * pre-sized buffer and merkleizes the resulting chunks in one pass, avoiding
 * the per-field intermediate allocations.
 */
export interface SszField {
  /** Byte length of the field's serialized form. */
  size: number;
  /** Fixed-size field value; omitted fields serialize as zero bytes. */
  value?: Uint8Array;
}

/**
 * Serialize a fixed-shape container of fixed-size fields into its SSZ byte
 * representation, writing straight into one buffer instead of concatenating
 * per-field allocations.
 */
export function serializeContainer(fields: SszField[]): Uint8Array {
  let total = 0;
  for (const f of fields) total += f.size;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const f of fields) {
    if (f.value !== undefined) {
      if (f.value.length !== f.size) {
        throw new Error(`serializeContainer: field expected ${f.size} bytes, got ${f.value.length}`);
      }
      out.set(f.value, offset);
    }
    offset += f.size;
  }
  return out;
}

/**
 * Deserialize a fixed-shape container of fixed-size fields, returning lazy
 * views into the source buffer rather than copying each field out. Callers
 * that only read a subset of fields (the common case for large containers)
 * never pay for the fields they skip.
 */
export function deserializeContainer(
  bytes: Uint8Array,
  sizes: number[],
): Array<Uint8Array | undefined> {
  let total = 0;
  for (const s of sizes) total += s;
  if (bytes.length !== total) {
    throw new Error(`deserializeContainer: expected ${total} bytes, got ${bytes.length}`);
  }
  const fields: Array<Uint8Array | undefined> = new Array(sizes.length);
  let offset = 0;
  for (let i = 0; i < sizes.length; i++) {
    const size = sizes[i];
    fields[i] = size === 0 ? undefined : bytes.subarray(offset, offset + size);
    offset += size;
  }
  return fields;
}

/**
 * hash_tree_root of a serialized fixed-shape container, merkleizing its
 * 32-byte chunks in a single pass over the already-serialized bytes.
 */
export function hashTreeRootContainer(bytes: Uint8Array): Uint8Array {
  const chunkCount = Math.ceil(bytes.length / 32);
  const chunks: Uint8Array[] = new Array(chunkCount);
  for (let i = 0; i < chunkCount; i++) {
    const slice = bytes.subarray(i * 32, i * 32 + 32);
    chunks[i] = slice.length === 32 ? slice : packBytes(slice);
  }
  return merkleize(chunks);
}
