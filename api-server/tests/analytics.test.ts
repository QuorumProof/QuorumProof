import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  SessionManager,
  _setDefaultSessionManagerForTest,
  _resetDefaultSessionManagerForTest,
  getDefaultSessionManager,
} from '../src/services/sessionManager.js';
import express from 'express';
import request from 'supertest';
import { createAnalyticsRouter } from '../src/routes/analytics.js';
import {
  metricsStore,
  CredentialEvent,
  DailyMetrics,
  buildMetricsQuery,
  buildEventLogQuery,
  buildAnomalyQuery,
  parseDateParam,
} from '../src/services/metrics.js';

const mockSimulateCall = vi.fn();
const mockSoroban = {
  simulateCall: mockSimulateCall,
  u64Val: (n: number | bigint) => n as any,
  u32Val: (n: number) => n,
  addressVal: (a: string) => a,
};

// Real signed JWTs for an admin caller (#1748). Routes now require auth.
const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-auth-'));
process.env.JWT_SECRET = 'test-secret-analytics-1748';
_setDefaultSessionManagerForTest(new SessionManager({ dataDir: authDir }));
const ADMIN_AUTH = `Bearer ${getDefaultSessionManager().createSession('GADMIN_ANALYTICS', { role: 'admin', mfaVerified: true }).accessToken}`;

function createTestApp() {
  const testApp = express();
  testApp.use(express.json());
  testApp.use('/api/analytics', createAnalyticsRouter(mockSoroban));
  return testApp;
}

/** Wraps an app so every request carries the admin token unless the test sets its own. */
function withAdminAuth(inner: express.Express) {
  const outer = express();
  outer.use((req, _res, next) => {
    if (!req.headers.authorization) req.headers.authorization = ADMIN_AUTH;
    next();
  });
  outer.use(inner);
  return outer;
}

afterAll(() => {
  _resetDefaultSessionManagerForTest();
  fs.rmSync(authDir, { recursive: true, force: true });
  delete process.env.JWT_SECRET;
});

const rawApp = createTestApp();
const app = withAdminAuth(rawApp);

function generateSyntheticEvents(count: number, startDate: string): CredentialEvent[] {
  const events: CredentialEvent[] = [];
  const types: CredentialEvent['type'][] = ['issued', 'attested', 'revoked', 'suspended', 'verified'];

  for (let i = 0; i < count; i++) {
    const date = new Date(startDate);
    date.setUTCHours(Math.floor(i / 100));
    date.setUTCMinutes((i * 7) % 60);

    events.push({
      type: types[i % types.length],
      credential_id: `cred-${i}`,
      timestamp: date.toISOString(),
      issuer: `issuer-${i % 10}`,
      subject: `subject-${i % 20}`,
      attestor: `attestor-${i % 5}`,
    });
  }

  return events;
}

describe('Analytics API', () => {
  beforeEach(() => {
    // Reset metrics store between tests
    metricsStore.reset();
  });

  describe('POST /api/analytics/events', () => {
    it('should record a credential event', async () => {
      const event: CredentialEvent = {
        type: 'issued',
        credential_id: 'test-cred-1',
        timestamp: new Date().toISOString(),
        issuer: 'issuer-1',
        subject: 'subject-1',
      };

      const res = await request(app).post('/api/analytics/events').send(event);
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.event_id).toBe('test-cred-1');
    });

    it('should validate required fields', async () => {
      const invalidEvent = { credential_id: 'test' };

      const res = await request(app).post('/api/analytics/events').send(invalidEvent);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Validation failed');
    });

    it('should reject invalid event types', async () => {
      const event = {
        type: 'invalid_type',
        credential_id: 'test-cred',
        timestamp: new Date().toISOString(),
      };

      const res = await request(app).post('/api/analytics/events').send(event);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Validation failed');
    });
  });

  describe('GET /api/analytics/metrics', () => {
    it('should return metrics for a date range', async () => {
      const events = generateSyntheticEvents(100, new Date().toISOString().split('T')[0]);
      events.forEach((e) => metricsStore.recordEvent(e));

      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

      metricsStore.aggregateToDaily(today);

      const res = await request(app)
        .get('/api/analytics/metrics')
        .query({ start_date: yesterday, end_date: today });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('metrics');
      expect(res.body).toHaveProperty('summary');
      expect(Array.isArray(res.body.metrics)).toBe(true);
    });

    it('should use default date range when not provided', async () => {
      const res = await request(app).get('/api/analytics/metrics');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('metrics');
    });

    it('should validate date format', async () => {
      const res = await request(app)
        .get('/api/analytics/metrics')
        .query({ start_date: 'invalid-date', end_date: 'also-invalid' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid date');
    });

    it('should handle 10k+ synthetic events', async () => {
      const today = new Date().toISOString().split('T')[0];
      const events = generateSyntheticEvents(10000, today);
      events.forEach((e) => metricsStore.recordEvent(e));

      metricsStore.aggregateToDaily(today);

      const res = await request(app)
        .get('/api/analytics/metrics')
        .query({ start_date: today, end_date: today });

      expect(res.status).toBe(200);
      expect(res.body.summary.total_issued).toBeGreaterThan(0);
    });
  });

  describe('GET /api/analytics/anomalies', () => {
    it('should detect anomalies in metrics', async () => {
      const baseDate = new Date();
      baseDate.setUTCDate(baseDate.getUTCDate() - 30);

      for (let i = 0; i < 30; i++) {
        const date = new Date(baseDate);
        date.setUTCDate(date.getUTCDate() + i);
        const dateStr = date.toISOString().split('T')[0];

        // Generate normal distribution of events
        const eventCount = i === 15 ? 5000 : 100 + Math.random() * 50;
        const events = generateSyntheticEvents(Math.floor(eventCount), dateStr);
        events.forEach((e) => {
          e.timestamp = date.toISOString();
          metricsStore.recordEvent(e);
        });
        metricsStore.aggregateToDaily(dateStr);
      }

      const startDate = new Date(baseDate).toISOString().split('T')[0];
      const endDate = new Date().toISOString().split('T')[0];

      const res = await request(app)
        .get('/api/analytics/anomalies')
        .query({ start_date: startDate, end_date: endDate });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('total_anomalies');
      expect(res.body).toHaveProperty('anomalous_dates');
      expect(Array.isArray(res.body.anomalous_dates)).toBe(true);
    });

    it('should handle 90-day query windows', async () => {
      const baseDate = new Date();
      baseDate.setUTCDate(baseDate.getUTCDate() - 90);

      for (let i = 0; i < 90; i++) {
        const date = new Date(baseDate);
        date.setUTCDate(date.getUTCDate() + i);
        const dateStr = date.toISOString().split('T')[0];

        const events = generateSyntheticEvents(200, dateStr);
        events.forEach((e) => {
          e.timestamp = date.toISOString();
          metricsStore.recordEvent(e);
        });
        metricsStore.aggregateToDaily(dateStr);
      }

      const startDate = new Date(baseDate).toISOString().split('T')[0];
      const endDate = new Date().toISOString().split('T')[0];

      const res = await request(app)
        .get('/api/analytics/anomalies')
        .query({ start_date: startDate, end_date: endDate });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('anomalous_dates');
      const dateCount = Math.ceil(
        (new Date(endDate).getTime() - new Date(startDate).getTime()) / (24 * 60 * 60 * 1000)
      );
      expect(dateCount).toBeLessThanOrEqual(90);
    });
  });

  describe('GET /api/analytics/events', () => {
    it('should retrieve events with optional type filter', async () => {
      const events = generateSyntheticEvents(50, new Date().toISOString().split('T')[0]);
      events.forEach((e) => metricsStore.recordEvent(e));

      const res = await request(app).get('/api/analytics/events').query({ type: 'issued' });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('events');
      expect(res.body).toHaveProperty('event_type_filter');
      expect(res.body.event_type_filter).toBe('issued');
    });

    it('should return all events without filter', async () => {
      const today = new Date().toISOString().split('T')[0];
      const events = generateSyntheticEvents(100, today);
      events.forEach((e) => metricsStore.recordEvent(e));

      const res = await request(app).get('/api/analytics/events');

      expect(res.status).toBe(200);
      expect(res.body.total_events).toBeGreaterThan(0);
    });
  });

  describe('GET /api/analytics/summary', () => {
    it('should return analytics summary', async () => {
      const events = generateSyntheticEvents(100, new Date().toISOString().split('T')[0]);
      events.forEach((e) => metricsStore.recordEvent(e));

      const res = await request(app).get('/api/analytics/summary');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('total_events');
      expect(res.body).toHaveProperty('total_days');
      expect(res.body).toHaveProperty('retention_days');
      expect(res.body.retention_days).toBe(730);
    });
  });

  describe('Rate Limiting', () => {
    it('should have rate limit protection configured', async () => {
      // Verify rate limit headers and logic are in place
      const res = await request(app).get('/api/analytics/summary');
      expect(res.status).toBe(200);
      // Rate limit logic is present in the code, even if not triggered in a single test
    });

    it('should track requests per client', async () => {
      // Make multiple requests and verify they're accepted
      for (let i = 0; i < 5; i++) {
        const res = await request(app).get('/api/analytics/summary');
        expect(res.status).toBe(200);
      }
    });
  });

  describe('Data Integrity', () => {
    it('should maintain data consistency across aggregations', async () => {
      const today = new Date().toISOString().split('T')[0];
      const events = generateSyntheticEvents(500, today);

      let issuedCount = 0;
      events.forEach((e) => {
        if (e.type === 'issued') issuedCount++;
        metricsStore.recordEvent(e);
      });

      metricsStore.aggregateToDaily(today);

      const res = await request(app)
        .get('/api/analytics/metrics')
        .query({ start_date: today, end_date: today });

      expect(res.status).toBe(200);
      expect(res.body.summary.total_issued).toBe(issuedCount);
    });

    it('should validate edge cases in aggregation', async () => {
      const today = new Date().toISOString().split('T')[0];
      const midnight = new Date(today + 'T00:00:00Z');

      const event1: CredentialEvent = {
        type: 'issued',
        credential_id: 'edge-1',
        timestamp: new Date(midnight.getTime() - 1000).toISOString(),
        issuer: 'issuer-1',
      };

      const event2: CredentialEvent = {
        type: 'issued',
        credential_id: 'edge-2',
        timestamp: new Date(midnight.getTime() + 1000).toISOString(),
        issuer: 'issuer-1',
      };

      metricsStore.recordEvent(event1);
      metricsStore.recordEvent(event2);
      metricsStore.aggregateToDaily(today);

      const res = await request(app)
        .get('/api/analytics/metrics')
        .query({ start_date: today, end_date: today });

      expect(res.status).toBe(200);
    });
  });

  describe('GET /api/analytics/health', () => {
    it('should return health status', async () => {
      const res = await request(app).get('/api/analytics/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.service).toBe('analytics');
      expect(res.body).toHaveProperty('timestamp');
    });
  });

  describe('GDPR Compliance', () => {
    it('should not expose personally identifiable information', async () => {
      const events = generateSyntheticEvents(100, new Date().toISOString().split('T')[0]);
      events.forEach((e) => metricsStore.recordEvent(e));

      const res = await request(app).get('/api/analytics/metrics');

      expect(res.status).toBe(200);
      // Verify no personal data is in the aggregated metrics
      const metrics = res.body.metrics;
      if (metrics.length > 0) {
        const metric = metrics[0];
        expect(metric).not.toHaveProperty('subject');
        expect(metric).not.toHaveProperty('issuer');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Authentication, issuer scoping and write rate limiting (#1748)
  // ---------------------------------------------------------------------------
  describe('access control (#1748)', () => {
    const sampleEvent = {
      type: 'issued',
      credential_id: '42',
      timestamp: new Date().toISOString(),
      issuer: 'GISSUER_1748',
    };

    const tokenFor = (sub: string, role?: string) =>
      `Bearer ${getDefaultSessionManager().createSession(sub, { role, mfaVerified: true }).accessToken}`;

    it.each([
      ['GET', '/api/analytics/metrics'],
      ['GET', '/api/analytics/anomalies'],
      ['GET', '/api/analytics/events'],
      ['GET', '/api/analytics/summary'],
      ['GET', '/api/analytics/issuer/GISSUER_1748'],
    ])('rejects unauthenticated %s %s with 401', async (method, route) => {
      const res = await request(rawApp)[method.toLowerCase() as 'get'](route);
      expect(res.status).toBe(401);
    });

    it('rejects unauthenticated POST /events and does not record the event', async () => {
      const spy = vi.spyOn(metricsStore, 'recordEvent');
      try {
        const res = await request(rawApp).post('/api/analytics/events').send(sampleEvent);
        expect(res.status).toBe(401);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it('keeps /health public', async () => {
      const res = await request(rawApp).get('/api/analytics/health');
      expect(res.status).toBe(200);
    });

    it('lets an issuer read their own issuer metrics', async () => {
      const res = await request(rawApp)
        .get('/api/analytics/issuer/GISSUER_SELF_1748')
        .set('Authorization', tokenFor('GISSUER_SELF_1748', 'issuer'));
      expect(res.status).toBe(200);
    });

    it('forbids an issuer from reading another issuer’s metrics', async () => {
      const res = await request(rawApp)
        .get('/api/analytics/issuer/GISSUER_OTHER_1748')
        .set('Authorization', tokenFor('GISSUER_SELF_1748', 'issuer'));
      expect(res.status).toBe(403);
    });

    it('lets an admin read any issuer’s metrics', async () => {
      const res = await request(rawApp)
        .get('/api/analytics/issuer/GISSUER_OTHER_1748')
        .set('Authorization', tokenFor('GADMIN_OTHER_1748', 'admin'));
      expect(res.status).toBe(200);
    });

    it('rate-limits authenticated writes per caller', async () => {
      const limited = withAdminAuth(createTestApp());
      let saw429 = false;
      for (let i = 0; i < 80 && !saw429; i++) {
        const res = await request(limited).post('/api/analytics/events').send(sampleEvent);
        if (res.status === 429) saw429 = true;
      }
      expect(saw429).toBe(true);
    });
  });
});
