/**
 * Quorum slice factory (Issue #1677).
 *
 * Produces JSON-shaped slices matching the `QuorumSlice` struct in
 * `contracts/quorum_proof/src/lib.rs`. The factory enforces the same basic
 * invariants the contract relies on, so tests cannot accidentally build a
 * slice that could never be satisfied.
 */

import { nextStellarAddress } from './stellar.js';

export interface SliceFixture {
  id: number;
  creator: string;
  attestors: string[];
  /** One weight per attestor, in the same order as `attestors`. */
  weights: number[];
  /** Measured in weight units, not attestor count. */
  threshold: number;
  reputation_weighting_enabled: boolean;
}

let sliceSeq = 0;

/** Throw if a slice cannot be satisfied or is structurally inconsistent. */
export function assertSliceInvariants(slice: SliceFixture): void {
  if (slice.attestors.length === 0) {
    throw new Error('slice factory: a slice needs at least one attestor');
  }
  if (slice.weights.length !== slice.attestors.length) {
    throw new Error(
      `slice factory: weights (${slice.weights.length}) must match attestors (${slice.attestors.length})`,
    );
  }
  if (slice.weights.some(w => !Number.isInteger(w) || w < 0)) {
    throw new Error('slice factory: weights must be non-negative integers');
  }
  const totalWeight = slice.weights.reduce((sum, w) => sum + w, 0);
  if (slice.threshold < 1 || slice.threshold > totalWeight) {
    throw new Error(
      `slice factory: threshold ${slice.threshold} must be between 1 and total weight ${totalWeight}`,
    );
  }
}

/**
 * Build one slice. By default it has three attestors with equal weight 1 and
 * a threshold of 2 (a 2-of-3 quorum). Overrides replace any default field;
 * the result is validated before it is returned.
 */
export function buildSlice(overrides: Partial<SliceFixture> = {}): SliceFixture {
  sliceSeq += 1;
  const attestors = overrides.attestors ?? [nextStellarAddress(), nextStellarAddress(), nextStellarAddress()];
  const slice: SliceFixture = {
    id: sliceSeq,
    creator: nextStellarAddress(),
    attestors,
    weights: overrides.weights ?? attestors.map(() => 1),
    threshold: 2,
    reputation_weighting_enabled: false,
    ...overrides,
  };
  assertSliceInvariants(slice);
  return slice;
}

/** Build `count` slices, each with its own id, creator and attestors. */
export function buildSlices(count: number, overrides: Partial<SliceFixture> = {}): SliceFixture[] {
  return Array.from({ length: count }, () => buildSlice(overrides));
}

/** Reset the slice id sequence. */
export function resetSliceSequence(): void {
  sliceSeq = 0;
}
