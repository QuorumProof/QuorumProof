import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { credentialTieringService, type CredentialTier } from '../src/services/credentialTiering.js';
import { publishTierAdvancedEvent, publishTierPointsAccruedEvent } from '../src/services/tierRedemptionEvents.js';
import { createCredentialTieringRouter } from '../src/routes/credentialTiering.js';
import { createCredentialTiersRouter } from '../src/routes/credentialTiers.js';

const { pool, client } = vi.hoisted(() => {
  const client = { query: vi.fn(), release: vi.fn() };
  const pool = { query: vi.fn(), connect: vi.fn() };
  return { pool, client };
});

vi.mock('../src/db.js', () => ({ getPool: () => pool }));
vi.mock('../src/services/tierRedemptionEvents.js', () => ({
  publishTierAdvancedEvent: vi.fn(),
  publishTierPointsAccruedEvent: vi.fn(),
}));

const getOrCreateTier = vi.spyOn(credentialTieringService, 'getOrCreateTier');
const getTiersByTier = vi.spyOn(credentialTieringService, 'getTiersByTier');
const getTierStats = vi.spyOn(credentialTieringService, 'getTierStats');
const updateReputationScore = vi.spyOn(credentialTieringService, 'updateReputationScore');
const checkAndPromoteTier = vi.spyOn(credentialTieringService, 'checkAndPromoteTier');

const tieringApp = express();
tieringApp.use(express.json());
tieringApp.use('/api/tiering', createCredentialTieringRouter());

const tiersApp = express();
tiersApp.use(express.json());
tiersApp.use('/api/credentials', createCredentialTiersRouter());

const tier: CredentialTier = {
  id: 'tier_42',
  credential_id: 42,
  tier: 'silver',
  reputation_score: 120,
  created_at: '2025-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  promoted_at: null,
};

describe('credential tiering routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pool.query.mockReset();
    pool.connect.mockReset();
    client.query.mockReset();
    client.release.mockReset();
    pool.query.mockResolvedValue({ rows: [] });
    pool.connect.mockResolvedValue(client);
    client.query.mockResolvedValue({ rows: [] });

    getOrCreateTier.mockResolvedValue(tier);
    getTiersByTier.mockResolvedValue([tier]);
    getTierStats.mockResolvedValue([{ tier: 'silver', count: 1, avg_reputation: 120 }]);
    updateReputationScore.mockResolvedValue(tier);
    checkAndPromoteTier.mockResolvedValue(tier);
  });

  describe('GET /api/tiering/:credentialId/tier', () => {
    it('returns or creates a credential tier', async () => {
      const res = await request(tieringApp).get('/api/tiering/42/tier');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ credential_id: 42, tier: 'silver', reputation_score: 120 });
      expect(getOrCreateTier).toHaveBeenCalledWith(42);
    });

    it('rejects invalid credential IDs', async () => {
      const res = await request(tieringApp).get('/api/tiering/0/tier');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid credential ID');
      expect(getOrCreateTier).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/tiering/tier/:tier', () => {
    it('returns a tier page and applies pagination parameters', async () => {
      const res = await request(tieringApp).get('/api/tiering/tier/gold?limit=20&offset=10');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([tier]);
      expect(getTiersByTier).toHaveBeenCalledWith('gold', 20, 10);
    });

    it('rejects unknown tiers', async () => {
      const res = await request(tieringApp).get('/api/tiering/tier/platinum');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid tier');
      expect(getTiersByTier).not.toHaveBeenCalled();
    });
  });

  it('returns tier statistics', async () => {
    const res = await request(tieringApp).get('/api/tiering/stats');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ tier: 'silver', count: 1, avg_reputation: 120 }]);
    expect(getTierStats).toHaveBeenCalledOnce();
  });

  describe('POST /api/tiering/:credentialId/reputation', () => {
    it('updates reputation score by the requested increment', async () => {
      const res = await request(tieringApp)
        .post('/api/tiering/42/reputation')
        .send({ scoreIncrement: 15 });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ credential_id: 42, reputation_score: 120 });
      expect(updateReputationScore).toHaveBeenCalledWith(42, 15);
    });

    it('rejects non-numeric score increments', async () => {
      const res = await request(tieringApp)
        .post('/api/tiering/42/reputation')
        .send({ scoreIncrement: '15' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('scoreIncrement');
      expect(updateReputationScore).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/tiering/:credentialId/check-promotion', () => {
    it('returns the resulting tier when checking promotion', async () => {
      const res = await request(tieringApp).post('/api/tiering/42/check-promotion');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ credential_id: 42, tier: 'silver' });
      expect(checkAndPromoteTier).toHaveBeenCalledWith(42);
    });

    it('returns not found when no tier exists', async () => {
      checkAndPromoteTier.mockResolvedValueOnce(null);

      const res = await request(tieringApp).post('/api/tiering/42/check-promotion');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Credential tier not found');
    });
  });
});

describe('credential tiers routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pool.query.mockReset();
    pool.connect.mockReset();
    client.query.mockReset();
    client.release.mockReset();
    pool.query.mockResolvedValue({ rows: [] });
    pool.connect.mockResolvedValue(client);
    client.query.mockResolvedValue({ rows: [] });
  });

  it('returns a credential tier with its benefits', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{
          credential_id: 42,
          tier: 'silver',
          tier_points: 120,
          tier_acquired_at: '2026-01-01T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ benefit_name: 'priority_support', benefit_value: 'enabled' }],
      });

    const res = await request(tiersApp).get('/api/credentials/42/tier');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      credential_id: 42,
      tier: 'silver',
      tier_points: 120,
      tier_acquired_at: '2026-01-01T00:00:00.000Z',
      benefits: { priority_support: 'enabled' },
    });
  });

  it('returns not found when a credential has no tier', async () => {
    const res = await request(tiersApp).get('/api/credentials/999/tier');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Credential tier not found');
  });

  it('advances a tier after the required points are met and commits the log', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ tier: 'bronze', tier_points: 100 }] })
      .mockResolvedValueOnce({ rows: [{ min_points: 100, min_attestations: 1, min_age_days: 1 }] });

    const res = await request(tiersApp).post('/api/credentials/42/tier/advance');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ credential_id: '42', from_tier: 'bronze', to_tier: 'silver' });
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      expect.stringContaining('UPDATE credential_tiers'),
      expect.stringContaining('INSERT INTO tier_advancement_log'),
      'COMMIT',
    ]);
    expect(client.release).toHaveBeenCalledOnce();
    expect(publishTierAdvancedEvent).toHaveBeenCalledWith(42, 'bronze', 'silver', 100);
  });

  it('does not advance a tier when its points requirement is unmet', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ tier: 'bronze', tier_points: 20 }] })
      .mockResolvedValueOnce({ rows: [{ min_points: 100, min_attestations: 1, min_age_days: 1 }] });

    const res = await request(tiersApp).post('/api/credentials/42/tier/advance');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Need 100, have 20');
    expect(pool.connect).not.toHaveBeenCalled();
    expect(publishTierAdvancedEvent).not.toHaveBeenCalled();
  });

  it('adds positive points and publishes the accrual event', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ credential_id: 42, tier: 'silver', tier_points: 125 }],
    });

    const res = await request(tiersApp)
      .post('/api/credentials/42/tier/points')
      .send({ points: 5, reason: 'completed training' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ credential_id: 42, tier: 'silver', tier_points: 125 });
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE credential_tiers'), [5, '42']);
    expect(publishTierPointsAccruedEvent).toHaveBeenCalledWith(42, 5, 'silver', 125);
  });

  it('rejects non-positive tier points', async () => {
    const res = await request(tiersApp)
      .post('/api/credentials/42/tier/points')
      .send({ points: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Points must be a positive number');
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('returns tier advancement requirements', async () => {
    const requirements = [{ tier: 'silver', min_points: 100, min_attestations: 1, min_age_days: 30 }];
    pool.query.mockResolvedValueOnce({ rows: requirements });

    const res = await request(tiersApp).get('/api/credentials/tiers/requirements');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(requirements);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('FROM tier_requirements'));
  });

  it('returns advancement history for a credential', async () => {
    const history = [{
      credential_id: 42,
      from_tier: 'bronze',
      to_tier: 'silver',
      reason: 'earned points',
      advanced_at: '2026-01-01T00:00:00.000Z',
    }];
    pool.query.mockResolvedValueOnce({ rows: history });

    const res = await request(tiersApp).get('/api/credentials/42/tier/history');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(history);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('FROM tier_advancement_log'), ['42']);
  });
});
