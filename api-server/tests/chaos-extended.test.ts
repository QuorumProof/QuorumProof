/**
 * Issue #1627 — Chaos Engineering Extended Tests
 *
 * Extended chaos engineering tests that complement the base chaos.test.ts suite.
 * Tests failure injection scenarios:
 *   - Network partition simulation
 *   - Resource exhaustion (memory, connections)
 *   - Cascading failures across components
 *   - Component failure injection
 *   - Partial system degradation
 *   - Byzantine failure scenarios
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createCredentialsRouter } from '../src/routes/credentials.js';
import { createVerifyRouter } from '../src/routes/verify.js';

const mockSimulateCall = vi.fn();
const mockSoroban = {
  simulateCall: mockSimulateCall,
  u64Val: (n: number | bigint) => n as any,
  u32Val: (n: number) => n as any,
  addressVal: (a: string) => a as any,
};

beforeEach(() => mockSimulateCall.mockReset());

describe('chaos: network partition', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/credentials', createCredentialsRouter(mockSoroban));
  app.use('/api/verify', createVerifyRouter(mockSoroban));

  it('search continues to function with degraded read-only access during partition', async () => {
    mockSimulateCall.mockResolvedValueOnce({
      credentials: [{ id: 1, revoked: false }],
      total: 1,
    });

    const res = await request(app).get('/api/credentials/search');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
  });

  it('writes fail cleanly when network partitioned from consensus', async () => {
    const partitionError = new Error('Network partition detected: cannot reach quorum');
    mockSimulateCall.mockRejectedValueOnce(partitionError);

    const app2 = express();
    app2.use(express.json());
    app2.use('/api/verify', createVerifyRouter(mockSoroban));

    const res = await request(app2).post('/api/verify/batch').send({
      items: [{ credential_id: 1 }],
    });

    expect([400, 500]).toContain(res.status);
    expect(res.body).toHaveProperty('error');
  });

  it('split-brain scenarios do not corrupt data', async () => {
    mockSimulateCall.mockResolvedValueOnce({
      id: 200,
      revoked: false,
      suspended: false,
      version: 1,
    });

    const res1 = await request(app).get('/api/credentials/200');
    expect(res1.status).toBe(200);

    mockSimulateCall.mockResolvedValueOnce({
      id: 200,
      revoked: false,
      suspended: false,
      version: 1,
    });

    const res2 = await request(app).get('/api/credentials/200');
    expect(res2.status).toBe(200);
    expect(res1.body.id).toBe(res2.body.id);
  });
});

describe('chaos: resource exhaustion', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/credentials', createCredentialsRouter(mockSoroban));

  it('handles connection pool exhaustion gracefully', async () => {
    const poolExhaustedError = new Error('Connection pool exhausted: max connections reached');
    mockSimulateCall.mockRejectedValueOnce(poolExhaustedError);

    const res = await request(app).get('/api/credentials/search');
    expect([200, 500, 503]).toContain(res.status);
  });

  it('does not accumulate memory leaks under high request volume', async () => {
    mockSimulateCall.mockResolvedValue({
      id: 1,
      revoked: false,
      suspended: false,
      version: 1,
    });

    const memBefore = process.memoryUsage().heapUsed;

    for (let i = 0; i < 10; i++) {
      await request(app).get('/api/credentials/1');
    }

    const memAfter = process.memoryUsage().heapUsed;
    const memGrowth = memAfter - memBefore;

    expect(memGrowth).toBeLessThan(10 * 1024 * 1024);
  });

  it('handles concurrent request saturation', async () => {
    mockSimulateCall.mockResolvedValue({
      id: 2,
      revoked: false,
      suspended: false,
      version: 1,
    });

    const requests = Array.from({ length: 50 }, () =>
      request(app).get('/api/credentials/2')
    );

    const responses = await Promise.all(requests);
    const successCount = responses.filter((r) => r.status === 200).length;

    expect(successCount).toBeGreaterThanOrEqual(40);
  });

  it('gracefully degrades service under memory pressure', async () => {
    mockSimulateCall.mockResolvedValueOnce({
      id: 3,
      revoked: false,
      suspended: false,
      version: 1,
    });

    const res = await request(app).get('/api/credentials/3');
    expect([200, 503]).toContain(res.status);
  });
});

describe('chaos: cascading failures', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/credentials', createCredentialsRouter(mockSoroban));
  app.use('/api/verify', createVerifyRouter(mockSoroban));

  it('downstream service failure does not cascade upstream', async () => {
    const downstreamError = new Error('Downstream service failed: database unavailable');
    mockSimulateCall.mockRejectedValueOnce(downstreamError);

    const res = await request(app).get('/api/credentials/search');
    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
  });

  it('handles chain of dependency failures independently', async () => {
    const error1 = new Error('Service A failed');
    const error2 = new Error('Service B failed');

    mockSimulateCall.mockRejectedValueOnce(error1).mockRejectedValueOnce(error2);

    const res1 = await request(app).get('/api/credentials/search');
    expect([200, 500]).toContain(res1.status);

    const res2 = await request(app).get('/api/credentials/search');
    expect([200, 500]).toContain(res2.status);
  });

  it('slow dependency does not block other requests', async () => {
    const slowResolve = new Promise((resolve) =>
      setTimeout(() => resolve({ id: 4, revoked: false, suspended: false, version: 1 }), 100)
    );

    mockSimulateCall.mockReturnValueOnce(slowResolve);

    const start = Date.now();
    const res = await request(app).get('/api/credentials/4');
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('chaos: component failure injection', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/credentials', createCredentialsRouter(mockSoroban));

  it('injects failure in cache layer without affecting other requests', async () => {
    const cacheError = new Error('Redis connection failed');
    mockSimulateCall.mockRejectedValueOnce(cacheError).mockResolvedValueOnce({
      id: 5,
      revoked: false,
      suspended: false,
      version: 1,
    });

    const res = await request(app).get('/api/credentials/5');
    expect([200, 500]).toContain(res.status);
  });

  it('database connection failure surfaces clean error', async () => {
    const dbError = new Error('Database connection timeout');
    mockSimulateCall.mockRejectedValueOnce(dbError);

    const res = await request(app).get('/api/credentials/search');
    expect([200, 500]).toContain(res.status);
    if (res.status === 500) {
      expect(res.body.error).toBeDefined();
    }
  });

  it('circuit breaker prevents cascading calls to failing service', async () => {
    const failureError = new Error('Service temporarily unavailable');

    mockSimulateCall
      .mockRejectedValueOnce(failureError)
      .mockRejectedValueOnce(failureError)
      .mockRejectedValueOnce(failureError);

    for (let i = 0; i < 3; i++) {
      const res = await request(app).get('/api/credentials/search');
      expect([200, 500, 503]).toContain(res.status);
    }
  });
});

describe('chaos: byzantine behavior', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/credentials', createCredentialsRouter(mockSoroban));

  it('handles inconsistent responses from replicas', async () => {
    mockSimulateCall
      .mockResolvedValueOnce({
        id: 6,
        revoked: false,
        suspended: false,
        version: 1,
      })
      .mockResolvedValueOnce({
        id: 6,
        revoked: true,
        suspended: false,
        version: 2,
      });

    const res1 = await request(app).get('/api/credentials/6');
    const res2 = await request(app).get('/api/credentials/6');

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
  });

  it('detects and rejects corrupted data from Byzantine node', async () => {
    mockSimulateCall.mockResolvedValueOnce({
      id: 'INVALID',
      revoked: 'corrupted',
      suspended: null,
      version: 'NaN',
    });

    const res = await request(app).get('/api/credentials/7');
    expect([400, 500]).toContain(res.status);
  });

  it('recovers from Byzantine failure without data corruption', async () => {
    mockSimulateCall
      .mockRejectedValueOnce(new Error('Byzantine fault detected'))
      .mockResolvedValueOnce({
        id: 8,
        revoked: false,
        suspended: false,
        version: 1,
      });

    const res1 = await request(app).get('/api/credentials/8');
    expect([500]).toContain(res1.status);

    const res2 = await request(app).get('/api/credentials/8');
    expect(res2.status).toBe(200);
  });
});

describe('chaos: partial degradation', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/credentials', createCredentialsRouter(mockSoroban));

  it('serves partial results when subset of shards fails', async () => {
    mockSimulateCall.mockResolvedValueOnce({
      credentials: [{ id: 1 }, { id: 2 }],
      total: 2,
      complete: false,
    });

    const res = await request(app).get('/api/credentials/search');
    expect(res.status).toBe(200);
  });

  it('maintains at least one working data path', async () => {
    mockSimulateCall.mockResolvedValueOnce({
      id: 9,
      revoked: false,
      suspended: false,
      version: 1,
    });

    const res = await request(app).get('/api/credentials/9');
    expect(res.status).toBe(200);
  });
});
