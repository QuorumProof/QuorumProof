import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAnalyticsRouter } from '../src/routes/analytics.js';
import { metricsStore, type CredentialEvent } from '../src/services/metrics.js';

const mockSoroban = {
  simulateCall: async () => null,
  u64Val: (n: number | bigint) => n as unknown,
  u32Val: (n: number) => n,
  addressVal: (a: string) => a,
};

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/analytics', createAnalyticsRouter(mockSoroban));
  return app;
}

const app = createTestApp();
const ISSUER = 'GABC1234ISSUER';
const OTHER_ISSUER = 'GXYZ9999OTHER';

describe('GET /api/analytics/issuer/:address', () => {
  beforeEach(() => {
    metricsStore.reset();
  });

  it('returns zero metrics when no events exist', async () => {
    const res = await request(app).get(`/api/analytics/issuer/${ISSUER}`);
    expect(res.status).toBe(200);
    expect(res.body.issuer).toBe(ISSUER);
    expect(res.body.credentials_issued).toBe(0);
    expect(res.body.avg_attestation_time_ms).toBeNull();
    expect(res.body.dispute_rate).toBe(0);
    expect(res.body.reputation_trend).toEqual([]);
  });

  it('counts credentials issued by this issuer only', async () => {
    const now = new Date().toISOString();
    metricsStore.recordEvent({ type: 'issued', credential_id: 'c1', timestamp: now, issuer: ISSUER });
    metricsStore.recordEvent({ type: 'issued', credential_id: 'c2', timestamp: now, issuer: ISSUER });
    metricsStore.recordEvent({ type: 'issued', credential_id: 'c3', timestamp: now, issuer: OTHER_ISSUER });

    const res = await request(app).get(`/api/analytics/issuer/${ISSUER}`);
    expect(res.status).toBe(200);
    expect(res.body.credentials_issued).toBe(2);
  });

  it('calculates dispute_rate correctly', async () => {
    const now = new Date().toISOString();
    // 4 issued, 1 disputed → rate = 0.25
    for (let i = 0; i < 4; i++) {
      metricsStore.recordEvent({ type: 'issued', credential_id: `c${i}`, timestamp: now, issuer: ISSUER });
    }
    metricsStore.recordEvent({ type: 'disputed', credential_id: 'c0', timestamp: now, issuer: ISSUER });

    const res = await request(app).get(`/api/analytics/issuer/${ISSUER}`);
    expect(res.status).toBe(200);
    expect(res.body.dispute_rate).toBeCloseTo(0.25);
  });

  it('returns null avg_attestation_time_ms when no duration data present', async () => {
    const now = new Date().toISOString();
    metricsStore.recordEvent({ type: 'attested', credential_id: 'c1', timestamp: now, issuer: ISSUER });

    const res = await request(app).get(`/api/analytics/issuer/${ISSUER}`);
    expect(res.status).toBe(200);
    expect(res.body.avg_attestation_time_ms).toBeNull();
  });

  it('calculates avg_attestation_time_ms from attestation_duration_ms', async () => {
    const now = new Date().toISOString();
    const attestEvents: CredentialEvent[] = [
      { type: 'attested', credential_id: 'c1', timestamp: now, issuer: ISSUER, attestation_duration_ms: 1000 },
      { type: 'attested', credential_id: 'c2', timestamp: now, issuer: ISSUER, attestation_duration_ms: 3000 },
    ];
    attestEvents.forEach((e) => metricsStore.recordEvent(e));

    const res = await request(app).get(`/api/analytics/issuer/${ISSUER}`);
    expect(res.status).toBe(200);
    expect(res.body.avg_attestation_time_ms).toBeCloseTo(2000);
  });

  it('builds reputation_trend grouped by day', async () => {
    const day1 = '2026-06-27T10:00:00.000Z';
    const day2 = '2026-06-28T10:00:00.000Z';
    metricsStore.recordEvent({ type: 'issued', credential_id: 'c1', timestamp: day1, issuer: ISSUER });
    metricsStore.recordEvent({ type: 'issued', credential_id: 'c2', timestamp: day1, issuer: ISSUER });
    metricsStore.recordEvent({ type: 'disputed', credential_id: 'c1', timestamp: day1, issuer: ISSUER });
    metricsStore.recordEvent({ type: 'issued', credential_id: 'c3', timestamp: day2, issuer: ISSUER });

    const res = await request(app).get(`/api/analytics/issuer/${ISSUER}`);
    expect(res.status).toBe(200);

    const trend: { date: string; issued: number; disputed: number }[] = res.body.reputation_trend;
    const d1 = trend.find((t) => t.date === '2026-06-27');
    const d2 = trend.find((t) => t.date === '2026-06-28');
    expect(d1).toBeDefined();
    expect(d1!.issued).toBe(2);
    expect(d1!.disputed).toBe(1);
    expect(d2!.issued).toBe(1);
    expect(d2!.disputed).toBe(0);
  });

  it('includes period_days in response', async () => {
    const res = await request(app).get(`/api/analytics/issuer/${ISSUER}?period_days=7`);
    expect(res.status).toBe(200);
    expect(res.body.period_days).toBe(7);
  });

  it('rejects invalid period_days', async () => {
    const res = await request(app).get(`/api/analytics/issuer/${ISSUER}?period_days=0`);
    expect(res.status).toBe(400);
  });

  it('excludes events outside the period window', async () => {
    // Event 60 days ago — outside a 30-day window
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();
    metricsStore.recordEvent({ type: 'issued', credential_id: 'old', timestamp: old, issuer: ISSUER });
    metricsStore.recordEvent({ type: 'issued', credential_id: 'new', timestamp: recent, issuer: ISSUER });

    const res = await request(app).get(`/api/analytics/issuer/${ISSUER}?period_days=30`);
    expect(res.status).toBe(200);
    expect(res.body.credentials_issued).toBe(1);
  });
});
