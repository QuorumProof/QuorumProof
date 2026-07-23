import { sha256 } from '@noble/hashes/sha2.js';

/** Generic bottom-up Merkle proof for a power-of-two leaf array — test-only helper. */
export function merkleProofForLeaf(leaves: Uint8Array[], index: number): Uint8Array[] {
  const depth = Math.log2(leaves.length);
  if (!Number.isInteger(depth)) throw new Error('leaves.length must be a power of two');
  let level = leaves;
  let pos = index;
  const branch: Uint8Array[] = [];
  for (let d = 0; d < depth; d++) {
    const siblingPos = pos ^ 1;
    branch.push(level[siblingPos]);
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(sha256(new Uint8Array([...level[i], ...level[i + 1]])));
    }
    level = next;
    pos = Math.floor(pos / 2);
  }
  return branch;
}
