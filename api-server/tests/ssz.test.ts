import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { merkleize, packUint64, hashTreeRootBytes, verifyMerkleBranch, floorLog2 } from '../src/services/ssz.js';

describe('floorLog2', () => {
  it('matches known values', () => {
    expect(floorLog2(1)).toBe(0);
    expect(floorLog2(2)).toBe(1);
    expect(floorLog2(54)).toBe(5);
    expect(floorLog2(55)).toBe(5);
    expect(floorLog2(105)).toBe(6);
    expect(floorLog2(812)).toBe(9);
  });
});

describe('merkleize', () => {
  it('a single chunk is its own root', () => {
    const chunk = new Uint8Array(32).fill(7);
    expect(merkleize([chunk])).toEqual(chunk);
  });

  it('two chunks hash directly together', () => {
    const a = new Uint8Array(32).fill(1);
    const b = new Uint8Array(32).fill(2);
    const expected = sha256(new Uint8Array([...a, ...b]));
    expect(merkleize([a, b])).toEqual(expected);
  });

  it('pads a non-power-of-two chunk count with zero chunks', () => {
    const a = new Uint8Array(32).fill(1);
    const b = new Uint8Array(32).fill(2);
    const c = new Uint8Array(32).fill(3);
    const zero = new Uint8Array(32);
    // 3 chunks -> padded to 4: root = h(h(a,b), h(c,zero))
    const expected = sha256(new Uint8Array([...sha256(new Uint8Array([...a, ...b])), ...sha256(new Uint8Array([...c, ...zero]))]));
    expect(merkleize([a, b, c])).toEqual(expected);
  });
});

describe('packUint64', () => {
  it('little-endian encodes into a zero-padded 32-byte chunk', () => {
    const chunk = packUint64(1);
    expect(chunk.length).toBe(32);
    expect(Array.from(chunk.subarray(0, 8))).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(chunk.subarray(8).every((b) => b === 0)).toBe(true);
  });
});

describe('hashTreeRootBytes', () => {
  it('a 32-byte value is its own root (single chunk, no padding)', () => {
    const bytes = new Uint8Array(32).fill(9);
    expect(hashTreeRootBytes(bytes)).toEqual(bytes);
  });

  it('a 48-byte value (e.g. a BLS pubkey) packs into 2 chunks', () => {
    const bytes = new Uint8Array(48).fill(5);
    const chunk0 = bytes.subarray(0, 32);
    const chunk1 = new Uint8Array(32);
    chunk1.set(bytes.subarray(32));
    const expected = sha256(new Uint8Array([...chunk0, ...chunk1]));
    expect(hashTreeRootBytes(bytes)).toEqual(expected);
  });
});

describe('verifyMerkleBranch', () => {
  // Build an 8-leaf tree by hand, prove leaf index 5 (gindex 8+5=13).
  //   level1[i] = h(leaves[2i], leaves[2i+1]); level2[i] = h(level1[2i], level1[2i+1]); root = h(level2[0], level2[1])
  // gindex 13 = 0b1101 -> bit0=1 (sibling=leaves[4], on the left), bit1=0 (sibling=level1[3], on the right),
  // bit2=1 (sibling=level2[0], on the left).
  const leaves = Array.from({ length: 8 }, (_, i) => new Uint8Array(32).fill(i + 1));
  const level1 = [0, 2, 4, 6].map((i) => sha256(new Uint8Array([...leaves[i], ...leaves[i + 1]])));
  const level2 = [0, 1].map((i) => sha256(new Uint8Array([...level1[2 * i], ...level1[2 * i + 1]])));
  const root = sha256(new Uint8Array([...level2[0], ...level2[1]]));
  const gindex = 13n; // 8 + 5
  const validBranch = [leaves[4], level1[3], level2[0]];

  it('accepts a valid depth-3 proof and computes the same root calculate_merkle_root would', () => {
    expect(verifyMerkleBranch(leaves[5], validBranch, gindex, root)).toBe(true);
  });

  it('rejects a tampered branch entry', () => {
    const tamperedBranch = [new Uint8Array(32).fill(99), level1[3], level2[0]];
    expect(verifyMerkleBranch(leaves[5], tamperedBranch, gindex, root)).toBe(false);
  });

  it('rejects a branch of the wrong length', () => {
    const leaf = new Uint8Array(32).fill(1);
    const root = new Uint8Array(32).fill(2);
    expect(verifyMerkleBranch(leaf, [leaf], 13n, root)).toBe(false);
  });
});
