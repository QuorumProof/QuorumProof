import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createReportsRouter } from '../src/routes/reports.js';
import { resetStats, recordCall } from '../src/analytics.js';

const mockSimulateCall = vi.fn();
const mockSoroban = {
  simulateCall: mockSimulateCall,
  u64Val: (n: number | bigint) => n as any,
};

const app = express();
app.use(express.json());
app.use('/api/reports', createReportsRouter(mockSoroban));

const mockCredential = (id: number, overrides = {}) => ({
  id: String(id),
  subject: `subject-${id}`,
  issuer: `issuer-${id}`,
  credential_type: 1,
  revoked: false,
  suspended: false,
  expires_at: null,
  ...overrides,
});

describe('GET /api/reports/compliance', () => {
  beforeEach(() => mockSimulateCall.mockReset());

  it('returns compliance report with correct summary', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(BigInt(3)) // get_credential_count
      .mockResolvedValueOnce(mockCredential(1))
      .mockResolvedValueOnce(mockCredential(2, { revoked: true }))
      .mockResolvedValueOnce(mockCredential(3, { suspended: true }));

    const res = await request(app).get('/api/reports/compliance?year=2026&month=5');
    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ total: 3, active: 1, revoked: 1, suspended: 1 });
    expect(res.body.period).toEqual({ year: 2026, month: 5 });
  });

  it('reports gaps for credentials missing subject or issuer', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(BigInt(2))
      .mockResolvedValueOnce(mockCredential(1, { subject: '' }))
      .mockResolvedValueOnce(mockCredential(2, { issuer: '' }));

    const res = await request(app).get('/api/reports/compliance');
    expect(res.status).toBe(200);
    expect(res.body.gaps.missingSubject).toContain('1');
    expect(res.body.gaps.missingIssuer).toContain('2');
  });

  it('returns 400 for invalid month', async () => {
    const res = await request(app).get('/api/reports/compliance?month=13');
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid year', async () => {
    const res = await request(app).get('/api/reports/compliance?year=1900');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/reports/costs', () => {
  beforeEach(() => mockSimulateCall.mockReset());

  it('returns cost report with operations list', async () => {
    mockSimulateCall.mockResolvedValue(BigInt(0));
    const res = await request(app).get('/api/reports/costs');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.operations)).toBe(true);
    expect(res.body.operations.length).toBeGreaterThan(0);
    expect(res.body).toHaveProperty('mostExpensive');
    expect(res.body).toHaveProperty('optimizationSuggestions');
  });

  it('marks failed operations as error status', async () => {
    // Reject once per probed operation (5 total)
    for (let i = 0; i < 5; i++) mockSimulateCall.mockRejectedValueOnce(new Error('not found'));
    const res = await request(app).get('/api/reports/costs');
    expect(res.status).toBe(200);
    expect(res.body.operations.every((o: any) => o.status === 'error')).toBe(true);
  });
});

describe('GET /api/reports/usage', () => {
  beforeEach(() => resetStats());

  it('returns empty report when no calls recorded', async () => {
    const res = await request(app).get('/api/reports/usage');
    expect(res.status).toBe(200);
    expect(res.body.functions).toEqual([]);
  });

  it('reflects recorded calls and error rates', async () => {
    recordCall('get_credential', false);
    recordCall('get_credential', false);
    recordCall('get_credential', true);

    const res = await request(app).get('/api/reports/usage');
    expect(res.status).toBe(200);
    const fn = res.body.functions.find((f: any) => f.name === 'get_credential');
    expect(fn).toBeDefined();
    expect(fn.calls).toBe(3);
    expect(fn.errors).toBe(1);
    expect(fn.errorRate).toBeCloseTo(0.3333, 2);
  });
});
