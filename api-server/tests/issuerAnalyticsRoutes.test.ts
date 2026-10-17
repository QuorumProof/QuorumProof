import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createIssuerAnalyticsRouter } from '../src/routes/issuerAnalytics.js';
import { metricsStore } from '../src/services/metrics.js';

const simulateCall = vi.fn();
const soroban = {
  simulateCall,
  u64Val: (value: number | bigint) => value,
  u32Val: (value: number) => value,
  addressVal: (value: string) => value,
};

const app = express();
app.use('/api/analytics', createIssuerAnalyticsRouter(soroban));

describe('issuer analytics routes', () => {
  beforeEach(() => {
    metricsStore.reset();
    simulateCall.mockReset();
  });

  describe('GET /credentials', () => {
    it('returns issuer-scoped issuance totals, type breakdown, and expiry buckets', async () => {
      const now = new Date().toISOString();
      simulateCall
        .mockResolvedValueOnce(3n)
        .mockResolvedValueOnce({
          issuer: 'issuer-a',
          created_at: now,
          credential_type: 'identity',
          expires_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
        })
        .mockResolvedValueOnce({
          issuer: 'issuer-a',
          created_at: now,
          credential_type: 'identity',
          expires_at: null,
        })
        .mockResolvedValueOnce({
          issuer: 'issuer-b',
          created_at: now,
          credential_type: 'license',
          expires_at: now,
        });

      const res = await request(app).get('/api/analytics/credentials?issuer=issuer-a&range=7d');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        issuer: 'issuer-a',
        range: '7d',
        total_issued: 2,
        by_type: { identity: 2 },
        expiry_distribution: { expiring_7d: 1, no_expiry: 1 },
      });
      expect(simulateCall).toHaveBeenCalledTimes(4);
    });

    it('requires an issuer and rejects unsupported ranges', async () => {
      const missingIssuer = await request(app).get('/api/analytics/credentials');
      expect(missingIssuer.status).toBe(400);
      expect(missingIssuer.body.error).toContain('issuer');

      const invalidRange = await request(app).get('/api/analytics/credentials?issuer=issuer-a&range=365d');
      expect(invalidRange.status).toBe(400);
      expect(invalidRange.body.error).toContain('range');
      expect(simulateCall).not.toHaveBeenCalled();
    });

    it('returns a server error when the credential count lookup fails', async () => {
      simulateCall.mockRejectedValueOnce(new Error('RPC unavailable'));

      const res = await request(app).get('/api/analytics/credentials?issuer=issuer-a');

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('RPC unavailable');
    });
  });

  describe('GET /verifications', () => {
    it('groups verified events by claim type and verifier', async () => {
      const timestamp = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      metricsStore.recordEvent({
        type: 'verified',
        credential_id: 'credential-1',
        timestamp,
        metadata: { claim_type: 'identity', verifier: 'verifier-a' },
      });
      metricsStore.recordEvent({
        type: 'verified',
        credential_id: 'credential-2',
        timestamp,
        metadata: { claim_type: 'identity', verifier: 'verifier-b' },
      });
      metricsStore.recordEvent({
        type: 'issued',
        credential_id: 'credential-3',
        timestamp,
        metadata: { claim_type: 'identity', verifier: 'verifier-a' },
      });

      const res = await request(app).get('/api/analytics/verifications?range=30d');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        range: '30d',
        total_verifications: 2,
        by_claim_type: { identity: 2 },
        verifier_distribution: { 'verifier-a': 1, 'verifier-b': 1 },
      });
    });

    it('rejects unsupported ranges', async () => {
      const res = await request(app).get('/api/analytics/verifications?range=all');

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('range');
    });
  });

  describe('GET /disputes', () => {
    it('calculates issuer dispute rate, resolution time, and common reasons', async () => {
      const openedAt = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      const resolvedAt = new Date(Date.parse(openedAt) + 2 * 60 * 60 * 1000).toISOString();
      for (const id of ['issued-1', 'issued-2']) {
        metricsStore.recordEvent({
          type: 'issued',
          credential_id: id,
          timestamp: openedAt,
          issuer: 'issuer-a',
        });
      }
      metricsStore.recordEvent({
        type: 'issued',
        credential_id: 'issued-3',
        timestamp: openedAt,
        issuer: 'issuer-b',
      });
      metricsStore.recordEvent({
        type: 'disputed',
        credential_id: 'disputed-a',
        timestamp: openedAt,
        issuer: 'issuer-a',
        metadata: { reason: 'incorrect claim', resolved_at: resolvedAt },
      });
      metricsStore.recordEvent({
        type: 'disputed',
        credential_id: 'disputed-b',
        timestamp: openedAt,
        issuer: 'issuer-b',
        metadata: { reason: 'other' },
      });

      const res = await request(app).get('/api/analytics/disputes?issuer=issuer-a&range=90d');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        issuer: 'issuer-a',
        range: '90d',
        total_disputes: 1,
        dispute_rate: 0.5,
        avg_resolution_time_ms: 2 * 60 * 60 * 1000,
        common_reasons: [{ reason: 'incorrect claim', count: 1 }],
      });
    });

    it('returns zero rate and no resolution time when there are no matching events', async () => {
      const res = await request(app).get('/api/analytics/disputes?issuer=unknown');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        issuer: 'unknown',
        total_disputes: 0,
        dispute_rate: 0,
        avg_resolution_time_ms: null,
        common_reasons: [],
      });
    });
  });
});
