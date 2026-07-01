import { Router, Request, Response } from 'express';
import { metricsStore } from '../services/metrics.js';

const router = Router();

// GET /api/issuer/:address/metrics?period_days=30
router.get('/:address/metrics', (req: Request, res: Response) => {
  const { address } = req.params;
  const periodDays = req.query.period_days ? parseInt(req.query.period_days as string, 10) : 30;

  if (!address) {
    res.status(400).json({ error: 'address parameter required' });
    return;
  }

  if (isNaN(periodDays) || periodDays < 1 || periodDays > 365) {
    res.status(400).json({ error: 'period_days must be between 1 and 365' });
    return;
  }

  const metrics = metricsStore.getIssuerMetrics(address, periodDays);
  res.json(metrics);
});

export default router;
