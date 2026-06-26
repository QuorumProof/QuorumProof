import { Router, Request, Response } from 'express';
import type { simulateCall as SimulateCallType } from '../soroban.js';

export type SorobanClient = {
  simulateCall: typeof SimulateCallType;
  u64Val: (n: number | bigint) => ReturnType<typeof SimulateCallType>;
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

export function createSlicesRouter(soroban: SorobanClient) {
  const router = Router();

  /**
   * GET /api/slices/:id
   * Returns a single quorum slice by ID.
   */
  router.get('/:id', async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
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

      res.json({
        data: slices,
        pagination: {
          cursor: cursorQ ?? null,
          next_cursor: nextCursor,
          limit,
          total,
          has_more: hasMore,
        },
      });
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
