import { Router, Request, Response } from 'express';
import {
  metricsStore,
  CredentialEvent,
  buildMetricsQuery,
  buildEventLogQuery,
  buildAnomalyQuery,
  type AnomalyDetectionResult,
  type DailyMetrics,
  type IssuerMetrics,
} from '../services/metrics.js';
import { validate, schemas } from '../middleware/validate.js';

type SorobanClient = {
  simulateCall: (fn: string) => Promise<unknown>;
  u64Val: (n: number | bigint) => unknown;
  u32Val: (n: number) => unknown;
  addressVal: (a: string) => unknown;
};

export function createAnalyticsRouter(soroban: SorobanClient) {
  const router = Router();

  router.post('/events', validate(schemas.analyticsEvent), (req: Request, res: Response) => {
    const event: CredentialEvent = req.body;

    metricsStore.recordEvent(event);
    res.status(201).json({ success: true, event_id: event.credential_id });
  });

  router.get('/metrics', (req: Request, res: Response) => {
    try {
      const query = buildMetricsQuery(
        req.query.start_date as string | undefined,
        req.query.end_date as string | undefined
      );
      const metrics = metricsStore.getMetrics(query);
      res.json({
        start_date: query.startDate,
        end_date: query.endDate,
        metrics,
        summary: {
          total_issued: metrics.reduce((sum, m) => sum + m.issued_count, 0),
          total_attested: metrics.reduce((sum, m) => sum + m.attested_count, 0),
          total_revoked: metrics.reduce((sum, m) => sum + m.revoked_count, 0),
        },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Invalid query parameters';
      res.status(400).json({ error: message });
    }
  });

  router.get('/anomalies', (req: Request, res: Response) => {
    try {
      const threshold = req.query.threshold ? parseFloat(req.query.threshold as string) : undefined;
      const query = buildAnomalyQuery(
        req.query.start_date as string | undefined,
        req.query.end_date as string | undefined,
        threshold
      );
      const metrics = metricsStore.getMetrics({
        startDate: query.startDate,
        endDate: query.endDate,
      });
      const anomalies = metricsStore.detectAnomalies(metrics, query.threshold);

      const anomalousMetrics = metrics.filter((_, i) => anomalies[i]?.is_anomalous);

      res.json({
        start_date: query.startDate,
        end_date: query.endDate,
        threshold: query.threshold,
        total_anomalies: anomalousMetrics.length,
        anomalous_dates: anomalousMetrics.map((m, i) => ({
          date: m.date,
          issued_count: m.issued_count,
          anomaly_score: m.anomaly_score,
          anomaly_details: anomalies.find((a) => a.score === m.anomaly_score),
        })),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Invalid query parameters';
      res.status(400).json({ error: message });
    }
  });

  router.get('/events', (req: Request, res: Response) => {
    try {
      const query = buildEventLogQuery(
        req.query.start_date as string | undefined,
        req.query.end_date as string | undefined,
        req.query.type as string | undefined
      );
      const events = metricsStore.getEventLog(query);

      res.json({
        start_date: query.startDate,
        end_date: query.endDate,
        event_type_filter: query.type,
        total_events: events.length,
        events,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Invalid query parameters';
      res.status(400).json({ error: message });
    }
  });

  // GET /api/analytics/issuer/:address
  // Query params: period_days (default 30)
  router.get('/issuer/:address', (req: Request, res: Response) => {
    const { address } = req.params;
    const periodDays = req.query.period_days
      ? parseInt(req.query.period_days as string, 10)
      : 30;

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

  router.get('/summary', (req: Request, res: Response) => {
    const summary = metricsStore.getSummary();
    res.json({
      ...summary,
      generated_at: new Date().toISOString(),
    });
  });

  router.get('/health', (req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'analytics',
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}

// Default export using real soroban client
import { simulateCall, u64Val } from '../soroban.js';
export default createAnalyticsRouter({
  simulateCall,
  u64Val: u64Val as SorobanClient['u64Val'],
  u32Val: (n) => n,
  addressVal: (a) => a,
});
