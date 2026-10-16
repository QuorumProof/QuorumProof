/**
 * Proof verification memoization cache.
 *
 * Verifying the same proof multiple times is redundant work. This module
 * memoizes verification results keyed by a hash of the proof payload so that
 * repeated verifications of an identical proof are served from an in-memory
 * cache instead of re-running the (potentially expensive) verifier.
 *
 * Design notes:
 * - Keyed by a stable hash of the proof (see {@link hashProof}).
 * - Bounded: the cache never holds more than `maxSize` entries. When full,
 *   the least-recently-used entry is evicted (LRU).
 * - Invalidatable: entries can be dropped individually, by predicate, or the
 *   whole cache can be cleared (e.g. when the verifier/keys change).
 * - Correct under misses: a cache miss always falls through to the real
 *   verifier and the result is stored for subsequent calls.
 */

export interface ProofVerificationResult {
  valid: boolean;
  /** Optional verifier-specific detail (e.g. error message). */
  reason?: string;
}

/**
 * A verifier function: given a proof payload, returns whether it is valid.
 * May be synchronous or asynchronous.
 */
export type ProofVerifier<T = unknown> = (
  proof: T,
) => ProofVerificationResult | Promise<ProofVerificationResult>;

export interface ProofVerificationCacheOptions {
  /** Maximum number of cached entries. Defaults to 1000. */
  maxSize?: number;
  /**
   * Optional TTL in milliseconds. Entries older than this are treated as
   * misses and re-verified. When omitted, entries do not expire by time.
   */
  ttlMs?: number;
}

interface CacheEntry {
  result: ProofVerificationResult;
  /** Timestamp (ms) when the entry was stored. */
  storedAt: number;
}

/**
 * Compute a stable hash for a proof payload.
 *
 * Uses a deterministic JSON serialization (object keys sorted) so that
 * structurally identical proofs hash to the same key regardless of key order.
 * Falls back to a string representation for non-serializable values.
 */
export function hashProof(proof: unknown): string {
  return stableStringify(proof);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map(
    (key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`,
  );
  return `{${parts.join(",")}}`;
}

/**
 * Bounded, LRU proof-verification memoization cache.
 */
export class ProofVerificationCache {
  private readonly maxSize: number;
  private readonly ttlMs?: number;
  /** Map preserves insertion order; we re-insert on access to track LRU. */
  private readonly entries = new Map<string, CacheEntry>();

  constructor(options: ProofVerificationCacheOptions = {}) {
    const maxSize = options.maxSize ?? 1000;
    if (!Number.isFinite(maxSize) || maxSize < 1) {
      throw new Error("ProofVerificationCache: maxSize must be >= 1");
    }
    this.maxSize = Math.floor(maxSize);
    this.ttlMs = options.ttlMs;
  }

  /** Current number of cached entries. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Look up a cached verification result for the given proof.
   * Returns `undefined` on a miss (including expired entries).
   */
  get(proof: unknown): ProofVerificationResult | undefined {
    const key = hashProof(proof);
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (this.isExpired(entry)) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh LRU position.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.result;
  }

  /** Store a verification result for the given proof. */
  set(proof: unknown, result: ProofVerificationResult): void {
    const key = hashProof(proof);
    // Delete first so re-insertion refreshes LRU position.
    this.entries.delete(key);
    this.entries.set(key, { result, storedAt: Date.now() });
    this.evictIfNeeded();
  }

  /** Remove a single proof's cached result. */
  invalidate(proof: unknown): boolean {
    return this.entries.delete(hashProof(proof));
  }

  /**
   * Remove all entries matching a predicate over the cached result.
   * Useful when a verifier or its keys change and only some results are stale.
   */
  invalidateWhere(
    predicate: (result: ProofVerificationResult) => boolean,
  ): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (predicate(entry.result)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Clear the entire cache (e.g. on verifier/key rotation). */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Verify a proof, memoizing the result.
   *
   * On a cache hit the stored result is returned without invoking `verifier`.
   * On a miss (or expired entry) the real `verifier` is called and its result
   * is cached before being returned.
   */
  async verify<T>(
    proof: T,
    verifier: ProofVerifier<T>,
  ): Promise<ProofVerificationResult> {
    const cached = this.get(proof);
    if (cached !== undefined) {
      return cached;
    }
    const result = await verifier(proof);
    this.set(proof, result);
    return result;
  }

  private isExpired(entry: CacheEntry): boolean {
    if (this.ttlMs === undefined) {
      return false;
    }
    return Date.now() - entry.storedAt >= this.ttlMs;
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.maxSize) {
      // Map iteration order is insertion order; the first key is the LRU.
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
  }
}

/**
 * Convenience factory for a memoized verifier backed by a shared cache.
 */
export function memoizeProofVerification<T>(
  verifier: ProofVerifier<T>,
  options: ProofVerificationCacheOptions = {},
): { verify: (proof: T) => Promise<ProofVerificationResult>; cache: ProofVerificationCache } {
  const cache = new ProofVerificationCache(options);
  return {
    verify: (proof: T) => cache.verify(proof, verifier),
    cache,
  };
}
