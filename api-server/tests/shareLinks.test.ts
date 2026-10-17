import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Keypair, scValToNative } from '@stellar/stellar-sdk';
import { assertShareLinkHmacSecretConfigured, createShareLinksRouter } from '../src/routes/shareLinks.js';
import * as soroban from '../src/soroban.js';

const mockSimulateCall = vi.fn<typeof soroban.simulateCall>();

function makeToken(credentialId: bigint): Buffer {
  const token = Buffer.alloc(16);
  token.writeBigUInt64BE(credentialId, 0);
  token.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000) + 3600), 8);
  return token;
}

describe('Share-link password hashing', () => {
  const keypair = Keypair.random();
  const app = express();

  app.use(express.json());
  app.use('/api/credentials', createShareLinksRouter({
    simulateCall: mockSimulateCall,
    u64Val: soroban.u64Val,
    u32Val: soroban.u32Val,
    addressVal: soroban.addressVal,
  }));

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('uses the same 32-byte scrypt digest when creating and validating a password link', async () => {
    const token = makeToken(42n);
    mockSimulateCall.mockResolvedValueOnce(token).mockResolvedValueOnce({ credential_id: 42n });

    const created = await request(app)
      .post('/api/credentials/42/share')
      .send({
        subject: keypair.publicKey(),
        expiry_hours: 1,
        permission: 'view_only',
        password: 'a long password',
      });
    expect(created.status).toBe(201);

    const creationCall = mockSimulateCall.mock.calls[0];
    expect(creationCall).toBeDefined();
    if (!creationCall) throw new Error('Share creation call was not made');
    const createdHash = Buffer.from(scValToNative(creationCall[1][3]) as Uint8Array);
    expect(createdHash).toHaveLength(32);

    const validated = await request(app)
      .post('/api/credentials/share/validate')
      .send({ token: token.toString('hex'), password: 'a long password' });
    expect(validated.status).toBe(200);

    const validationCall = mockSimulateCall.mock.calls[1];
    expect(validationCall).toBeDefined();
    if (!validationCall) throw new Error('Share validation call was not made');
    const validatedHash = Buffer.from(scValToNative(validationCall[1][1]) as Uint8Array);
    expect(validatedHash).toEqual(createdHash);
  });

  it('requires the HMAC secret outside development and test environments', () => {
    const previousSecret = process.env.SHARE_LINK_HMAC_SECRET;
    const previousNodeEnv = process.env.NODE_ENV;
    delete process.env.SHARE_LINK_HMAC_SECRET;
    process.env.NODE_ENV = 'production';

    try {
      expect(() => assertShareLinkHmacSecretConfigured()).toThrow(
        'SHARE_LINK_HMAC_SECRET must be configured outside local development',
      );
    } finally {
      if (previousSecret === undefined) delete process.env.SHARE_LINK_HMAC_SECRET;
      else process.env.SHARE_LINK_HMAC_SECRET = previousSecret;
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });
});
