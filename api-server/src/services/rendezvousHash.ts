import { createHash } from 'crypto';

/**
 * Highest-Random-Weight (rendezvous) hashing. For a fixed key, each candidate
 * index gets an independent pseudo-random weight; the candidate with the
 * highest weight wins. This gives the same guarantee as ring-based
 * consistent hashing without needing virtual-node bookkeeping: growing the
 * candidate pool from N to M only reassigns keys whose winner is one of the
 * (M - N) new candidates, i.e. an expected 1 - N/M fraction move (≈ 1/M for
 * a single-candidate increment), never a full remap like modulo hashing.
 */
export function rendezvousWeight(key: string, candidate: number): number {
  const digest = createHash('sha1').update(`${key}::${candidate}`).digest();
  return digest.readUInt32BE(0);
}

export function rendezvousSelect(key: string, candidateCount: number): number {
  if (candidateCount <= 0) {
    throw new Error('candidateCount must be >= 1');
  }
  let bestIndex = 0;
  let bestWeight = -1;
  for (let i = 0; i < candidateCount; i++) {
    const weight = rendezvousWeight(key, i);
    if (weight > bestWeight) {
      bestWeight = weight;
      bestIndex = i;
    }
  }
  return bestIndex;
}
