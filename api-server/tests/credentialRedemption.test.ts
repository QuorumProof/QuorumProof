import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockPoolQuery, mockClientQuery, mockRelease, mockRequestedEvent, mockClaimedEvent } = vi.hoisted(() => ({
  mockPoolQuery: vi.fn(),
  mockClientQuery: vi.fn(),
  mockRelease: vi.fn(),
  mockRequestedEvent: vi.fn(),
  mockClaimedEvent: vi.fn(),
}));

vi.mock('../src/db.js', () => ({
  getPool: () => ({
    query: mockPoolQuery,
    connect: async () => ({ query: mockClientQuery, release: mockRelease }),
  }),
}));

vi.mock('../src/services/tierRedemptionEvents.js', () => ({
  publishRedemptionRequestedEvent: mockRequestedEvent,
  publishRedemptionClaimedEvent: mockClaimedEvent,
}));

import { createCredentialRedemptionRouter } from '../src/routes/credentialRedemption.js';

const app = express();
app.use(express.json());
app.use('/api/credentials', createCredentialRedemptionRouter());

beforeEach(() => {
  mockPoolQuery.mockReset();
  mockClientQuery.mockReset();
  mockRelease.mockReset();
  mockRequestedEvent.mockReset();
  mockClaimedEvent.mockReset();
});

describe('credential reward and redemption routes', () => {
  it('returns a reward balance and reports a missing account', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ credential_id: 7, reward_points: 120, accumulated_value: '45.50' }],
    });
    const found = await request(app).get('/api/credentials/7/rewards');
    expect(found.status).toBe(200);
    expect(found.body).toEqual({ credential_id: 7, reward_points: 120, accumulated_value: '45.50' });

    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const missing = await request(app).get('/api/credentials/8/rewards');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('Reward account not found');
  });

  it('validates and accrues reward points and value', async () => {
    const invalid = await request(app).post('/api/credentials/7/rewards/accrue').send({ points: 0 });
    expect(invalid.status).toBe(400);
    expect(mockPoolQuery).not.toHaveBeenCalled();

    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ credential_id: 7, reward_points: 150, accumulated_value: '50.5' }],
    });
    const accrued = await request(app)
      .post('/api/credentials/7/rewards/accrue')
      .send({ points: 30, value: '5.00' });
    expect(accrued.status).toBe(200);
    expect(accrued.body).toEqual({ credential_id: 7, reward_points: 150, accumulated_value: '50.5' });
    expect(mockPoolQuery.mock.calls[0][1]).toEqual([30, 5, '7']);
  });

  it('rejects insufficient funds and atomically submits a redemption request', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ accumulated_value: '10.00' }] });
    const insufficient = await request(app)
      .post('/api/credentials/7/redemptions')
      .send({ amount: '12', destination_address: 'GDESTINATION' });
    expect(insufficient.status).toBe(400);
    expect(mockClientQuery).not.toHaveBeenCalled();

    mockPoolQuery.mockResolvedValueOnce({ rows: [{ accumulated_value: '20.00' }] });
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 31 }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 42,
          credential_id: 7,
          amount: '12.00',
          destination_address: 'GDESTINATION',
          status: 'pending',
          submitted_at: '2026-10-17T10:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const submitted = await request(app)
      .post('/api/credentials/7/redemptions')
      .send({ amount: '12', destination_address: 'GDESTINATION', reason: 'Payout' });
    expect(submitted.status).toBe(201);
    expect(submitted.body).toMatchObject({
      id: 42,
      credential_id: 7,
      amount: '12.00',
      destination_address: 'GDESTINATION',
      status: 'pending',
    });
    expect(mockClientQuery.mock.calls.map(([sql]) => String(sql).trim().split(/\s+/)[0])).toEqual([
      'BEGIN', 'INSERT', 'INSERT', 'UPDATE', 'INSERT', 'COMMIT',
    ]);
    expect(mockRequestedEvent).toHaveBeenCalledWith(7, 42, '12.00', 'GDESTINATION');
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it('filters redemption history and returns the ledger with the requested limit', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 42, status: 'claimed' }] });
    const history = await request(app).get('/api/credentials/7/redemptions?status=claimed&limit=20');
    expect(history.status).toBe(200);
    expect(history.body).toEqual([{ id: 42, status: 'claimed' }]);
    expect(mockPoolQuery.mock.calls[0][1]).toEqual(['7', 'claimed', 20]);

    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 9, transaction_type: 'redemption_request' }] });
    const ledger = await request(app).get('/api/credentials/7/ledger?limit=25');
    expect(ledger.status).toBe(200);
    expect(ledger.body).toEqual([{ id: 9, transaction_type: 'redemption_request' }]);
    expect(mockPoolQuery.mock.calls[1][1]).toEqual(['7', 25]);
  });

  it('only claims approved redemptions and publishes after the transaction commits', async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 42, status: 'pending', amount: '12.00' }] });
    const rejected = await request(app).post('/api/credentials/7/redemptions/42/claim');
    expect(rejected.status).toBe(400);
    expect(mockClientQuery.mock.calls.map(([sql]) => String(sql).trim().match(/^\w+/)?.[0])).toEqual([
      'BEGIN', 'SELECT', 'ROLLBACK',
    ]);
    expect(mockClaimedEvent).not.toHaveBeenCalled();

    mockClientQuery.mockReset();
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 42, status: 'approved', amount: '12.00' }] })
      .mockResolvedValueOnce({ rows: [{ id: 42, status: 'claimed', processed_at: 'now' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const claimed = await request(app).post('/api/credentials/7/redemptions/42/claim');
    expect(claimed.status).toBe(200);
    expect(claimed.body).toEqual({ id: 42, status: 'claimed', processed_at: 'now' });
    expect(mockClientQuery.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    expect(mockClaimedEvent).toHaveBeenCalledWith(7, 42, '12.00');
    expect(mockRelease).toHaveBeenCalledTimes(2);
  });
});
