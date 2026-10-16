import { Router, Request, Response } from 'express';
import type { simulateCall as SimulateCallType } from '../soroban.js';
import { respondNegotiated } from '../middleware/contentNegotiation.js';

export type SorobanClient = {
  simulateCall: typeof SimulateCallType;
  u64Val: (n: number | bigint) => any;
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

/**
 * Cache for slice verification results, keyed by slice identity + version.
 * Verification is expensive to recompute on every query, so results are
 * memoized and invalidated whenever the underlying slice is updated.
 */
export class SliceVerificationCache {
  private cache = new Map<string, unknown>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  private static key(id: number, version: number | string): string {
    return `${id}:${version}`;
  }

  get(id: number, version: number | string): unknown | undefined {
    const key = SliceVerificationCache.key(id, version);
    if (this.cache.has(key)) {
      this.hits++;
      return this.cache.get(key);
    }
    this.misses++;
    return undefined;
  }

  set(id: number, version: number | string, result: unknown): void {
    this.cache.set(SliceVerificationCache.key(id, version), result);
  }

  /** Invalidate all cached verification results for a slice (any version). */
  invalidate(id: number): void {
    const prefix = `${id}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
        this.evictions++;
      }
    }
  }

  clear(): void {
    this.evictions += this.cache.size;
    this.cache.clear();
  }

  metrics(): { hits: number; misses: number; evictions: number; size: number } {
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      size: this.cache.size,
    };
  }
}

/** Extract a version marker from a slice payload, falling back to a stable default. */
function sliceVersion(slice: unknown): number | string {
  if (slice !== null && typeof slice === 'object') {
    const rec = slice as Record<string, unknown>;
    const v = rec.version ?? rec.updated_at ?? rec.updatedAt;
    if (typeof v === 'number' || typeof v === 'string') return v;
  }
  return 0;
}

export function createSlicesRouter(soroban: SorobanClient) {
  const router = Router();
  const verificationCache = new SliceVerificationCache();

  /**
   * GET /api/slices/:id
   * Returns a single quorum slice by ID.
   */
  router.get('/:id', async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string, 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid slice ID' });
      return;
    }
    try {
      const slice = await soroban.simulateCall('get_slice', [soroban.u64Val(id)]);
      res.json(serializeBigInt(slice));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('SliceNotFound') || msg.includes('not found')) {
        res.status(404).json({ error: 'Slice not found' });
      } else {
        res.status(500).json({ error: msg });
      }
    }
  });

  /**
   * GET /api/slices/:id/verification
   * Returns the verification result for a slice, served from cache when the
   * slice version is unchanged. Cache is invalidated on slice update.
   */
  router.get('/:id/verification', async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string, 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid slice ID' });
      return;
    }
    try {
      const slice = await soroban.simulateCall('get_slice', [soroban.u64Val(id)]);
      const version = sliceVersion(slice);

      const cached = verificationCache.get(id, version);
      if (cached !== undefined) {
        res.json({ data: serializeBigInt(cached), cached: true });
        return;
      }

      const verification = await soroban.simulateCall('verify_slice', [soroban.u64Val(id)]);
      verificationCache.set(id, version, verification);
      res.json({ data: serializeBigInt(verification), cached: false });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('SliceNotFound') || msg.includes('not found')) {
        res.status(404).json({ error: 'Slice not found' });
      } else {
        res.status(500).json({ error: msg });
      }
    }
  });

  /**
   * POST /api/slices/:id/invalidate
   * Invalidates cached verification results for a slice after an update.
   */
  router.post('/:id/invalidate', (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string, 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid slice ID' });
      return;
    }
    verificationCache.invalidate(id);
    res.json({ invalidated: true, metrics: verificationCache.metrics() });
  });

  /**
   * GET /api/slices/verification/metrics
   * Exposes cache hit/miss/eviction metrics.
   */
  router.get('/verification/metrics', (_req: Request, res: Response) => {
    res.json(verificationCache.metrics());
  });

  /**
   * GET /api/slices?cursor=<base64>&limit=20
   * Returns cursor-paginated list of quorum slices.
   */
  router.get('/', async (req: Request, res: Response) => {
    const cursorQ = req.query.cursor ? String(req.query.cursor) : undefined;
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20));

    let startId = 1;
    if (cursorQ) {
      try {
        const decoded = Buffer.from(cursorQ, 'base64').toString('utf-8');
        startId = parseInt(decoded, 10) + 1;
        if (isNaN(startId) || startId < 1) startId = 1;
      } catch {
        res.status(400).json({ error: 'Invalid cursor' });
        return;
      }
    }

    try {
      const sliceCount: bigint = await soroban.simulateCall('get_slice_count', []);
      const total = Number(sliceCount);
      const end = Math.min(startId + limit - 1, total);

      const slices = [];
      for (let i = startId; i <= end; i++) {
        try {
          const slice = await soroban.simulateCall('get_slice', [soroban.u64Val(i)]);
          slices.push(serializeBigInt(slice));
        } catch {
          // skip missing slices
        }
      }

      const hasMore = end < total;
      const nextCursor = hasMore && slices.length > 0
        ? Buffer.from(String(end)).toString('base64')
        : null;

      const payload = {
        data: slices,
        pagination: {
          cursor: cursorQ ?? null,
          next_cursor: nextCursor,
          limit,
          total,
          has_more: hasMore,
        },
      };
      respondNegotiated(req, res, payload, { rootElement: 'slices', itemElement: 'slice' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}

// Default export using real soroban client
import { simulateCall, u64Val } from '../soroban.js';
export default createSlicesRouter({ simulateCall, u64Val: u64Val as SorobanClient['u64Val'] });
