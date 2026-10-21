import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const { submitCall, simulateCall } = vi.hoisted(() => ({
  submitCall: vi.fn(),
  simulateCall: vi.fn(),
}));

vi.mock('../src/soroban.js', () => ({
  simulateCall,
  submitCall,
  u64Val: (value: number | bigint) => value,
  u32Val: (value: number) => value,
  addressVal: (value: string) => value,
}));

import { createShareLinksRouter } from '../src/routes/shareLinks.js';

function createApp() {
  const soroban = {
    simulateCall,
    u64Val: async (value: number | bigint) => value,
    u32Val: async (value: number) => value,
    addressVal: async (value: string) => value,
  };
  const app = express();
  app.use(express.json());
  app.use('/api/credentials', createShareLinksRouter(soroban));
  return app;
}

describe('share-link transactions', () => {
  beforeEach(() => {
    submitCall.mockReset().mockResolvedValue({
      status: 'confirmed',
      transaction_hash: 'confirmed-share-hash',
      result: null,
    });
    simulateCall.mockReset();
  });

  it('creates a share link only after its transaction is confirmed', async () => {
    const token = Buffer.alloc(16);
    token.writeBigUInt64BE(123456n, 8);
    submitCall.mockResolvedValueOnce({
      status: 'confirmed',
      transaction_hash: 'confirmed-create-hash',
      result: token,
    });
    const app = createApp();

    const response = await request(app)
      .post('/api/credentials/7/share')
      .send({ subject: 'GSUBJECT', expiry_hours: 24, permission: 'view_only' });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      token: token.toString('hex'),
      expires_at: 123456,
      transaction_hash: 'confirmed-create-hash',
      status: 'confirmed',
    });
    expect(submitCall).toHaveBeenCalledWith('generate_share_link', expect.any(Array), undefined);
  });

  it('requires caller authorization before reporting a share link revoked', async () => {
    submitCall.mockResolvedValueOnce({
      status: 'prepared',
      transaction_xdr: 'unsigned-revoke-xdr',
      authorization_entries_xdr: ['unsigned-revoke-auth-xdr'],
    });
    const app = createApp();

    const response = await request(app)
      .delete(`/api/credentials/share/${'ab'.repeat(16)}`)
      .send({ subject: 'GSUBJECT' });

    expect(response.status).toBe(428);
    expect(response.body.success).toBeUndefined();
    expect(response.body.transaction_xdr).toBe('unsigned-revoke-xdr');
  });

  it('returns success and the transaction hash only after revocation is confirmed', async () => {
    const app = createApp();

    const response = await request(app)
      .delete(`/api/credentials/share/${'ab'.repeat(16)}`)
      .send({ subject: 'GSUBJECT', signed_transaction_xdr: 'signed-revoke-xdr' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      transaction_hash: 'confirmed-share-hash',
      status: 'confirmed',
    });
    expect(submitCall).toHaveBeenCalledWith(
      'revoke_share_link',
      expect.any(Array),
      'signed-revoke-xdr',
    );
  });

  it('checks share validation against the contract state', async () => {
    simulateCall.mockRejectedValueOnce(new Error('InvalidInput: revoked link'));
    const app = createApp();

    const response = await request(app)
      .post('/api/credentials/share/validate')
      .send({ token: 'ab'.repeat(16) });

    expect(response.status).toBe(410);
    expect(simulateCall).toHaveBeenCalledWith(
      'validate_share_token',
      expect.any(Array),
      { cache: false },
    );
  });
});
