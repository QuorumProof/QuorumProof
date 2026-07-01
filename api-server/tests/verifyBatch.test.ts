import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createVerifyRouter } from '../src/routes/verify.js';

const mockSimulateCall = vi.fn();
const mockSoroban = {
  simulateCall: mockSimulateCall,
  u64Val: (n: number | bigint) => n as any,
  u32Val: (n: number) => n as any,
  addressVal: (a: string) => a as any,
};

const app = express();
app.use(express.json());
app.use('/api/verify', createVerifyRouter(mockSoroban));

/** Default credential record a mocked `get_credential` call returns. */
function credRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    subject: 'GABC',
    issuer: 'GISSUER',
    credential_type: 1,
    metadata_hash: 'hash',
    revoked: false,
    suspended: false,
    expires_at: null,
    version: 1,
    ...overrides,
  };
}

/**
 * Return only the call count for a given method name — handy for asserting
 * that dedupe / caching actually reduced the number of Soroban round trips.
 */
function callCount(method: string): number {
  return mockSimulateCall.mock.calls.filter(([m]: [string]) => m === method).length;
}

/**
 * Queue a resolving call of `get_supported_claim_types` followed by a
 * sequence of `get_credential` results in `uniqueIdOrder`.
 *
 * `mockResolvedValueOnce` returns the queued values in order, so the caller
 * is responsible for providing values in the same order as they will be
 * consumed. The handler awaits the global lookup BEFORE fanning out the
 * parallel `get_credential` calls, and the parallel calls are dispatched
 * synchronously in `uniquePairs` order — so this queue is deterministic.
 */
function installMock(opts: {
  supportedClaims?: unknown[] | Error;
  credentials: Array<{ id: number; record?: Record<string, unknown> | Error }>;
}): void {
  if (opts.supportedClaims instanceof Error) {
    mockSimulateCall.mockRejectedValueOnce(opts.supportedClaims);
  } else {
    mockSimulateCall.mockResolvedValueOnce(opts.supportedClaims ?? ['name', 'age', 'address']);
  }
  for (const { id, record } of opts.credentials) {
    if (record instanceof Error) {
      mockSimulateCall.mockRejectedValueOnce(record);
    } else {
      mockSimulateCall.mockResolvedValueOnce(credRecord({ id, ...record }));
    }
  }
}

describe('POST /api/verify/batch', () => {
  beforeEach(() => mockSimulateCall.mockReset());

  // ── Happy path ──────────────────────────────────────────────────────────
  it('returns verified results for valid (credential_id, claim_type) pairs', async () => {
    installMock({
      supportedClaims: ['name', 'age'],
      credentials: [
        { id: 1, record: {} },
        { id: 2, record: {} },
      ],
    });

    const res = await request(app)
      .post('/api/verify/batch')
      .send({
        items: [
          { credential_id: 1, claim_type: 'name' },
          { credential_id: 2, claim_type: 'age' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0].status).toBe('verified');
    expect(res.body.results[0].proof).not.toBeNull();
    expect(res.body.results[0].proof.verified_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.body.results[0].proof.digest).toMatch(/^[0-9a-f]{16}$/);
    expect(res.body.results[1].status).toBe('verified');
    expect(res.body.summary).toMatchObject({
      total: 2,
      verified: 2,
      duplicates_deduplicated: 0,
    });

    // Global claim-types lookup is invoked exactly once per batch.
    expect(callCount('get_supported_claim_types')).toBe(1);
    // One get_credential per distinct credential id.
    expect(callCount('get_credential')).toBe(2);
  });

  // ── Deduplication across identical pairs ────────────────────────────────
  it('deduplicates identical (credential_id, claim_type) pairs and reuses the result', async () => {
    installMock({
      supportedClaims: ['name'],
      credentials: [
        { id: 1, record: {} },
        { id: 2, record: {} },
      ],
    });

    const res = await request(app)
      .post('/api/verify/batch')
      .send({
        items: [
          { credential_id: 1, claim_type: 'name' },
          { credential_id: 1, claim_type: 'name' },
          { credential_id: 1, claim_type: 'name' },
          { credential_id: 2, claim_type: 'name' },
          { credential_id: 2, claim_type: 'name' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(5);
    expect(res.body.results.every((r: any) => r.status === 'verified')).toBe(true);

    // Fanned-out duplicates for the SAME `(credential_id, claim_type)` share
    // the same proof payload, while items with different pairs have different
    // digests (because the digest is keyed off `credential_id`+`claim_type`).
    expect(res.body.results[0].proof.digest).toEqual(res.body.results[1].proof.digest);
    expect(res.body.results[1].proof.digest).toEqual(res.body.results[2].proof.digest);
    expect(res.body.results[3].proof.digest).toEqual(res.body.results[4].proof.digest);
    expect(res.body.results[0].proof.digest).not.toEqual(res.body.results[3].proof.digest);

    expect(res.body.summary).toMatchObject({
      total: 5,
      verified: 5,
      duplicates_deduplicated: 3,
    });

    // Two unique credential ids ⇒ two get_credential calls.
    expect(callCount('get_credential')).toBe(2);
  });

  // ── Reuses same credential across many claim types ─────────────────────
  it('reuses a credential snapshot across multiple claim types on the same id', async () => {
    installMock({
      supportedClaims: ['name', 'age', 'address'],
      credentials: [{ id: 1, record: {} }],
    });

    const res = await request(app)
      .post('/api/verify/batch')
      .send({
        items: [
          { credential_id: 1, claim_type: 'name' },
          { credential_id: 1, claim_type: 'age' },
          { credential_id: 1, claim_type: 'address' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.results.every((r: any) => r.status === 'verified')).toBe(true);
    expect(res.body.summary.duplicates_deduplicated).toBe(0);

    // The credential MUST be looked up exactly once despite three items
    // pointing at the same credential id.
    expect(callCount('get_credential')).toBe(1);
  });

  // ── Lifecycle handling ────────────────────────────────────────────────
  it('marks revoked credentials as revoked', async () => {
    installMock({
      supportedClaims: ['name'],
      credentials: [{ id: 1, record: { revoked: true } }],
    });

    const res = await request(app)
      .post('/api/verify/batch')
      .send({ items: [{ credential_id: 1, claim_type: 'name' }] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe('revoked');
    expect(res.body.results[0].proof).toBeNull();
    expect(res.body.summary.verified).toBe(0);
  });

  it('marks expired credentials as expired', async () => {
    installMock({
      supportedClaims: ['name'],
      credentials: [
        { id: 1, record: { expires_at: new Date(Date.now() - 60_000).toISOString() } },
      ],
    });

    const res = await request(app)
      .post('/api/verify/batch')
      .send({ items: [{ credential_id: 1, claim_type: 'name' }] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe('expired');
  });

  it("marks claim types not in the global list as 'failed'", async () => {
    installMock({
      supportedClaims: ['name'], // 'age' is intentionally not listed
      credentials: [{ id: 1, record: {} }],
    });

    const res = await request(app)
      .post('/api/verify/batch')
      .send({ items: [{ credential_id: 1, claim_type: 'age' }] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe('failed');
    expect(res.body.results[0].proof).toBeNull();
  });

  it('treats any claim type as supported when get_supported_claim_types is unavailable', async () => {
    // If the contract doesn't expose get_supported_claim_types, the route
    // degrades gracefully and treats the missing list as "all claim types
    // allowed" so callers aren't blocked.
    installMock({
      supportedClaims: new Error('MethodMissing'),
      credentials: [{ id: 1, record: {} }],
    });

    const res = await request(app)
      .post('/api/verify/batch')
      .send({ items: [{ credential_id: 1, claim_type: 'name' }] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe('verified');
  });

  // ── Error / not-found handling ─────────────────────────────────────────
  it('returns not_found when the credential does not exist', async () => {
    installMock({
      supportedClaims: ['name'],
      credentials: [{ id: 999, record: new Error('CredentialNotFound') }],
    });

    const res = await request(app)
      .post('/api/verify/batch')
      .send({ items: [{ credential_id: 999, claim_type: 'name' }] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe('not_found');
    expect(res.body.results[0].error).toBeNull();
    expect(res.body.summary.not_found).toBe(1);
  });

  it('returns error status for unrelated Soroban failures', async () => {
    installMock({
      supportedClaims: ['name'],
      credentials: [{ id: 1, record: new Error('RPC timeout') }],
    });

    const res = await request(app)
      .post('/api/verify/batch')
      .send({ items: [{ credential_id: 1, claim_type: 'name' }] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe('error');
    expect(res.body.results[0].error).toContain('RPC timeout');
    expect(res.body.summary.errors).toBe(1);
  });

  // ── body validation ───────────────────────────────────────────────────
  it.each([
    ['empty array', { items: [] }],
    ['missing items', { foo: 'bar' }],
    ['non-array items', { items: 'nope' }],
    [
      'over 100 items',
      { items: Array.from({ length: 101 }, () => ({ credential_id: 1, claim_type: 'x' })) },
    ],
    ['non-positive credential_id', { items: [{ credential_id: 0, claim_type: 'x' }] }],
    ['missing claim_type', { items: [{ credential_id: 1 }] }],
    ['blank claim_type', { items: [{ credential_id: 1, claim_type: '' }] }],
  ])('returns 400 for %s', async (_label, payload) => {
    const res = await request(app).post('/api/verify/batch').send(payload);
    expect(res.status).toBe(400);
  });

  // ── Order preservation ──────────────────────────────────────────────
  it('preserves the original input order in the response', async () => {
    installMock({
      supportedClaims: ['name', 'age', 'address'],
      credentials: [
        { id: 2, record: {} },
        { id: 1, record: {} },
      ],
    });

    const res = await request(app)
      .post('/api/verify/batch')
      .send({
        items: [
          { credential_id: 2, claim_type: 'age' },
          { credential_id: 1, claim_type: 'name' },
          { credential_id: 2, claim_type: 'name' },
          { credential_id: 1, claim_type: 'address' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.results.map((r: any) => r.credential_id)).toEqual([2, 1, 2, 1]);
    expect(res.body.results.map((r: any) => r.claim_type)).toEqual([
      'age',
      'name',
      'name',
      'address',
    ]);
  });

  // ── Performance — dedupe really shrinks Soroban traffic ────────────
  describe('performance', () => {
    it('100 items → still 20 credential lookups and 1 global claims lookup', async () => {
      // 20 distinct credentials × 5 copies each = 100 input items.
      const uniqueIds = 20;
      const copiesPerId = 5;
      const items: Array<{ credential_id: number; claim_type: string }> = [];
      const credentials: Array<{ id: number; record?: Record<string, unknown> }> = [];
      for (let i = 1; i <= uniqueIds; i++) {
        credentials.push({ id: i, record: {} });
        for (let c = 0; c < copiesPerId; c++) {
          items.push({ credential_id: i, claim_type: 'name' });
        }
      }
      installMock({ supportedClaims: ['name'], credentials });

      const startedAt = Date.now();
      const res = await request(app).post('/api/verify/batch').send({ items });
      const elapsed = Date.now() - startedAt;

      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(uniqueIds * copiesPerId);
      expect(res.body.summary.verified).toBe(uniqueIds * copiesPerId);
      expect(res.body.summary.duplicates_deduplicated).toBe(
        uniqueIds * copiesPerId - uniqueIds
      );

      expect(callCount('get_supported_claim_types')).toBe(1);
      expect(callCount('get_credential')).toBe(uniqueIds);

      expect(elapsed).toBeLessThan(2_000);
    });

    it('50-item varied batch completes in under 1 second against the mock', async () => {
      const items: Array<{ credential_id: number; claim_type: string }> = [];
      const credentials: Array<{ id: number; record?: Record<string, unknown> }> = [];
      for (let i = 1; i <= 50; i++) {
        credentials.push({ id: i, record: {} });
        items.push({ credential_id: i, claim_type: i % 2 === 0 ? 'name' : 'age' });
      }
      installMock({ supportedClaims: ['name', 'age'], credentials });

      const startedAt = Date.now();
      const res = await request(app).post('/api/verify/batch').send({ items });
      const elapsed = Date.now() - startedAt;

      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(50);
      expect(res.body.summary.verified).toBe(50);
      expect(elapsed).toBeLessThan(1_000);
    });
  });
});
