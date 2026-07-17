import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Keypair } from '@stellar/stellar-sdk';
import { createGdprRouter } from '../src/routes/gdpr.js';
import { PersonalDataVault } from '../src/services/cryptoShredding.js';
import { GdprRequestStore } from '../src/services/gdprRequestStore.js';
import { buildConsentMessage } from '../src/services/attestorConsent.js';

/**
 * Intentional behavior changes vs. the pre-crypto-shredding version of this
 * suite (see docs/crypto-shredding-architecture.md for the full rationale):
 *
 * 1. POST /consent now requires a `signature` field and rejects any
 *    attestorAddress that isn't (a) a valid Stellar ed25519 public key,
 *    (b) currently present in the credential's on-chain attestor set, and
 *    (c) the genuine signer of the canonical consent message. The old
 *    "raw address string count" tests (e.g. consenting as bare 'GATT1')
 *    are replaced with real Keypair-signed consent.
 * 2. POST /request and GET /request/:id now also call get_credential (to
 *    resolve the on-chain subject and to serve as the single source of
 *    truth for "does this credential exist"), not just get_attestors.
 *    Mocks below stub both.
 * 3. Reaching 'anonymized' now genuinely destroys the credential's
 *    decryption key via PersonalDataVault#eraseKey, rather than only
 *    flipping a status string.
 */

const mockSimulateCall = vi.fn();
const mockSoroban = {
  simulateCall: mockSimulateCall,
  u64Val: (n: number | bigint) => n as any,
};

interface ChainState {
  credentials: Record<number, { subject: string }>;
  attestors: Record<number, string[]>;
}

function mockChain(state: ChainState) {
  mockSimulateCall.mockImplementation(async (method: string, args: any[]) => {
    const id = Number(args[0]);
    if (method === 'get_credential') {
      const cred = state.credentials[id];
      if (!cred) throw new Error('CredentialNotFound');
      return cred;
    }
    if (method === 'get_attestors') {
      if (!(id in state.credentials)) throw new Error('CredentialNotFound');
      return state.attestors[id] ?? [];
    }
    throw new Error(`Unexpected simulateCall method: ${method}`);
  });
}

function signConsent(keypair: Keypair, requestId: string, credentialId: number): string {
  const message = Buffer.from(buildConsentMessage(requestId, credentialId, keypair.publicKey()), 'utf8');
  return keypair.sign(message).toString('hex');
}

let dataRoot: string;
let vault: PersonalDataVault;
let requestStore: GdprRequestStore;
let app: express.Express;

beforeEach(() => {
  mockSimulateCall.mockReset();
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gdpr-router-test-'));
  vault = new PersonalDataVault({ dataDir: path.join(dataRoot, 'vault') });
  requestStore = new GdprRequestStore({ dataDir: path.join(dataRoot, 'requests') });

  app = express();
  app.use(express.json());
  app.use('/api/gdpr', createGdprRouter(mockSoroban, { vault, requestStore }));
});

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('POST /api/gdpr/personal-data', () => {
  it('stores personal data off-chain and returns a commitment hash, not the data', async () => {
    mockChain({ credentials: { 1: { subject: 'GSUBJECT1' } }, attestors: {} });

    const res = await request(app)
      .post('/api/gdpr/personal-data')
      .send({ credentialId: 1, subject: 'GSUBJECT1', personalData: { name: 'Ada Lovelace' } });

    expect(res.status).toBe(201);
    expect(res.body.commitment).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(res.body)).not.toContain('Ada Lovelace');
  });

  it('returns 404 when the credential does not exist on-chain', async () => {
    mockChain({ credentials: {}, attestors: {} });

    const res = await request(app)
      .post('/api/gdpr/personal-data')
      .send({ credentialId: 99, subject: 'GX', personalData: { a: 1 } });

    expect(res.status).toBe(404);
  });

  it('returns 400 when subject does not match the on-chain credential subject', async () => {
    mockChain({ credentials: { 1: { subject: 'GREAL' } }, attestors: {} });

    const res = await request(app)
      .post('/api/gdpr/personal-data')
      .send({ credentialId: 1, subject: 'GIMPOSTER', personalData: { a: 1 } });

    expect(res.status).toBe(400);
  });

  it('returns 400 for missing fields', async () => {
    const res = await request(app).post('/api/gdpr/personal-data').send({ credentialId: 1 });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/gdpr/personal-data/:credentialId', () => {
  it('returns 404 when no data was ever stored', async () => {
    const res = await request(app).get('/api/gdpr/personal-data/123');
    expect(res.status).toBe(404);
  });

  it('decrypts and returns the stored personal data', async () => {
    vault.store(2, 'GSUBJECT2', { email: 'ada@example.com' });

    const res = await request(app).get('/api/gdpr/personal-data/2');
    expect(res.status).toBe(200);
    expect(res.body.personalData).toEqual({ email: 'ada@example.com' });
  });

  it('returns status metadata without ever decrypting', async () => {
    vault.store(3, 'GSUBJECT3', { ssn: '123-45-6789' });

    const res = await request(app).get('/api/gdpr/personal-data/3/status');
    expect(res.status).toBe(200);
    expect(res.body.hasData).toBe(true);
    expect(res.body.erased).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('123-45-6789');
  });
});

describe('POST /api/gdpr/request', () => {
  it('creates a GDPR request with no attestors — immediately anonymized via real key destruction', async () => {
    mockChain({ credentials: { 1: { subject: 'GSUBJECT1' } }, attestors: { 1: [] } });
    vault.store(1, 'GSUBJECT1', { name: 'Ada Lovelace' });

    const res = await request(app).post('/api/gdpr/request').send({ credentialId: 1 });

    expect(res.status).toBe(201);
    expect(res.body.credentialId).toBe(1);
    expect(res.body.status).toBe('anonymized');
    expect(res.body.requestId).toMatch(/^gdpr_/);
    expect(res.body.erasedAt).toBeTruthy();
    expect(res.body.vault.erased).toBe(true);

    // Not just a status flag: the underlying data is genuinely gone.
    const dataRes = await request(app).get('/api/gdpr/personal-data/1');
    expect(dataRes.status).toBe(410);
  });

  it('creates a pending request when attestors exist, and does not touch the key yet', async () => {
    mockChain({ credentials: { 2: { subject: 'GSUBJECT2' } }, attestors: { 2: ['GATT1', 'GATT2'] } });
    vault.store(2, 'GSUBJECT2', { name: 'Grace Hopper' });

    const res = await request(app).post('/api/gdpr/request').send({ credentialId: 2 });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending_consent');
    expect(res.body.requiredConsents).toBe(2);
    expect(res.body.vault.erased).toBe(false);

    const dataRes = await request(app).get('/api/gdpr/personal-data/2');
    expect(dataRes.status).toBe(200);
  });

  it('returns 400 for non-integer credentialId', async () => {
    const res = await request(app).post('/api/gdpr/request').send({ credentialId: 'abc' });
    expect(res.status).toBe(400);
  });

  it('returns 404 when the credential does not exist on-chain', async () => {
    mockChain({ credentials: {}, attestors: {} });
    const res = await request(app).post('/api/gdpr/request').send({ credentialId: 999 });
    expect(res.status).toBe(404);
  });

  it('returns 500 when the attestor set cannot be determined for an existing credential', async () => {
    mockSimulateCall.mockImplementation(async (method: string, args: any[]) => {
      if (method === 'get_credential') return { subject: 'GSUBJECT5' };
      if (method === 'get_attestors') throw new Error('simulation failed');
      throw new Error('unexpected');
    });

    const res = await request(app).post('/api/gdpr/request').send({ credentialId: 5 });
    expect(res.status).toBe(500);
  });
});

describe('GET /api/gdpr/request/:requestId', () => {
  it('returns 404 for unknown request ID', async () => {
    const res = await request(app).get('/api/gdpr/request/gdpr_unknown');
    expect(res.status).toBe(404);
  });

  it('returns the request record, including vault status, for a known ID', async () => {
    mockChain({ credentials: { 10: { subject: 'GSUBJECT10' } }, attestors: { 10: [] } });
    const createRes = await request(app).post('/api/gdpr/request').send({ credentialId: 10 });
    const { requestId } = createRes.body;

    const res = await request(app).get(`/api/gdpr/request/${requestId}`);
    expect(res.status).toBe(200);
    expect(res.body.requestId).toBe(requestId);
    expect(res.body.vault).toBeDefined();
  });
});

describe('POST /api/gdpr/consent', () => {
  let attestor1: Keypair;
  let attestor2: Keypair;
  let outsider: Keypair;
  let requestId: string;
  const credentialId = 5;

  beforeEach(async () => {
    attestor1 = Keypair.random();
    attestor2 = Keypair.random();
    outsider = Keypair.random();

    mockChain({
      credentials: { [credentialId]: { subject: 'GSUBJECT5' } },
      attestors: { [credentialId]: [attestor1.publicKey(), attestor2.publicKey()] },
    });
    vault.store(credentialId, 'GSUBJECT5', { name: 'Confidential Holder' });

    const res = await request(app).post('/api/gdpr/request').send({ credentialId });
    requestId = res.body.requestId;
  });

  it('records a validly signed consent and advances status once threshold is reached', async () => {
    const sig1 = signConsent(attestor1, requestId, credentialId);
    const first = await request(app)
      .post('/api/gdpr/consent')
      .send({ requestId, attestorAddress: attestor1.publicKey(), signature: sig1 });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('pending_consent');
    expect(first.body.attestorConsents).toHaveLength(1);

    const sig2 = signConsent(attestor2, requestId, credentialId);
    const second = await request(app)
      .post('/api/gdpr/consent')
      .send({ requestId, attestorAddress: attestor2.publicKey(), signature: sig2 });

    expect(second.status).toBe(200);
    expect(second.body.status).toBe('anonymized');
    expect(second.body.attestorConsents).toHaveLength(2);
    expect(second.body.erasedAt).toBeTruthy();

    const dataRes = await request(app).get('/api/gdpr/personal-data/5');
    expect(dataRes.status).toBe(410);
  });

  it('rejects consent missing a signature', async () => {
    const res = await request(app)
      .post('/api/gdpr/consent')
      .send({ requestId, attestorAddress: attestor1.publicKey() });
    expect(res.status).toBe(400);
  });

  it('rejects consent for an unknown requestId', async () => {
    const sig = signConsent(attestor1, 'gdpr_nope', credentialId);
    const res = await request(app)
      .post('/api/gdpr/consent')
      .send({ requestId: 'gdpr_nope', attestorAddress: attestor1.publicKey(), signature: sig });
    expect(res.status).toBe(400);
  });

  it('rejects an address that is not a current attestor for the credential', async () => {
    const sig = signConsent(outsider, requestId, credentialId);
    const res = await request(app)
      .post('/api/gdpr/consent')
      .send({ requestId, attestorAddress: outsider.publicKey(), signature: sig });

    expect(res.status).toBe(403);
  });

  it('rejects a syntactically valid but forged signature (signed by the wrong key)', async () => {
    // outsider signs, but claims to be attestor1 — the classic "raw address string" attack
    // this system is specifically designed to prevent.
    const forgedSig = signConsent(outsider, requestId, credentialId);
    const res = await request(app)
      .post('/api/gdpr/consent')
      .send({ requestId, attestorAddress: attestor1.publicKey(), signature: forgedSig });

    expect(res.status).toBe(401);
  });

  it('rejects garbage signature input', async () => {
    const res = await request(app)
      .post('/api/gdpr/consent')
      .send({ requestId, attestorAddress: attestor1.publicKey(), signature: 'not-hex-at-all' });
    expect(res.status).toBe(401);
  });

  it('rejects a signature bound to a different requestId (no replay across requests)', async () => {
    const sigForOtherRequest = signConsent(attestor1, 'gdpr_other', credentialId);
    const res = await request(app)
      .post('/api/gdpr/consent')
      .send({ requestId, attestorAddress: attestor1.publicKey(), signature: sigForOtherRequest });
    expect(res.status).toBe(401);
  });

  it('is idempotent for a repeated consent from the same attestor', async () => {
    const sig1 = signConsent(attestor1, requestId, credentialId);
    await request(app)
      .post('/api/gdpr/consent')
      .send({ requestId, attestorAddress: attestor1.publicKey(), signature: sig1 });
    const again = await request(app)
      .post('/api/gdpr/consent')
      .send({ requestId, attestorAddress: attestor1.publicKey(), signature: sig1 });

    expect(again.status).toBe(200);
    expect(again.body.attestorConsents).toHaveLength(1);
  });

  it('rejects consent once the request is already anonymized', async () => {
    const sig1 = signConsent(attestor1, requestId, credentialId);
    const sig2 = signConsent(attestor2, requestId, credentialId);
    await request(app).post('/api/gdpr/consent').send({ requestId, attestorAddress: attestor1.publicKey(), signature: sig1 });
    await request(app).post('/api/gdpr/consent').send({ requestId, attestorAddress: attestor2.publicKey(), signature: sig2 });

    const sig1Again = signConsent(attestor1, requestId, credentialId);
    const res = await request(app)
      .post('/api/gdpr/consent')
      .send({ requestId, attestorAddress: attestor1.publicKey(), signature: sig1Again });

    expect(res.status).toBe(400);
  });
});

describe('durability across a simulated restart', () => {
  it('GDPR request state and key destruction both survive re-loading from the same data directory', async () => {
    const attestor1 = Keypair.random();
    mockChain({
      credentials: { 20: { subject: 'GSUBJECT20' } },
      attestors: { 20: [attestor1.publicKey()] },
    });
    vault.store(20, 'GSUBJECT20', { secret: 'restart-me' });

    const createRes = await request(app).post('/api/gdpr/request').send({ credentialId: 20 });
    const { requestId } = createRes.body;

    const sig = signConsent(attestor1, requestId, 20);
    const consentRes = await request(app)
      .post('/api/gdpr/consent')
      .send({ requestId, attestorAddress: attestor1.publicKey(), signature: sig });
    expect(consentRes.body.status).toBe('anonymized');

    // Simulate a process restart: brand-new store/vault instances reading the same directory.
    const restartedVault = new PersonalDataVault({ dataDir: path.join(dataRoot, 'vault') });
    const restartedRequestStore = new GdprRequestStore({ dataDir: path.join(dataRoot, 'requests') });
    const restartedApp = express();
    restartedApp.use(express.json());
    restartedApp.use(
      '/api/gdpr',
      createGdprRouter(mockSoroban, { vault: restartedVault, requestStore: restartedRequestStore })
    );

    const statusRes = await request(restartedApp).get(`/api/gdpr/request/${requestId}`);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.status).toBe('anonymized');
    expect(statusRes.body.vault.erased).toBe(true);

    const dataRes = await request(restartedApp).get('/api/gdpr/personal-data/20');
    expect(dataRes.status).toBe(410);

    // New request IDs keep incrementing rather than colliding with pre-restart IDs.
    mockChain({ credentials: { 21: { subject: 'GSUBJECT21' } }, attestors: { 21: [] } });
    const nextRes = await request(restartedApp).post('/api/gdpr/request').send({ credentialId: 21 });
    expect(nextRes.body.requestId).not.toBe(requestId);
  });
});
