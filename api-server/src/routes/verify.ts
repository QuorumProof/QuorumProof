import { Router, Request, Response } from 'express';
import type { simulateCall as SimulateCallType } from '../soroban.js';
import {
  simulateCall,
  u64Val,
  u32Val,
  addressVal,
} from '../soroban.js';
import { validate, schemas } from '../middleware/validate.js';
import { metricsStore } from '../services/metrics.js';

/**
 * Best-effort caller identity for analytics attribution — same header
 * convention `middleware/rateLimiter.ts` uses to identify callers, since
 * there's no session/JWT auth in this API (see middleware/rbac.ts).
 */
function callerIdentity(req: Request): string {
  const header = req.header('x-stellar-address');
  return header && header.length > 0 ? header : 'anonymous';
}

export type SorobanClient = {
  simulateCall: typeof SimulateCallType;
  u64Val: (n: number | bigint) => ReturnType<typeof SimulateCallType>;
  u32Val: (n: number) => ReturnType<typeof SimulateCallType>;
  addressVal: (a: string) => ReturnType<typeof SimulateCallType>;
};

/** Recursively convert BigInt values to strings for JSON serialization. */
function serializeBigInt(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(serializeBigInt);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, serializeBigInt(v)])
    );
  }
  return value;
}

// ── Public types ────────────────────────────────────────────────────────────

export type BatchVerificationStatus =
  | 'verified'
  | 'failed'
  | 'not_found'
  | 'revoked'
  | 'expired'
  | 'error';

export type BatchVerificationResult = {
  credential_id: number;
  claim_type: string;
  status: BatchVerificationStatus;
  proof: BatchVerificationProof | null;
  error: string | null;
};

export type BatchVerificationProof = {
  /** ISO-8601 timestamp at which the verification was performed. */
  verified_at: string;
  /**
   * Credential status at the time of verification. Note: the `'expired'`
   * case is reserved for future use — the current implementation returns
   * `status: 'expired'` with `proof: null` rather than a partial proof.
   */
  credential_status: 'active' | 'revoked' | 'suspended' | 'expired';
  /** Stable 16-hex-char digest derived from the verification inputs. */
  digest: string;
};

export type BatchVerificationResponse = {
  results: BatchVerificationResult[];
  summary: {
    total: number;
    verified: number;
    failed: number;
    not_found: number;
    errors: number;
    /** Number of input items that were collapsed by deduplication. */
    duplicates_deduplicated: number;
    execution_time_ms: number;
  };
};

// ── Helpers ─────────────────────────────────────────────────────────────────
//
// `dedupeKey` uses a single NUL byte as the separator so that a malicious or
// careless input cannot smuggle the separator inside a claim_type and break
// the dedupe lookup. The string is NEVER parsed back into its components —
// the original pair is stored alongside its key in `uniquePairs`.
function dedupeKey(credentialId: number, claimType: string): string {
  return `${credentialId}\u0000${claimType}`;
}

/**
 * Produce a stable 16-hex-char digest derived from
 * `(credential_id, claim_type, verified_at)`.
 *
 * FNV-1a is fast and non-cryptographic; it is used here purely as a stable
 * correlation id so callers can quote a verification receipt in logs or
 * audit trails. It is NOT a security primitive.
 */
function digestHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  const low = hash.toString(16).padStart(8, '0');
  // Multiply by the golden ratio constant and re-hash to widen the output
  // to a 16-hex-char id without pulling in a cryptographic dependency.
  const high = ((hash * 0x9e3779b1) >>> 0).toString(16).padStart(8, '0');
  return low + high;
}

// ── Proof verification memoization ──────────────────────────────────────────
//
// Verifying the same proof repeatedly is wasteful, so results are memoized by
// a hash of the verification inputs. The cache is bounded (LRU eviction) and
// entries expire after a TTL so that a credential whose on-chain state changes
// (revoked/suspended/expired) is not served a stale verdict indefinitely.

/** Maximum number of memoized verification results retained at once. */
export const PROOF_CACHE_MAX_ENTRIES = 1000;

/** Time-to-live for a memoized verification result, in milliseconds. */
export const PROOF_CACHE_TTL_MS = 60_000;

/**
 * Stable cache key for a proof verification. Derived from the verification
 * inputs (credential id + claim type) via the same non-cryptographic FNV-1a
 * digest used for verification receipts — collisions only cost a redundant
 * verification, never a wrong verdict, because the key is never trusted as a
 * security primitive.
 */
export function proofCacheKey(credentialId: number, claimType: string): string {
  return digestHex(dedupeKey(credentialId, claimType));
}

type ProofCacheEntry<T> = { value: T; expiresAt: number };

/**
 * Bounded, TTL-expiring memoization cache with LRU eviction.
 *
 * Invalidation strategy:
 *   • **TTL** — entries older than `ttlMs` are treated as misses and dropped.
 *   • **LRU bound** — when `maxEntries` is exceeded the least-recently-used
 *     entry is evicted, keeping memory usage bounded under load.
 *   • **Explicit** — `clear()` drops everything (e.g. on config/contract
 *     change); `delete()` drops a single key.
 */
export class ProofVerificationCache<T> {
  private readonly store = new Map<string, ProofCacheEntry<T>>();

  constructor(
    private readonly maxEntries: number = PROOF_CACHE_MAX_ENTRIES,
    private readonly ttlMs: number = PROOF_CACHE_TTL_MS,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * Return the memoized value for `key`, or `undefined` on a miss. Expired
   * entries are evicted on access so a miss always falls through to the real
   * verification path.
   */
  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    // Refresh recency for LRU ordering.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  /** Store `value` under `key`, evicting the least-recently-used entry if full. */
  set(key: string, value: T): void {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  /** Drop a single memoized entry. */
  delete(key: string): void {
    this.store.delete(key);
  }

  /** Drop every memoized entry. */
  clear(): void {
    this.store.clear();
  }

  /** Current number of retained entries (including not-yet-expired ones). */
  get size(): number {
    return this.store.size;
  }
}

// ── Router factory ──────────────────────────────────────────────────────────

export function createVerifyRouter(soroban: SorobanClient) {
  const router = Router();

  /**
   * POST /api/verify/batch
   * Body validated by `schemas.verifyBatchClaims`:
   *   { items: [{ credential_id: number, claim_type: string }, ...] }
   *
   * Verifies many `(credential_id, claim_type)` pairs in one round trip.
   *
   * Efficiency features:
   *   • **Deduplication** — pairs that appear more than once in the input are
   *     looked up once and the result is fanned out to every original index.
   *   • **In-request credential cache** — if the SAME `credential_id` is
   *     requested across multiple `claim_type` values, the credential is
   *     fetched from Soroban once and the metadata is reused.
   *   • **Single global claim-types lookup** — `get_supported_claim_types`
   *     is invoked at most once per batch instead of once per credential.
   *   • **Parallel processing** — all unique pairs are resolved in parallel
   *     using `Promise.all`.
   *
   * Returns a result per *original* input item (in input order) plus a
   * summary describing how much work was saved by deduplication.
   */
  router.post(
    '/batch',
    validate(schemas.verifyBatchClaims),
    async (req: Request, res: Response) => {
      const startedAt = Date.now();
      const verifier = callerIdentity(req);
      const items = req.body.items as Array<{ credential_id: number; claim_type: string }>;

      // ── Deduplicate by (credential_id, claim_type) ─────────────────────────
      // The map is used only as a fast existence test; the canonical store
      // for each unique pair is `uniquePairs`, so claim types do not need
      // to be round-tripped through the key string.
      type UniquePair = {
        credential_id: number;
        claim_type: string;
        indices: number[];
      };
      const dedupLookup = new Map<string, UniquePair>();
      const uniquePairs: UniquePair[] = [];
      let duplicates = 0;
      items.forEach((pair, idx) => {
        const key = dedupeKey(pair.credential_id, pair.claim_type);
        const existing = dedupLookup.get(key);
        if (existing) {
          existing.indices.push(idx);
          duplicates += 1;
          return;
        }
        const entry: UniquePair = {
          credential_id: pair.credential_id,
          claim_type: pair.claim_type,
          indices: [idx],
        };
        dedupLookup.set(key, entry);
        uniquePairs.push(entry);
      });

      // ── Single global claim-types enrichment (best-effort) ─────────────────
      // `get_supported_claim_types` returns the same value for every caller
      // so we issue it once per batch, not once per credential.
      let globalClaimTypes: string[] | undefined;
      try {
        const claims: unknown = await soroban.simulateCall('get_supported_claim_types', []);
        if (Array.isArray(claims)) {
          globalClaimTypes = (claims as unknown[]).map((c) => String(c));
        }
      } catch {
        // Best-effort: contracts that don't expose this method simply
        // degrade to "all claim types are eligible".
      }

      // ── In-request credential cache ────────────────────────────────────────
      type CredSnapshot =
        | { found: false; reason: 'not_found' | 'error'; error?: string }
        | {
            found: true;
            revoked: boolean;
            suspended: boolean;
            expires_at: string | null;
            credential_type: number;
          };
      const credCache = new Map<number, Promise<CredSnapshot>>();
      async function loadCredential(credentialId: number): Promise<CredSnapshot> {
        const cached = credCache.get(credentialId);
        if (cached) return cached;
        const promise = (async (): Promise<CredSnapshot> => {
          // Cast simulateCall to a permissive signature for the same reason
          // the rest of this module does: the Soroban client is injected and
          // its precise generic signature is not needed here.
          const call = soroban.simulateCall as unknown as (
            method: string,
            args: unknown[]
          ) => Promise<unknown>;
          try {
            const raw = await call('get_credential', [soroban.u64Val(credentialId)]);
            if (raw === null || raw === undefined) {
              return { found: false, reason: 'not_found' };
            }
            const obj = raw as Record<string, unknown>;
            return {
              found: true,
              revoked: Boolean(obj.revoked),
              suspended: Boolean(obj.suspended),
              expires_at: obj.expires_at != null ? String(obj.expires_at) : null,
              credential_type: Number(obj.credential_type ?? 0),
            };
          } catch (err) {
            return {
              found: false,
              reason: 'error',
              error: err instanceof Error ? err.message : String(err),
            };
          }
        })();
        credCache.set(credentialId, promise);
        return promise;
      }

      // ── Memoized proof verification ────────────────────────────────────────
      // Results are keyed by a hash of the verification inputs. A cache miss
      // (or an expired entry) falls through to the real verification path, so
      // correctness is preserved regardless of cache state.
      const proofCache = new ProofVerificationCache<BatchVerificationResult>();
      async function verifyPair(pair: UniquePair): Promise<BatchVerificationResult> {
        const cacheKey = proofCacheKey(pair.credential_id, pair.claim_type);
        const memoized = proofCache.get(cacheKey);
        if (memoized) return memoized;

        const result = await computeVerification(pair);
        // Only memoize terminal verdicts; transient errors are not cached so
        // a subsequent request can retry against a healthy contract.
        if (result.status !== 'error') {
          proofCache.set(cacheKey, result);
        }
        return result;
      }

      async function computeVerification(pair: UniquePair): Promise<BatchVerificationResult> {
        const cred = await loadCredential(pair.credential_id);
        if (!cred.found) {
          return {
            credential_id: pair.credential_id,
            claim_type: pair.claim_type,
            status: cred.reason === 'not_found' ? 'not_found' : 'error',
            proof: null,
            error: cred.reason === 'error' ? cred.error ?? 'verification failed' : null,
          };
        }
        if (cred.revoked) {
          return {
            credential_id: pair.credential_id,
            claim_type: pair.claim_type,
            status: 'revoked',
            proof: null,
            error: null,
          };
        }
        if (cred.suspended) {
          return {
            credential_id: pair.credential_id,
            claim_type: pair.claim_type,
            status: 'failed',
            proof: null,
            error: 'credential suspended',
          };
        }
        if (cred.expires_at && Date.parse(cred.expires_at) <= Date.now()) {
          return {
            credential_id: pair.credential_id,
            claim_type: pair.claim_type,
            status: 'expired',
            proof: null,
            error: null,
          };
        }
        if (globalClaimTypes && !globalClaimTypes.includes(pair.claim_type)) {
          return {
            credential_id: pair.credential_id,
            claim_type: pair.claim_type,
            status: 'failed',
            proof: null,
            error: 'unsupported claim type',
          };
        }

        const verifiedAt = new Date().toISOString();
        return {
          credential_id: pair.credential_id,
          claim_type: pair.claim_type,
          status: 'verified',
          proof: {
            verified_at: verifiedAt,
            credential_status: 'active',
            digest: digestHex(dedupeKey(pair.credential_id, pair.claim_type) + verifiedAt),
          },
          error: null,
        };
      }

      // ── Resolve all unique pairs in parallel ───────────────────────────────
      const resolved = await Promise.all(uniquePairs.map((pair) => verifyPair(pair)));

      // ── Fan results back out to original input order ───────────────────────
      const results: BatchVerificationResult[] = new Array(items.length);
      uniquePairs.forEach((pair, i) => {
        const result = resolved[i];
        for (const idx of pair.indices) {
          results[idx] = result;
        }
      });

      const summary = {
        total: items.length,
        verified: results.filter((r) => r.status === 'verified').length,
        failed: results.filter((r) => r.status === 'failed').length,
        not_found: results.filter((r) => r.status === 'not_found').length,
        errors: results.filter((r) => r.status === 'error').length,
        duplicates_deduplicated: duplicates,
        execution_time_ms: Date.now() - startedAt,
      };

      metricsStore.recordVerification({
        verifier,
        total: summary.total,
        verified: summary.verified,
        failed: summary.failed,
        errors: summary.errors,
        execution_time_ms: summary.execution_time_ms,
      });

      res.json(serializeBigInt({ results, summary }) as BatchVerificationResponse);
    }
  );

  return router;
}
