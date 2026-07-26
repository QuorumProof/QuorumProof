/**
 * Issue #1003 — Chaos testing for network failures.
 *
 * Injects network delay, dropped/failed calls ("packet loss"), and
 * sustained service-unavailability directly into the mocked Soroban RPC
 * client the API server talks to, then asserts the affected endpoints
 * degrade gracefully (a clean error response, not a hang/crash/500-with-no-
 * body) instead of taking down the request. This is the in-repo,
 * CI-runnable counterpart to the chaos-mesh manifests in
 * `monitoring/chaos/`, which exercise the same failure classes against a
 * real deployed cluster — see docs/resilience.md.
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

/** Simulated network delay: resolves `value` after `ms`. */
function delayed<T>(value: T, ms: number): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

const CONN_RESET = new Error('ECONNRESET: connection reset by peer');
const SERVICE_UNAVAILABLE = new Error('503 Service Unavailable: upstream RPC unreachable');

beforeEach(() => mockSimulateCall.mockReset());

describe('chaos: network delay', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/credentials', createCredentialsRouter(mockSoroban));

  it('search still responds correctly when the RPC call is slow', async () => {
    mockSimulateCall.mockImplementationOnce(() => delayed(0n, 30));

    const res = await request(app).get('/api/credentials/search');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
  });

  it('metadata-hash lookup does not hang past a slow upstream call', async () => {
    mockSimulateCall.mockImplementationOnce(() =>
      delayed({ id: 101, metadata_hash: 'abc', revoked: false, suspended: false, version: 1 }, 30)
    );

    const res = await request(app).get('/api/credentials/101/metadata-hash');
    expect(res.status).toBe(200);
    expect(res.body.metadata_hash).toBe('abc');
  });
});

describe('chaos: packet loss (dropped/reset connections)', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/credentials', createCredentialsRouter(mockSoroban));
  app.use('/api/verify', createVerifyRouter(mockSoroban));

  it('search degrades gracefully when get_credential_count is dropped mid-flight', async () => {
    mockSimulateCall.mockRejectedValueOnce(CONN_RESET);

    const res = await request(app).get('/api/credentials/search');
    // populateIndex() catches the error internally and logs it — the route
    // must still respond (with an empty index), never hang or crash.
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('single-credential verify returns a clean error, not a hang, on connection reset', async () => {
    mockSimulateCall.mockRejectedValueOnce(CONN_RESET);

    const res = await request(app).get('/api/verify/102');
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
  });

  it('metadata-hash lookup surfaces a clean 500 on connection reset instead of crashing the process', async () => {
    mockSimulateCall.mockRejectedValueOnce(CONN_RESET);

    const res = await request(app).get('/api/credentials/103/metadata-hash');
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
  });

  it('verify-batch reports a per-item error instead of failing the whole batch on packet loss', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(true) // is_attested for credential 1
      .mockRejectedValueOnce(CONN_RESET); // is_attested for credential 2 dropped

    const res = await request(app)
      .post('/api/credentials/verify-batch')
      .send({ credential_ids: [1, 2], slice_id: 1 });

    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ credential_id: 1, attested: true, error: null });
    expect(res.body.results[1].attested).toBe(false);
    expect(res.body.results[1].error).toBeTruthy();
  });
});

describe('chaos: sustained service unavailability', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/credentials', createCredentialsRouter(mockSoroban));
  app.use('/api/verify', createVerifyRouter(mockSoroban));

  it('search responds with an empty, still-usable index when the RPC service is entirely down', async () => {
    mockSimulateCall.mockRejectedValueOnce(SERVICE_UNAVAILABLE);

    const res = await request(app).get('/api/credentials/search');
    expect(res.status).toBe(200);
    expect(res.body.pagination).toBeDefined();
  });

  it('verify/batch surfaces a bounded per-item error for every item when the service is down', async () => {
    mockSimulateCall
      .mockRejectedValueOnce(SERVICE_UNAVAILABLE) // get_supported_claim_types (best-effort, swallowed)
      .mockRejectedValueOnce(SERVICE_UNAVAILABLE); // get_credential for the one requested item

    const res = await request(app)
      .post('/api/verify/batch')
      .send({ items: [{ credential_id: 104, claim_type: 'name' }] });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].status).toBe('error');
    expect(res.body.summary.errors).toBe(1);
  });

  it('recovers cleanly once the service comes back up (no lingering broken state)', async () => {
    mockSimulateCall.mockRejectedValueOnce(SERVICE_UNAVAILABLE);
    const down = await request(app).get('/api/verify/105');
    expect(down.status).toBe(500);

    mockSimulateCall.mockResolvedValueOnce({
      id: 105,
      revoked: false,
      suspended: false,
      expires_at: null,
      version: 1,
    });
    const up = await request(app).get('/api/verify/105');
    expect(up.status).toBe(200);
    expect(up.body.status).toBe('verified');
  });
});
