/**
 * #1568 — Proof Verification Memoization Service
 *
 * The API receives the same proof (credential_id × claim_type × proof bytes)
 * many times — e.g. repeated calls from the same verifier within a short
 * window.  Re-running the full on-chain ZK verification for every duplicate
 * is expensive.  This service provides a hash-keyed in-process cache so
 * identical proofs return instantly from memory.
 *
 * Design
 * ──────
 * • Cache key  : SHA-256-like FNV-1a 64-bit hash over the canonical
 *               serialisation of (credential_id ‖ claim_type ‖ proof_bytes).
 *               Using a fast non-crypto hash is acceptable because the
 *               cache is not a security boundary — the on-chain verifier
 *               is still called on cache-miss, and the cached value can
 *               only be a previously verified result.
 * • TTL         : Each entry has a configurable time-to-live (default 5 min).
 *               Expired entries are evicted lazily on read and proactively
 *               by a periodic sweep.
 * • Size cap    : When the entry count exceeds `maxEntries` the oldest
 *               entries are evicted first (insertion-order LRU via Map).
 * • Invalidation: Callers can invalidate by credential ID (e.g. on revocation
 *               or state change) or flush the entire cache.
 *
 * The service is a singleton by default (getDefaultProofMemoizationService)
 * but individual instances can be created for testing.
 */

// ── Types ────────────────────────────────────────────────────────────────────

/** The cached result of a single proof verification. */
export interface MemoizedProofResult {
  /** The verification outcome returned by the on-chain verifier. */
  verified: boolean;
  /** ISO-8601 timestamp at which the result was computed and cached. */
  cachedAt: string;
  /** Absolute epoch-ms at which this entry expires. */
  expiresAt: number;
  /** The credential ID this proof belongs to. */
  credentialId: number;
  /** The claim type that was verified. */
  claimType: string;
}

/** Cache statistics snapshot. */
export interface ProofMemoStats {
  /** Number of live (non-expired) entries. */
  size: number;
  /** Total lookup hits since last reset. */
  hits: number;
  /** Total lookup misses since last reset. */
  misses: number;
  /** Total entries evicted due to size cap. */
  sizeEvictions: number;
  /** Total entries evicted due to TTL expiry. */
  ttlEvictions: number;
  /** Hit rate in the range [0, 1]. */
  hitRate: number;
}

export interface ProofMemoizationOptions {
  /**
   * Time-to-live for each cache entry, in milliseconds.
   * @default 300_000 (5 minutes)
   */
  ttlMs?: number;
  /**
   * Maximum number of entries to hold in memory before evicting the oldest.
   * @default 10_000
   */
  maxEntries?: number;
  /**
   * Interval between proactive TTL sweeps, in milliseconds.
   * Set to 0 to disable the background sweep (entries still expire lazily).
   * @default 60_000 (1 minute)
   */
  sweepIntervalMs?: number;
}

// ── Fast hash helper ─────────────────────────────────────────────────────────

/**
 * FNV-1a 64-bit hash emulated with two 32-bit accumulators (JavaScript
 * does not have native 64-bit integers).  Fast enough for cache keying;
 * NOT suitable for cryptographic use.
 */
function fnv1a64(input: string): string {
  let lo = 0x811c9dc5;
  let hi = 0x84222325;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    // XOR with byte
    lo ^= code & 0xff;
    // FNV multiply: 0x00000100_000001b3
    // Split: hi = hi * 0x01000000 + lo * 0x1b3 >> 32  (approximate)
    const newLo = (lo * 0x01000193) >>> 0;
    hi = ((hi * 0x01000193) + Math.imul(lo, 0x01000193 >>> 0)) >>> 0;
    lo = newLo;
  }
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

/**
 * Build the canonical cache key for a proof verification request.
 *
 * The key is a 16-char hex string derived from (credentialId, claimType,
 * proofBytes).  proofBytes may be a string, Uint8Array, or any JSON-able
 * value — it is stringified before hashing.
 */
export function buildProofCacheKey(
  credentialId: number,
  claimType: string,
  proofBytes: unknown,
): string {
  const proofStr =
    proofBytes instanceof Uint8Array
      ? Buffer.from(proofBytes).toString('hex')
      : typeof proofBytes === 'string'
        ? proofBytes
        : JSON.stringify(proofBytes);
  const canonical = `${credentialId}\u0000${claimType}\u0000${proofStr}`;
  return fnv1a64(canonical);
}

// ── Cache implementation ─────────────────────────────────────────────────────

export class ProofMemoizationService {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly cache: Map<string, MemoizedProofResult>;

  // Stats (never reset automatically; call resetStats() explicitly)
  private _hits = 0;
  private _misses = 0;
  private _sizeEvictions = 0;
  private _ttlEvictions = 0;

  // Per-credential index: maps credentialId → Set of cache keys
  // Used for efficient invalidation by credential ID.
  private readonly credentialIndex: Map<number, Set<string>>;

  private _sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: ProofMemoizationOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 300_000;
    this.maxEntries = opts.maxEntries ?? 10_000;
    this.cache = new Map();
    this.credentialIndex = new Map();

    const sweepIntervalMs = opts.sweepIntervalMs ?? 60_000;
    if (sweepIntervalMs > 0) {
      this._sweepTimer = setInterval(() => this._sweepExpired(), sweepIntervalMs);
      // Do not keep the process alive for the sweep alone.
      if (this._sweepTimer.unref) this._sweepTimer.unref();
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Look up a cached result.  Returns `undefined` on cache miss or if the
   * entry has expired (it is evicted in that case).
   */
  get(key: string): MemoizedProofResult | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      this._misses++;
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this._evictKey(key, 'ttl');
      this._misses++;
      return undefined;
    }
    this._hits++;
    return entry;
  }

  /**
   * Store a verification result.  If the cache is at capacity, the oldest
   * entry (first inserted) is evicted first.
   */
  set(
    key: string,
    credentialId: number,
    claimType: string,
    verified: boolean,
  ): void {
    // Evict oldest entry when at capacity (and this key is not already present)
    if (!this.cache.has(key) && this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (oldestKey !== undefined) {
        this._evictKey(oldestKey, 'size');
      }
    }

    const now = Date.now();
    const entry: MemoizedProofResult = {
      verified,
      cachedAt: new Date(now).toISOString(),
      expiresAt: now + this.ttlMs,
      credentialId,
      claimType,
    };
    this.cache.set(key, entry);

    // Update per-credential index
    let keys = this.credentialIndex.get(credentialId);
    if (!keys) {
      keys = new Set();
      this.credentialIndex.set(credentialId, keys);
    }
    keys.add(key);
  }

  /**
   * Invalidate all cached results for a given credential ID.
   * Call this whenever a credential's state changes (revocation, suspension,
   * metadata update, etc.) so stale cached verifications are not served.
   */
  invalidateByCredentialId(credentialId: number): number {
    const keys = this.credentialIndex.get(credentialId);
    if (!keys) return 0;
    let evicted = 0;
    for (const key of keys) {
      if (this.cache.delete(key)) evicted++;
    }
    this.credentialIndex.delete(credentialId);
    return evicted;
  }

  /**
   * Flush every entry from the cache and reset all counters.
   */
  clear(): void {
    this.cache.clear();
    this.credentialIndex.clear();
    this.resetStats();
  }

  /**
   * Return a snapshot of current cache statistics.
   */
  getStats(): ProofMemoStats {
    const total = this._hits + this._misses;
    return {
      size: this.cache.size,
      hits: this._hits,
      misses: this._misses,
      sizeEvictions: this._sizeEvictions,
      ttlEvictions: this._ttlEvictions,
      hitRate: total === 0 ? 0 : this._hits / total,
    };
  }

  /**
   * Reset hit/miss/eviction counters without clearing the cache entries.
   */
  resetStats(): void {
    this._hits = 0;
    this._misses = 0;
    this._sizeEvictions = 0;
    this._ttlEvictions = 0;
  }

  /**
   * Gracefully stop the background sweep timer.  Call this when the service
   * instance is no longer needed (e.g. in tests or on shutdown) to avoid
   * keeping the event loop alive.
   */
  destroy(): void {
    if (this._sweepTimer !== null) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  private _evictKey(key: string, reason: 'ttl' | 'size'): void {
    const entry = this.cache.get(key);
    if (!entry) return;
    this.cache.delete(key);
    const keys = this.credentialIndex.get(entry.credentialId);
    if (keys) {
      keys.delete(key);
      if (keys.size === 0) this.credentialIndex.delete(entry.credentialId);
    }
    if (reason === 'ttl') this._ttlEvictions++;
    else this._sizeEvictions++;
  }

  /**
   * Proactive sweep: iterate the entire cache and evict expired entries.
   * Runs on the background interval timer.
   */
  private _sweepExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this._evictKey(key, 'ttl');
      }
    }
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _default: ProofMemoizationService | null = null;

export function getDefaultProofMemoizationService(): ProofMemoizationService {
  if (!_default) {
    _default = new ProofMemoizationService({
      ttlMs: parseInt(process.env.PROOF_MEMO_TTL_MS ?? '300000', 10),
      maxEntries: parseInt(process.env.PROOF_MEMO_MAX_ENTRIES ?? '10000', 10),
      sweepIntervalMs: parseInt(process.env.PROOF_MEMO_SWEEP_MS ?? '60000', 10),
    });
  }
  return _default;
}

/** Replace the default instance (for testing). */
export function _setDefaultProofMemoizationServiceForTest(
  svc: ProofMemoizationService | null,
): void {
  _default = svc;
}
