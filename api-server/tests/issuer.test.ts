import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import issuerRouter from '../src/routes/issuer.js';
import { metricsStore } from '../src/services/metrics.js';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/issuer', issuerRouter);
  return app;
}

const app = createTestApp();
const ISSUER = 'GISSUER1234';

describe('GET /api/issuer/:address/metrics', () => {
  beforeEach(() => {
    metricsStore.reset();
  });

  it('returns zero-state metrics for unknown issuer', async () => {
    const res = await request(app).get(`/api/issuer/${ISSUER}/metrics`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      issuer: ISSUER,
      credentials_issued: 0,
      avg_attestation_time_ms: null,
      dispute_rate: 0,
      reputation_trend: [],
      period_days: 30,
    });
  });

  it('counts credentials_issued correctly', async () => {
    metricsStore.recordEvent({ type: 'issued', credential_id: 'c1', timestamp: new Date().toISOString(), issuer: ISSUER });
    metricsStore.recordEvent({ type: 'issued', credential_id: 'c2', timestamp: new Date().toISOString(), issuer: ISSUER });
    metricsStore.recordEvent({ type: 'issued', credential_id: 'c3', timestamp: new Date().toISOString(), issuer: 'OTHER' });

    const res = await request(app).get(`/api/issuer/${ISSUER}/metrics`);
    expect(res.status).toBe(200);
    expect(res.body.credentials_issued).toBe(2);
  });

  it('computes avg_attestation_time_ms from attested events', async () => {
    metricsStore.recordEvent({ type: 'issued', credential_id: 'c1', timestamp: new Date().toISOString(), issuer: ISSUER });
    metricsStore.recordEvent({ type: 'attested', credential_id: 'c1', timestamp: new Date().toISOString(), issuer: ISSUER, attestation_time_ms: 1000 });
    metricsStore.recordEvent({ type: 'attested', credential_id: 'c1', timestamp: new Date().toISOString(), issuer: ISSUER, attestation_time_ms: 3000 });

    const res = await request(app).get(`/api/issuer/${ISSUER}/metrics`);
    expect(res.status).toBe(200);
    expect(res.body.avg_attestation_time_ms).toBe(2000);
  });

  it('returns null avg_attestation_time_ms when no attested events with timing', async () => {
    metricsStore.recordEvent({ type: 'issued', credential_id: 'c1', timestamp: new Date().toISOString(), issuer: ISSUER });
    metricsStore.recordEvent({ type: 'attested', credential_id: 'c1', timestamp: new Date().toISOString(), issuer: ISSUER });

    const res = await request(app).get(`/api/issuer/${ISSUER}/metrics`);
    expect(res.status).toBe(200);
    expect(res.body.avg_attestation_time_ms).toBeNull();
  });

  it('computes dispute_rate correctly', async () => {
    metricsStore.recordEvent({ type: 'issued', credential_id: 'c1', timestamp: new Date().toISOString(), issuer: ISSUER });
    metricsStore.recordEvent({ type: 'issued', credential_id: 'c2', timestamp: new Date().toISOString(), issuer: ISSUER });
    metricsStore.recordEvent({ type: 'issued', credential_id: 'c3', timestamp: new Date().toISOString(), issuer: ISSUER, disputed: true });
    metricsStore.recordEvent({ type: 'issued', credential_id: 'c4', timestamp: new Date().toISOString(), issuer: ISSUER, disputed: true });

    const res = await request(app).get(`/api/issuer/${ISSUER}/metrics`);
    expect(res.status).toBe(200);
    expect(res.body.dispute_rate).toBe(0.5);
  });

  it('builds reputation_trend sorted by date', async () => {
    const day1 = '2026-06-27T10:00:00.000Z';
    const day2 = '2026-06-28T10:00:00.000Z';
    metricsStore.recordEvent({ type: 'issued', credential_id: 'c1', timestamp: day2, issuer: ISSUER });
    metricsStore.recordEvent({ type: 'issued', credential_id: 'c2', timestamp: day1, issuer: ISSUER });
    metricsStore.recordEvent({ type: 'issued', credential_id: 'c3', timestamp: day1, issuer: ISSUER });

    const res = await request(app).get(`/api/issuer/${ISSUER}/metrics`);
    expect(res.status).toBe(200);
    const trend = res.body.reputation_trend;
    expect(trend).toHaveLength(2);
    expect(trend[0]).toEqual({ date: '2026-06-27', issued_count: 2 });
    expect(trend[1]).toEqual({ date: '2026-06-28', issued_count: 1 });
  });

  it('respects period_days query parameter', async () => {
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();
    metricsStore.recordEvent({ type: 'issued', credential_id: 'c1', timestamp: old, issuer: ISSUER });
    metricsStore.recordEvent({ type: 'issued', credential_id: 'c2', timestamp: recent, issuer: ISSUER });

    const res = await request(app).get(`/api/issuer/${ISSUER}/metrics?period_days=7`);
    expect(res.status).toBe(200);
    expect(res.body.credentials_issued).toBe(1);
    expect(res.body.period_days).toBe(7);
  });

  it('returns 400 for invalid period_days', async () => {
    const res = await request(app).get(`/api/issuer/${ISSUER}/metrics?period_days=0`);
    expect(res.status).toBe(400);
  });

  it('returns 400 for period_days > 365', async () => {
    const res = await request(app).get(`/api/issuer/${ISSUER}/metrics?period_days=366`);
    expect(res.status).toBe(400);
  });
});
