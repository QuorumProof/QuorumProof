/**
 * Gas cost reporting routes — Issue #4.
 * Exposes the per-operation cost data recorded by gasCostTracker.ts.
 * Error responses now use the shared RFC 9457 Problem Details formatter (Issue #1428).
 */
import { Router, Request, Response } from 'express';
import { getDefaultGasCostTracker } from '../services/gasCostTracker.js';
import { problemJson } from '../middleware/problemDetails.js';

const router = Router();

// GET /api/costs/report — aggregated gas cost report across all tracked operations
router.get('/report', (_req: Request, res: Response) => {
  res.json(getDefaultGasCostTracker().getReport());
});

// GET /api/costs/optimizations — ranked list of operations worth optimizing
router.get('/optimizations', (req: Request, res: Response) => {
  const topN = parseInt((req.query.top as string) ?? '5', 10);
  res.json({ recommendations: getDefaultGasCostTracker().getOptimizationRecommendations(Number.isFinite(topN) ? topN : 5) });
});

// GET /api/costs/projection?operation=is_attested&callsPerDay=10000&days=30
router.get('/projection', (req: Request, res: Response) => {
  const { operation, callsPerDay, days } = req.query as Record<string, string | undefined>;
  if (!operation) {
    res.status(400).json(problemJson(400, 'missing-parameter', 'operation query param is required'));
    return;
  }
  const parsedCallsPerDay = parseFloat(callsPerDay ?? '');
  const parsedDays = parseFloat(days ?? '30');
  if (!Number.isFinite(parsedCallsPerDay) || parsedCallsPerDay <= 0) {
    res.status(400).json(problemJson(400, 'invalid-parameter', 'callsPerDay must be a positive number'));
    return;
  }

  const projection = getDefaultGasCostTracker().project(operation, parsedCallsPerDay, Number.isFinite(parsedDays) ? parsedDays : 30);
  if (!projection) {
    res.status(404).json(problemJson(404, 'not-found', `No recorded cost data for operation "${operation}" yet`));
    return;
  }
  res.json(projection);
});

export default router;
