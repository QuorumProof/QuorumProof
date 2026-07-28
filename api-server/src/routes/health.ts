import { Router, Request, Response } from 'express';
import { healthCheckManager } from '../services/healthCheck.js';

const router = Router();

// GET /health - Basic health status
router.get('/', async (_req: Request, res: Response) => {
  const status = await healthCheckManager.getHealthStatus();

  if (status.status === 'unhealthy') {
    res.status(503).json(status);
  } else if (status.status === 'degraded') {
    res.status(200).json(status);
  } else {
    res.status(200).json(status);
  }
});

// GET /health/ready - Readiness probe
router.get('/ready', async (_req: Request, res: Response) => {
  const status = await healthCheckManager.getReadinessStatus();

  if (!status.ready) {
    res.status(503).json(status);
  } else {
    res.status(200).json(status);
  }
});

// GET /health/live - Liveness probe
router.get('/live', (_req: Request, res: Response) => {
  const status = healthCheckManager.getLivenessStatus();
  res.status(200).json(status);
});

export default router;
