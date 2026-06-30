import type { AttestorEntry } from './sliceBuilderUtils';
import { totalWeight } from './sliceBuilderUtils';

/**
 * Slice simulation logic.
 *
 * A quorum slice reaches consensus when the combined weight of the attestors
 * that actually sign meets or exceeds the configured threshold. These pure
 * helpers let the UI preview the outcome of a given signing scenario and
 * summarise how robust a slice configuration is, before it is created on-chain.
 */

/** Above this attestor count, exhaustive 2^n enumeration is skipped. */
export const MAX_ENUM_ATTESTORS = 16;

export interface ScenarioResult {
  signedWeight: number;
  totalWeight: number;
  threshold: number;
  /** True when the signed weight meets the threshold for a non-empty slice. */
  success: boolean;
  /** Weight still required to reach the threshold (0 once met). */
  deficit: number;
  /** Weight signed beyond the threshold (0 while unmet). */
  surplus: number;
  /** Signed weight as a percentage of the threshold. */
  percentOfThreshold: number;
}

/** Combined weight of the attestors whose ids are in `signed`. */
export function signedWeight(attestors: AttestorEntry[], signed: ReadonlySet<string>): number {
  return attestors.reduce((sum, a) => (signed.has(a.id) ? sum + a.weight : sum), 0);
}

/** Evaluate a single signing scenario against the threshold. */
export function evaluateScenario(
  attestors: AttestorEntry[],
  threshold: number,
  signed: ReadonlySet<string>,
): ScenarioResult {
  const sw = signedWeight(attestors, signed);
  const tw = totalWeight(attestors);
  const success = attestors.length > 0 && threshold >= 1 && sw >= threshold;
  return {
    signedWeight: sw,
    totalWeight: tw,
    threshold,
    success,
    deficit: success ? 0 : Math.max(0, threshold - sw),
    surplus: success ? sw - threshold : 0,
    percentOfThreshold: threshold > 0 ? Math.round((sw / threshold) * 100) : 0,
  };
}

export interface ScenarioStats {
  /** Number of distinct signing combinations considered (2^n, includes empty). */
  totalScenarios: number;
  /** Combinations whose signed weight meets the threshold. */
  winningScenarios: number;
  losingScenarios: number;
  /** Winning combinations as a percentage of all combinations. */
  winRatePct: number;
  /** False when the slice has too many attestors to enumerate exhaustively. */
  enumerated: boolean;
}

/**
 * Enumerate every subset of attestors (each either signs or does not) and count
 * how many combinations reach consensus. Gives a quick sense of how forgiving a
 * configuration is. Skipped above {@link MAX_ENUM_ATTESTORS}.
 */
export function scenarioStats(attestors: AttestorEntry[], threshold: number): ScenarioStats {
  const n = attestors.length;
  if (n === 0 || threshold < 1) {
    return {
      totalScenarios: n === 0 ? 0 : 1 << n,
      winningScenarios: 0,
      losingScenarios: n === 0 ? 0 : 1 << n,
      winRatePct: 0,
      enumerated: n <= MAX_ENUM_ATTESTORS,
    };
  }
  if (n > MAX_ENUM_ATTESTORS) {
    return {
      totalScenarios: 0,
      winningScenarios: 0,
      losingScenarios: 0,
      winRatePct: 0,
      enumerated: false,
    };
  }

  const total = 1 << n;
  let winning = 0;
  for (let mask = 0; mask < total; mask++) {
    let weight = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) weight += attestors[i].weight;
    }
    if (weight >= threshold) winning++;
  }
  return {
    totalScenarios: total,
    winningScenarios: winning,
    losingScenarios: total - winning,
    winRatePct: Math.round((winning / total) * 100),
    enumerated: true,
  };
}

/**
 * Maximum number of attestors that can be unavailable while the remaining set
 * can still reach the threshold, assuming the most impactful (highest-weight)
 * attestors are the ones lost. A higher number means a more resilient slice.
 */
export function faultTolerance(attestors: AttestorEntry[], threshold: number): number {
  const tw = totalWeight(attestors);
  if (attestors.length === 0 || threshold < 1 || tw < threshold) return 0;

  const byWeightDesc = [...attestors].sort((a, b) => b.weight - a.weight);
  let removed = 0;
  let remaining = tw;
  for (const a of byWeightDesc) {
    if (remaining - a.weight >= threshold) {
      remaining -= a.weight;
      removed++;
    } else {
      break;
    }
  }
  return removed;
}

/**
 * Minimal winning coalitions: signer sets that reach the threshold but where
 * dropping any single member would fall short. These are the "just enough"
 * scenarios worth previewing. Capped to keep the list readable, and skipped
 * above {@link MAX_ENUM_ATTESTORS}.
 */
export function minimalWinningCoalitions(
  attestors: AttestorEntry[],
  threshold: number,
  cap = 20,
): AttestorEntry[][] {
  const n = attestors.length;
  if (n === 0 || threshold < 1 || n > MAX_ENUM_ATTESTORS) return [];

  const result: AttestorEntry[][] = [];
  for (let mask = 1; mask < 1 << n && result.length < cap; mask++) {
    let weight = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) weight += attestors[i].weight;
    }
    if (weight < threshold) continue;

    let minimal = true;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i) && weight - attestors[i].weight >= threshold) {
        minimal = false;
        break;
      }
    }
    if (minimal) {
      const members: AttestorEntry[] = [];
      for (let i = 0; i < n; i++) {
        if (mask & (1 << i)) members.push(attestors[i]);
      }
      result.push(members);
    }
  }
  return result;
}
