/**
 * Tests for signed-requester decryption — Issue #1743
 *
 * Covers:
 *  - POST /api/credentials/:id/decrypt/challenge issues single-use challenges
 *  - POST /api/credentials/:id/decrypt requires a challenge signed by
 *    requester_address and rejects mismatched or replayed signatures
 *  - The verified identity is written to the decryption audit record
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { ThresholdEncryption } from '../src/crypto/thresholdEncryption.js';

const storeMock = vi.hoisted(() => ({
  getEncryptedCredential: vi.fn(),
  authorizeDecryption: vi.fn(),
  isDecryptionAuthorized: vi.fn(),
  getActiveAuthorizations: vi.fn(),
  logDecryptionAttempt: vi.fn(),
  storeEncryptedCredential: vi.fn(),
}));

vi.mock('../src/services/encryptedCredentialStore.js', () => ({
  EncryptedCredentialStore: class {
    constructor() {
      return storeMock as unknown as object;
    }
  },
}));

import { createEncryptedCredentialsRouter } from '../src/routes/encryptedCredentials.js';

const CREDENTIAL_ID = '7';
const REQUESTER = Keypair.random();
const PLAINTEXT = JSON.stringify({ name: 'Ada' });

/** Real ciphertext and key shares, so the success path decrypts for real. */
const { encrypted, keyShares } = new ThresholdEncryption(3, 5).encryptSensitiveData(PLAINTEXT);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/credentials', createEncryptedCredentialsRouter());
  return app;
}

function sign(kp: Keypair, message: string): string {
  return kp.sign(Buffer.from(message, 'utf8')).toString('hex');
}

async function requestChallenge(app: express.Express, requester = REQUESTER.publicKey()) {
  const res = await request(app)
    .post(`/api/credentials/${CREDENTIAL_ID}/decrypt/challenge`)
    .send({ requester_address: requester });
  expect(res.status).toBe(200);
  return res.body as { nonce: string; message: string; expires_at: string };
}

describe('POST /api/credentials/:id/decrypt/challenge (#1743)', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  it('returns a nonce and the message the requester must sign', async () => {
    const challenge = await requestChallenge(app);

    expect(challenge.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(challenge.message).toContain(`credentialId:${CREDENTIAL_ID}`);
    expect(challenge.message).toContain(`requester:${REQUESTER.publicKey()}`);
    expect(challenge.message).toContain(`nonce:${challenge.nonce}`);
  });

  it('rejects a requester_address that is not a Stellar public key', async () => {
    const res = await request(app)
      .post(`/api/credentials/${CREDENTIAL_ID}/decrypt/challenge`)
      .send({ requester_address: 'not-a-stellar-address' });

    expect(res.status).toBe(400);
  });
});

describe('POST /api/credentials/:id/decrypt with a signed challenge (#1743)', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
    storeMock.getEncryptedCredential.mockResolvedValue({ encrypted_data: encrypted });
    storeMock.isDecryptionAuthorized.mockResolvedValue(true);
    storeMock.logDecryptionAttempt.mockResolvedValue(undefined);
  });

  const url = `/api/credentials/${CREDENTIAL_ID}/decrypt`;

  it('rejects a request with no nonce or signature', async () => {
    const res = await request(app)
      .post(url)
      .send({ requester_address: REQUESTER.publicKey(), key_shares: keyShares });

    expect(res.status).toBe(400);
    expect(storeMock.logDecryptionAttempt).not.toHaveBeenCalled();
  });

  it('rejects a signature made by a different key than requester_address', async () => {
    const challenge = await requestChallenge(app);
    const impostor = Keypair.random();

    const res = await request(app).post(url).send({
      requester_address: REQUESTER.publicKey(),
      key_shares: keyShares,
      nonce: challenge.nonce,
      signature: sign(impostor, challenge.message),
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid signature');
    expect(storeMock.logDecryptionAttempt).not.toHaveBeenCalled();
  });

  it('rejects a signature over a message for a different nonce', async () => {
    const challenge = await requestChallenge(app);
    const other = await requestChallenge(app);

    const res = await request(app).post(url).send({
      requester_address: REQUESTER.publicKey(),
      key_shares: keyShares,
      nonce: challenge.nonce,
      signature: sign(REQUESTER, other.message),
    });

    expect(res.status).toBe(401);
  });

  it('rejects an unknown nonce', async () => {
    const res = await request(app).post(url).send({
      requester_address: REQUESTER.publicKey(),
      key_shares: keyShares,
      nonce: 'f'.repeat(32),
      signature: sign(REQUESTER, 'anything'),
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid challenge');
  });

  it('rejects a replayed request because the nonce is single-use', async () => {
    const challenge = await requestChallenge(app);
    const body = {
      requester_address: REQUESTER.publicKey(),
      key_shares: keyShares,
      nonce: challenge.nonce,
      signature: sign(REQUESTER, challenge.message),
    };

    const first = await request(app).post(url).send(body);
    expect(first.status).toBe(200);

    const replay = await request(app).post(url).send(body);
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe('Invalid challenge');
  });

  it('rejects a challenge issued for a different requester', async () => {
    const challenge = await requestChallenge(app, Keypair.random().publicKey());

    const res = await request(app).post(url).send({
      requester_address: REQUESTER.publicKey(),
      key_shares: keyShares,
      nonce: challenge.nonce,
      signature: sign(REQUESTER, challenge.message),
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid challenge');
  });

  it('decrypts and records the verified identity in the audit log', async () => {
    const challenge = await requestChallenge(app);

    const res = await request(app).post(url).send({
      requester_address: REQUESTER.publicKey(),
      key_shares: keyShares,
      nonce: challenge.nonce,
      signature: sign(REQUESTER, challenge.message),
    });

    expect(res.status).toBe(200);
    expect(res.body.decrypted_data).toEqual({ name: 'Ada' });
    expect(storeMock.logDecryptionAttempt).toHaveBeenCalledTimes(1);
    const [credentialId, requester, success, details] = storeMock.logDecryptionAttempt.mock.calls[0];
    expect(credentialId).toBe(BigInt(CREDENTIAL_ID));
    expect(requester).toBe(REQUESTER.publicKey());
    expect(success).toBe(true);
    expect(details.verified_identity).toBe(REQUESTER.publicKey());
  });
});
