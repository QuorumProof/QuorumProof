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
   * GET /api/slices?page=1&page_size=20
   * Returns paginated list of quorum slices.
   */
  router.get('/', async (req: Request, res: Response) => {
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.page_size ?? '20'), 10) || 20));

    try {
      const sliceCount: bigint = await soroban.simulateCall('get_slice_count', []);
      const total = Number(sliceCount);
      const start = (page - 1) * pageSize + 1;
      const end = Math.min(start + pageSize - 1, total);

      const slices = [];
      for (let i = start; i <= end; i++) {
        try {
          const slice = await soroban.simulateCall('get_slice', [soroban.u64Val(i)]);
          slices.push(serializeBigInt(slice));
        } catch {
          // skip missing slices
        }
      }

      res.json({
        data: slices,
        pagination: { page, page_size: pageSize, total },
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
