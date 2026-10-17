import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@stellar/stellar-sdk';
import shareLinksRouter from '../src/routes/shareLinks.js';
import authRouter, { buildWalletLinkMessage } from '../src/routes/auth.js';
import { SessionManager, _setDefaultSessionManagerForTest } from '../src/services/sessionManager.js';
import { UserWalletStore, _setDefaultUserWalletStoreForTest } from '../src/services/userWalletStore.js';
import * as soroban from '../src/soroban.js';

vi.mock('../src/soroban.js', () => ({
  simulateCall: vi.fn(),
  u64Val: vi.fn((value: number | bigint) => value),
  u32Val: vi.fn((value: number) => value),
  addressVal: vi.fn((value: string) => value),
}));

describe('share-link holder authentication', () => {
  let app: express.Express;
  let tempDir: string;
  let token: string;
  let walletStore: UserWalletStore;
  const holder = Keypair.random();
  const otherWallet = Keypair.random();
  const mockSimulateCall = vi.mocked(soroban.simulateCall);

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = 'test-wallet-link-secret';
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-links-auth-'));
    const sessions = new SessionManager({ dataDir: path.join(tempDir, 'sessions') });
    _setDefaultSessionManagerForTest(sessions);
    token = sessions.createSession('holder-user').accessToken;
    walletStore = new UserWalletStore({ dataDir: path.join(tempDir, 'wallets') });
    _setDefaultUserWalletStoreForTest(walletStore);

    app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);
    app.use('/api/credentials', shareLinksRouter);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    _setDefaultSessionManagerForTest(undefined);
    _setDefaultUserWalletStoreForTest(undefined);
  });

  it('links a wallet only with an authenticated account and a matching Stellar signature', async () => {
    const signature = holder.sign(
      Buffer.from(buildWalletLinkMessage('holder-user', holder.publicKey()), 'utf8'),
    ).toString('hex');

    const unauthenticated = await request(app)
      .post('/api/auth/wallet/link')
      .send({ stellarAddress: holder.publicKey(), signature });
    expect(unauthenticated.status).toBe(401);

    const invalidSignature = await request(app)
      .post('/api/auth/wallet/link')
      .set('Authorization', `Bearer ${token}`)
      .send({ stellarAddress: holder.publicKey(), signature: '00'.repeat(64) });
    expect(invalidSignature.status).toBe(401);

    const linked = await request(app)
      .post('/api/auth/wallet/link')
      .set('Authorization', `Bearer ${token}`)
      .send({ stellarAddress: holder.publicKey(), signature });
    expect(linked.status).toBe(201);
    expect(walletStore.getWallet('holder-user')?.stellarAddress).toBe(holder.publicKey());
  });

  it('does not let an account replace its verified wallet', async () => {
    walletStore.link('holder-user', holder.publicKey());
    const signature = otherWallet.sign(
      Buffer.from(buildWalletLinkMessage('holder-user', otherWallet.publicKey()), 'utf8'),
    ).toString('hex');

    const response = await request(app)
      .post('/api/auth/wallet/link')
      .set('Authorization', `Bearer ${token}`)
      .send({ stellarAddress: otherWallet.publicKey(), signature });

    expect(response.status).toBe(409);
    expect(walletStore.getWallet('holder-user')?.stellarAddress).toBe(holder.publicKey());
  });

  it('requires the authenticated, linked wallet to create or revoke a share link', async () => {
    const unauthenticated = await request(app)
      .post('/api/credentials/42/share')
      .send({ subject: holder.publicKey(), expiry_hours: 24, permission: 'view_only' });
    expect(unauthenticated.status).toBe(401);

    const unlinked = await request(app)
      .post('/api/credentials/42/share')
      .set('Authorization', `Bearer ${token}`)
      .send({ subject: holder.publicKey(), expiry_hours: 24, permission: 'view_only' });
    expect(unlinked.status).toBe(403);

    walletStore.link('holder-user', holder.publicKey());

    const createAsOtherHolder = await request(app)
      .post('/api/credentials/42/share')
      .set('Authorization', `Bearer ${token}`)
      .send({ subject: otherWallet.publicKey(), expiry_hours: 24, permission: 'view_only' });
    expect(createAsOtherHolder.status).toBe(403);

    const revokeAsOtherHolder = await request(app)
      .delete(`/api/credentials/share/${'a'.repeat(32)}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ subject: otherWallet.publicKey() });
    expect(revokeAsOtherHolder.status).toBe(403);

    expect(mockSimulateCall).not.toHaveBeenCalled();
  });

  it('keeps bearer-token validation public for recipients without accounts', async () => {
    const response = await request(app)
      .post('/api/credentials/share/validate')
      .send({ token: 'not-a-share-token' });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/token must be/);
    expect(mockSimulateCall).not.toHaveBeenCalled();
  });
});
