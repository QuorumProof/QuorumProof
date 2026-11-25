import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@stellar/stellar-sdk';
import walletLinkRouter, { buildWalletLinkMessage } from '../src/routes/walletLink.js';
import { SessionManager, _setDefaultSessionManagerForTest } from '../src/services/sessionManager.js';
import { UserWalletStore, _setDefaultUserWalletStoreForTest } from '../src/services/userWalletStore.js';

describe('POST /api/auth/wallet/link validation', () => {
  let app: express.Express;
  let tempDir: string;
  let token: string;
  let walletStore: UserWalletStore;
  const holder = Keypair.random();

  beforeEach(() => {
    process.env.JWT_SECRET = 'test-wallet-link-validation-secret';
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-link-validate-'));
    const sessions = new SessionManager({ dataDir: path.join(tempDir, 'sessions') });
    _setDefaultSessionManagerForTest(sessions);
    token = sessions.createSession('wallet-user').accessToken;
    walletStore = new UserWalletStore({ dataDir: path.join(tempDir, 'wallets') });
    _setDefaultUserWalletStoreForTest(walletStore);

    app = express();
    app.use(express.json());
    app.use('/api/auth/wallet/link', walletLinkRouter);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    _setDefaultSessionManagerForTest(undefined);
    _setDefaultUserWalletStoreForTest(undefined);
  });

  it('rejects missing required fields via validate()', async () => {
    const res = await request(app)
      .post('/api/auth/wallet/link')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.location).toBe('body');
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  it('rejects malformed Stellar address format via validate()', async () => {
    const res = await request(app)
      .post('/api/auth/wallet/link')
      .set('Authorization', `Bearer ${token}`)
      .send({
        stellarAddress: 'not-a-valid-stellar-address',
        signature: 'a'.repeat(128),
      });

    expect(res.status).toBe(400);
    expect(res.body.location).toBe('body');
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  it('rejects Stellar G-address with invalid checksum via custom validator', async () => {
    const validKey = holder.publicKey();
    const lastChar = validKey[validKey.length - 1];
    const tamperedKey = validKey.slice(0, -1) + (lastChar === 'A' ? 'B' : 'A');

    const res = await request(app)
      .post('/api/auth/wallet/link')
      .set('Authorization', `Bearer ${token}`)
      .send({
        stellarAddress: tamperedKey,
        signature: 'a'.repeat(128),
      });

    expect(res.status).toBe(400);
    expect(res.body.location).toBe('body');
    expect(res.body.details).toEqual([
      {
        path: '#',
        keyword: 'custom',
        message: 'stellarAddress must be a valid Stellar public key',
      },
    ]);
  });

  it('rejects invalid signature format via validate()', async () => {
    const res = await request(app)
      .post('/api/auth/wallet/link')
      .set('Authorization', `Bearer ${token}`)
      .send({
        stellarAddress: holder.publicKey(),
        signature: 'short-hex',
      });

    expect(res.status).toBe(400);
    expect(res.body.location).toBe('body');
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  it('rejects non-string stellarAddress without type coercion', async () => {
    const res = await request(app)
      .post('/api/auth/wallet/link')
      .set('Authorization', `Bearer ${token}`)
      .send({
        stellarAddress: 12345,
        signature: 'a'.repeat(128),
      });

    expect(res.status).toBe(400);
    expect(res.body.location).toBe('body');
  });

  it('accepts a valid Stellar address and signature and binds the wallet', async () => {
    const signature = holder
      .sign(Buffer.from(buildWalletLinkMessage('wallet-user', holder.publicKey()), 'utf8'))
      .toString('hex');

    const res = await request(app)
      .post('/api/auth/wallet/link')
      .set('Authorization', `Bearer ${token}`)
      .send({
        stellarAddress: holder.publicKey(),
        signature,
      });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      userId: 'wallet-user',
      stellarAddress: holder.publicKey(),
      linked: true,
    });
    expect(walletStore.getWallet('wallet-user')?.stellarAddress).toBe(holder.publicKey());
  });
});
