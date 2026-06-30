/**
 * Tests for #924: Predictive Analytics for Credential Expiry
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildExpiryForecast, getExpiringWithin } from '../src/services/expiryAnalytics.js';
import express from 'express';
import request from 'supertest';
import { createReportsRouter } from '../src/routes/reports.js';

// ---- Unit tests for expiryAnalytics service ----

const NOW = new Date('2026-01-01T00:00:00Z').getTime();

const makeCredential = (id: string, daysFromNow: number | null, overrides: Record<string, unknown> = {}) => ({
  id,
  subject: `G${id}`,
  issuer: 'issuerA',
  credential_type: 1,
  revoked: false,
  suspended: false,
  expires_at: daysFromNow === null
    ? null
    : new Date(NOW + daysFromNow * 86_400_000).toISOString(),
  ...overrides,
});

describe('buildExpiryForecast', () => {
  it('counts credentials in the correct windows', () => {
    const creds = [
      makeCredential('1', 10),   // 0-30
      makeCredential('2', 45),   // 31-60
      makeCredential('3', 75),   // 61-90
      makeCredential('4', 120),  // 91-180
      makeCredential('5', 200),  // beyond default windows
    ];
    const forecast = buildExpiryForecast(creds, NOW);
    expect(forecast.windows[0].count).toBe(1);  // 0-30
    expect(forecast.windows[1].count).toBe(1);  // 31-60
    expect(forecast.windows[2].count).toBe(1);  // 61-90
    expect(forecast.windows[3].count).toBe(1);  // 91-180
  });

  it('excludes revoked and suspended credentials', () => {
    const creds = [
      makeCredential('1', 10, { revoked: true }),
      makeCredential('2', 10, { suspended: true }),
      makeCredential('3', 10),
    ];
    const forecast = buildExpiryForecast(creds, NOW);
    expect(forecast.total_expiring).toBe(1);
  });

  it('excludes credentials with no expires_at', () => {
    const creds = [makeCredential('1', null), makeCredential('2', 20)];
    const forecast = buildExpiryForecast(creds, NOW);
    expect(forecast.total_expiring).toBe(1);
  });

  it('counts already expired credentials', () => {
    const creds = [makeCredential('1', -5), makeCredential('2', 10)];
    const forecast = buildExpiryForecast(creds, NOW);
    expect(forecast.already_expired).toBe(1);
    expect(forecast.total_expiring).toBe(1);
  });

  it('calculates avg_per_day trend correctly', () => {
    const creds = [makeCredential('1', 10), makeCredential('2', 20)]; // 2 within 90 days
    const forecast = buildExpiryForecast(creds, NOW, 90);
    expect(forecast.trend.avg_per_day).toBeCloseTo(2 / 90, 2);
  });

  it('identifies peak window', () => {
    const creds = [
      makeCredential('1', 5),
      makeCredential('2', 10),
      makeCredential('3', 15),
      makeCredential('4', 45), // only one in 31-60
    ];
    const forecast = buildExpiryForecast(creds, NOW);
    expect(forecast.trend.peak_window).toBe('0-30 days');
  });

  it('returns null peak_window when no credentials are expiring', () => {
    const forecast = buildExpiryForecast([], NOW);
    expect(forecast.trend.peak_window).toBeNull();
    expect(forecast.total_expiring).toBe(0);
  });

  it('respects custom horizon', () => {
    const creds = [makeCredential('1', 10), makeCredential('2', 200)];
    const forecast30 = buildExpiryForecast(creds, NOW, 30);
    expect(forecast30.trend.forecast_horizon_days).toBe(30);
    // Only cred 1 falls within 30-day horizon
    expect(forecast30.trend.avg_per_day).toBeCloseTo(1 / 30, 2);
  });
});

describe('getExpiringWithin', () => {
  it('returns credentials within threshold', () => {
    const creds = [makeCredential('1', 10), makeCredential('2', 45)];
    const result = getExpiringWithin(creds, 30, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('1');
  });

  it('sorts results by days_until_expiry ascending', () => {
    const creds = [makeCredential('1', 20), makeCredential('2', 5)];
    const result = getExpiringWithin(creds, 30, NOW);
    expect(result[0].id).toBe('2');
    expect(result[1].id).toBe('1');
  });

  it('excludes expired credentials', () => {
    const creds = [makeCredential('1', -1)];
    expect(getExpiringWithin(creds, 30, NOW)).toHaveLength(0);
  });
});

// ---- HTTP route tests ----

vi.mock('../src/notifications.js', () => ({
  dispatchNotification: vi.fn().mockResolvedValue(undefined),
}));

const mockSimulateCall = vi.fn();
const mockSoroban = {
  simulateCall: mockSimulateCall,
  u64Val: (n: number | bigint) => n as any,
};

const app = express();
app.use(express.json());
app.use('/api/reports', createReportsRouter(mockSoroban));

const credAt = (id: number, daysFromNow: number) => ({
  id: String(id),
  subject: `G${id}`,
  issuer: 'issuerA',
  credential_type: 1,
  revoked: false,
  suspended: false,
  expires_at: new Date(Date.now() + daysFromNow * 86_400_000).toISOString(),
});

describe('GET /api/reports/expiry-forecast', () => {
  beforeEach(() => mockSimulateCall.mockReset());

  it('returns forecast with windowed breakdown', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(BigInt(3))
      .mockResolvedValueOnce(credAt(1, 10))
      .mockResolvedValueOnce(credAt(2, 45))
      .mockResolvedValueOnce(credAt(3, 75));

    const res = await request(app).get('/api/reports/expiry-forecast');
    expect(res.status).toBe(200);
    expect(res.body.total_expiring).toBe(3);
    expect(res.body.windows).toHaveLength(4);
    expect(res.body.trend).toHaveProperty('avg_per_day');
    expect(res.body.trend).toHaveProperty('peak_window');
    expect(res.body).toHaveProperty('already_expired');
    expect(res.body).toHaveProperty('generatedAt');
  });

  it('respects custom horizon param', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(BigInt(1))
      .mockResolvedValueOnce(credAt(1, 10));

    const res = await request(app).get('/api/reports/expiry-forecast?horizon=30');
    expect(res.status).toBe(200);
    expect(res.body.trend.forecast_horizon_days).toBe(30);
  });

  it('returns empty forecast when no credentials', async () => {
    mockSimulateCall.mockResolvedValueOnce(BigInt(0));

    const res = await request(app).get('/api/reports/expiry-forecast');
    expect(res.status).toBe(200);
    expect(res.body.total_expiring).toBe(0);
    expect(res.body.trend.peak_window).toBeNull();
  });

  it('returns 500 on soroban error', async () => {
    mockSimulateCall.mockRejectedValueOnce(new Error('rpc error'));
    const res = await request(app).get('/api/reports/expiry-forecast');
    expect(res.status).toBe(500);
  });
});

describe('POST /api/reports/expiry-advance-notify', () => {
  beforeEach(() => mockSimulateCall.mockReset());

  it('dispatches notifications for expiring credentials', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(BigInt(2))
      .mockResolvedValueOnce(credAt(1, 10))   // within 30d
      .mockResolvedValueOnce(credAt(2, 45));   // outside 30d

    const res = await request(app)
      .post('/api/reports/expiry-advance-notify')
      .send({ threshold_days: 30 });

    expect(res.status).toBe(200);
    expect(res.body.notified).toBe(1);
    expect(res.body.dispatched[0].credential_id).toBe('1');
    expect(res.body.threshold_days).toBe(30);
  });

  it('uses default threshold of 30 days when not provided', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(BigInt(1))
      .mockResolvedValueOnce(credAt(1, 20));

    const res = await request(app)
      .post('/api/reports/expiry-advance-notify')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.threshold_days).toBe(30);
    expect(res.body.notified).toBe(1);
  });

  it('returns zero dispatched when nothing is expiring', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(BigInt(1))
      .mockResolvedValueOnce(credAt(1, 100));

    const res = await request(app)
      .post('/api/reports/expiry-advance-notify')
      .send({ threshold_days: 30 });

    expect(res.status).toBe(200);
    expect(res.body.notified).toBe(0);
  });

  it('returns 500 on soroban error', async () => {
    mockSimulateCall.mockRejectedValueOnce(new Error('contract error'));
    const res = await request(app)
      .post('/api/reports/expiry-advance-notify')
      .send({});
    expect(res.status).toBe(500);
  });
});
