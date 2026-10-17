import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createShareLinksRouter } from '../src/routes/shareLinks.js';

const originalSecret = process.env.SHARE_LINK_HMAC_SECRET;
const soroban = {
  simulateCall: async () => null,
  u64Val: (value: number | bigint) => value,
  u32Val: (value: number) => value,
  addressVal: (value: string) => value,
};

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/credentials', createShareLinksRouter(soroban));
  return app;
}

afterEach(() => {
  if (originalSecret === undefined) {
    delete process.env.SHARE_LINK_HMAC_SECRET;
  } else {
    process.env.SHARE_LINK_HMAC_SECRET = originalSecret;
  }
});

describe('share-link password secret', () => {
  it('fails closed when creating a password-protected link without a strong secret', async () => {
    delete process.env.SHARE_LINK_HMAC_SECRET;
    const response = await request(createApp())
      .post('/api/credentials/12/share')
      .send({
        subject: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        expiry_hours: 1,
        permission: 'view_only',
        password: 'password123',
      });

    expect(response.status).toBe(503);
    expect(response.body.error).toContain('SHARE_LINK_HMAC_SECRET');
  });

  it('fails closed when validating a password-protected link with a weak secret', async () => {
    process.env.SHARE_LINK_HMAC_SECRET = 'quorumproof';
    const response = await request(createApp())
      .post('/api/credentials/share/validate')
      .send({ token: '00'.repeat(16), password: 'password123' });

    expect(response.status).toBe(503);
    expect(response.body.error).toContain('SHARE_LINK_HMAC_SECRET');
  });
});
