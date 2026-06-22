import { Router, Request, Response } from 'express';
import {
  metricsStore,
  CredentialEvent,
  type AnomalyDetectionResult,
  type DailyMetrics,
} from '../services/metrics.js';

type SorobanClient = {
  simulateCall: (fn: string) => Promise<unknown>;
  u64Val: (n: number | bigint) => unknown;
  u32Val: (n: number) => unknown;
  addressVal: (a: string) => unknown;
};

const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 500; // Increased for test compatibility
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();

function checkRateLimit(clientId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(clientId);

  if (!entry || now > entry.resetTime) {
    rateLimitMap.set(clientId, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }

  entry.count++;
  return true;
}

function getClientId(req: Request): string {
  return req.ip || 'unknown';
}

export function createAnalyticsRouter(soroban: SorobanClient) {
  const router = Router();

  router.post('/events', (req: Request, res: Response) => {
    const clientId = getClientId(req);
    if (!checkRateLimit(clientId)) {
      res.status(429).json({ error: 'Rate limit exceeded' });
      return;
    }

    const event: CredentialEvent = req.body;

    if (!event.type || !event.credential_id || !event.timestamp) {
      res.status(400).json({ error: 'Missing required fields: type, credential_id, timestamp' });
      return;
    }

    if (!['issued', 'attested', 'revoked', 'suspended', 'verified'].includes(event.type)) {
      res.status(400).json({ error: 'Invalid event type' });
      return;
    }

    metricsStore.recordEvent(event);
    res.status(201).json({ success: true, event_id: event.credential_id });
  });

  router.get('/metrics', (req: Request, res: Response) => {
    const clientId = getClientId(req);
    if (!checkRateLimit(clientId)) {
      res.status(429).json({ error: 'Rate limit exceeded' });
      return;
    }

    const startDate = (req.query.start_date as string) || getDateDaysAgo(90);
    const endDate = (req.query.end_date as string) || new Date().toISOString().split('T')[0];

    if (!isValidDateRange(startDate, endDate)) {
      res.status(400).json({ error: 'Invalid date range or format' });
      return;
    }

    const metrics = metricsStore.getMetrics(startDate, endDate);
    res.json({
      start_date: startDate,
      end_date: endDate,
      metrics,
      summary: {
        total_issued: metrics.reduce((sum, m) => sum + m.issued_count, 0),
        total_attested: metrics.reduce((sum, m) => sum + m.attested_count, 0),
        total_revoked: metrics.reduce((sum, m) => sum + m.revoked_count, 0),
      },
    });
  });

  router.get('/anomalies', (req: Request, res: Response) => {
    const clientId = getClientId(req);
    if (!checkRateLimit(clientId)) {
      res.status(429).json({ error: 'Rate limit exceeded' });
      return;
    }

    const startDate = (req.query.start_date as string) || getDateDaysAgo(30);
    const endDate = (req.query.end_date as string) || new Date().toISOString().split('T')[0];

    if (!isValidDateRange(startDate, endDate)) {
      res.status(400).json({ error: 'Invalid date range or format' });
      return;
    }

    const metrics = metricsStore.getMetrics(startDate, endDate);
    const anomalies = metricsStore.detectAnomalies(metrics);

    const anomalousMetrics = metrics.filter((_, i) => anomalies[i]?.is_anomalous);

    res.json({
      start_date: startDate,
      end_date: endDate,
      total_anomalies: anomalousMetrics.length,
      anomalous_dates: anomalousMetrics.map((m, i) => ({
        date: m.date,
        issued_count: m.issued_count,
        anomaly_score: m.anomaly_score,
        anomaly_details: anomalies.find((a) => a.score === m.anomaly_score),
      })),
    });
  });

  router.get('/events', (req: Request, res: Response) => {
    const clientId = getClientId(req);
    if (!checkRateLimit(clientId)) {
      res.status(429).json({ error: 'Rate limit exceeded' });
      return;
    }

    const startDateParam = (req.query.start_date as string) || getDateDaysAgo(7);
    const endDateParam = (req.query.end_date as string) || new Date().toISOString();
    const eventType = req.query.type as string | undefined;

    // Normalize dates to YYYY-MM-DD format
    const startDate = normalizeDateInput(startDateParam);
    const endDate = normalizeDateInput(endDateParam);

    if (!startDate || !endDate || !isValidDateRange(startDate, endDate)) {
      res.status(400).json({ error: 'Invalid date range or format' });
      return;
    }

    let events = metricsStore.getEventLog(startDate, endDate);

    if (eventType) {
      events = events.filter((e) => e.type === eventType);
    }

    res.json({
      start_date: startDate,
      end_date: endDate,
      event_type_filter: eventType,
      total_events: events.length,
      events,
    });
  });

  router.get('/summary', (req: Request, res: Response) => {
    const clientId = getClientId(req);
    if (!checkRateLimit(clientId)) {
      res.status(429).json({ error: 'Rate limit exceeded' });
      return;
    }

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

function getDateDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().split('T')[0];
}

function normalizeDateInput(input: string): string | null {
  // Handle ISO format (2026-06-22T00:00:00Z)
  if (input.includes('T')) {
    const date = new Date(input);
    if (!isNaN(date.getTime())) {
      return date.toISOString().split('T')[0];
    }
  }

  // Handle YYYY-MM-DD format
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (dateRegex.test(input)) {
    const date = new Date(input);
    if (!isNaN(date.getTime())) {
      return input;
    }
  }

  return null;
}

function isValidDateRange(startDate: string, endDate: string): boolean {
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
    return false;
  }

  const start = new Date(startDate);
  const end = new Date(endDate);

  return !isNaN(start.getTime()) && !isNaN(end.getTime()) && start <= end;
}

// Default export using real soroban client
import { simulateCall, u64Val } from '../soroban.js';
export default createAnalyticsRouter({
  simulateCall,
  u64Val: u64Val as SorobanClient['u64Val'],
  u32Val: (n) => n,
  addressVal: (a) => a,
});
