import { Router, Request, Response } from 'express';
import type { simulateCall as SimulateCallType } from '../soroban.js';
import {
  simulateCall,
  u64Val,
  u32Val,
  addressVal,
} from '../soroban.js';
import { validate, schemas } from '../middleware/validate.js';

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
          // `credentials.ts` does it: `u64Val` is synchronous but the typed
          // surface in `SorobanClient` claims a Promise return.
          const sim = soroban.simulateCall as unknown as (
            method: string,
            args: unknown[]
          ) => Promise<unknown>;
          try {
            const cred = await sim('get_credential', [soroban.u64Val(credentialId)]);
            const record = serializeBigInt(cred) as Record<string, unknown>;
            return {
              found: true,
              revoked: Boolean(record.revoked),
              suspended: Boolean(record.suspended),
              expires_at: (record.expires_at as string | null | undefined) ?? null,
              credential_type: Number(record.credential_type ?? 0),
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (
              msg.toLowerCase().includes('credentialnotfound') ||
              msg.toLowerCase().includes('not found')
            ) {
              return { found: false, reason: 'not_found' };
            }
            return { found: false, reason: 'error', error: msg };
          }
        })();
        credCache.set(credentialId, promise);
        return promise;
      }

      // ── Process each unique pair in parallel ────────────────────────────────
      const uniqueResults: BatchVerificationResult[] = await Promise.all(
        uniquePairs.map(async (pair): Promise<BatchVerificationResult> => {
          const credential = await loadCredential(pair.credential_id);

          if (!credential.found) {
            return {
              credential_id: pair.credential_id,
              claim_type: pair.claim_type,
              status: credential.reason === 'not_found' ? 'not_found' : 'error',
              proof: null,
              error: credential.reason === 'error' ? credential.error ?? 'lookup failed' : null,
            };
          }

          if (credential.revoked) {
            return {
              credential_id: pair.credential_id,
              claim_type: pair.claim_type,
              status: 'revoked',
              proof: null,
              error: null,
            };
          }

          const expiresAt = credential.expires_at ? new Date(credential.expires_at) : null;
          if (expiresAt && !isNaN(expiresAt.getTime()) && expiresAt.getTime() < Date.now()) {
            return {
              credential_id: pair.credential_id,
              claim_type: pair.claim_type,
              status: 'expired',
              proof: null,
              error: null,
            };
          }

          const claimSupported = globalClaimTypes
            ? globalClaimTypes.some(
                (supported) =>
                  supported.toLowerCase() === pair.claim_type.toLowerCase()
              )
            : true;
          if (!claimSupported) {
            return {
              credential_id: pair.credential_id,
              claim_type: pair.claim_type,
              status: 'failed',
              proof: null,
              error: null,
            };
          }

          const verifiedAt = new Date().toISOString();
          const credentialStatus: BatchVerificationProof['credential_status'] = credential.suspended
            ? 'suspended'
            : credential.revoked
              ? 'revoked'
              : 'active';

          return {
            credential_id: pair.credential_id,
            claim_type: pair.claim_type,
            status: 'verified',
            proof: {
              verified_at: verifiedAt,
              credential_status: credentialStatus,
              digest: digestHex(
                `${pair.credential_id}\u0000${pair.claim_type}\u0000${verifiedAt}`
              ),
            },
            error: null,
          };
        })
      );

      // ── Fan out: produce per-input results, preserving order ───────────────
      const finalResults: BatchVerificationResult[] = new Array(items.length);
      uniquePairs.forEach((pair, idx) => {
        const result = uniqueResults[idx];
        for (const originalIdx of pair.indices) {
          finalResults[originalIdx] = { ...result };
        }
      });

      res.json({
        results: finalResults,
        summary: {
          total: finalResults.length,
          verified: finalResults.filter((r) => r.status === 'verified').length,
          failed: finalResults.filter((r) => r.status === 'failed').length,
          not_found: finalResults.filter((r) => r.status === 'not_found').length,
          errors: finalResults.filter((r) => r.status === 'error').length,
          duplicates_deduplicated: duplicates,
          execution_time_ms: Date.now() - startedAt,
        },
      });
    }
  );

  return router;
}

// Default export using the real Soroban client so the router can be
// mounted directly in `index.ts` without any extra wiring.
export default createVerifyRouter({
  simulateCall,
  u64Val: u64Val as unknown as SorobanClient['u64Val'],
  u32Val: u32Val as unknown as SorobanClient['u32Val'],
  addressVal: addressVal as unknown as SorobanClient['addressVal'],
});
