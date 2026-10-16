import { Router, Request, Response } from 'express';
import { getDefaultRegionFailoverDetector, RegionFailoverDetector } from '../services/regionFailover.js';

/**
 * #1650 Multi-region failover status.
 *
 *   GET /health/region          JSON status (role, peer state, failoverActive)
 *   GET /health/region/metrics  Prometheus metrics
 *
 * Deliberately NOT part of /health/ready: an unhealthy peer must never make
 * this region fail its own readiness check, or both regions could be pulled
 * out of DNS at once.
 */
export function createRegionRouter(detector: RegionFailoverDetector = getDefaultRegionFailoverDetector()): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    res.status(200).json({ enabled: detector.enabled, ...detector.getStatus() });
  });

  router.get('/metrics', (_req: Request, res: Response) => {
    res.type('text/plain; version=0.0.4').send(detector.getPrometheusMetrics());
  });

  return router;
}
