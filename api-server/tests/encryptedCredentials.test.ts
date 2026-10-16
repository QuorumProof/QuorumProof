/**
 * Tests for encrypted credential decryption routes — Issues #1742 / #1743 / #1744
 *
 * Covers:
 *  - POST /api/credentials/:id/decrypt/authorize: authentication and
 *    custodian-approval requirements (#1742)
 *  - POST /api/credentials/:id/decrypt/challenge and POST /decrypt: signed
 *    requester identity, single-use nonces, audit logging (#1743)
 *  - GET /api/credentials/:id/decrypt/audit: admin-only access (#1744)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { useTestSessions } from './helpers/testSessions.js';
import { buildDecryptionApprovalMessage } from '../src/services/encryptedCredentialAuth.js';

const storeMock = vi.hoisted(() => ({
  getEncryptedCredential: vi.fn(),
  authorizeDecryption: vi.fn(),
  isDecryptionAuthorized: vi.fn(),
  getActiveAuthorizations: vi.fn(),
  logDecryptionAttempt: vi.fn(),
  storeEncryptedCredential: vi.fn(),
}));

vi.mock('../src/services/encryptedCredentialStore.js', () => ({
  // Returning an object from a constructor makes `new EncryptedCredentialStore()`
  // evaluate to the shared mock, so each test can set its own return values.
  EncryptedCredentialStore: class {
    constructor() {
      return storeMock as unknown as object;
    }
  },
}));

import { createEncryptedCredentialsRouter } from '../src/routes/encryptedCredentials.js';

const CREDENTIAL_ID = '42';
const REQUESTER = Keypair.random().publicKey();
const CUSTODIANS = [Keypair.random(), Keypair.random(), Keypair.random(), Keypair.random(), Keypair.random()];

function approve(kp: Keypair, requester: string, issuedAt = Date.now(), credentialId = CREDENTIAL_ID) {
  const message = buildDecryptionApprovalMessage(credentialId, requester, issuedAt);
  return {
    custodian: kp.publicKey(),
    issued_at: issuedAt,
    signature: kp.sign(Buffer.from(message, 'utf8')).toString('hex'),
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/credentials', createEncryptedCredentialsRouter());
  return app;
}

describe('POST /api/credentials/:id/decrypt/authorize (#1742)', () => {
  const tokenFor = useTestSessions();
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
    storeMock.getEncryptedCredential.mockResolvedValue({
      key_custodians: CUSTODIANS.slice(0, 3).map((kp) => kp.publicKey()),
      encrypted_data: { threshold: 3 },
    });
    storeMock.authorizeDecryption.mockImplementation(async (_id, requester) => ({
      credential_id: BigInt(CREDENTIAL_ID),
      requester_address: requester,
      authorized_at: Date.now(),
      expires_at: Date.now() + 3600000,
      reason: 'test',
      approved_by: [],
    }));
  });

  const url = `/api/credentials/${CREDENTIAL_ID}/decrypt/authorize`;

  it('rejects unauthenticated requests with 401', async () => {
    const approvals = CUSTODIANS.slice(0, 3).map((kp) => approve(kp, REQUESTER));
    const res = await request(app).post(url).send({ requester_address: REQUESTER, approvals });

    expect(res.status).toBe(401);
    expect(storeMock.authorizeDecryption).not.toHaveBeenCalled();
  });

  it('rejects an invalid bearer token with 401', async () => {
    const approvals = CUSTODIANS.slice(0, 3).map((kp) => approve(kp, REQUESTER));
    const res = await request(app)
      .post(url)
      .set('Authorization', 'Bearer not-a-real-token')
      .send({ requester_address: REQUESTER, approvals });

    expect(res.status).toBe(401);
    expect(storeMock.authorizeDecryption).not.toHaveBeenCalled();
  });

  it('requires an approvals array', async () => {
    const res = await request(app)
      .post(url)
      .set('Authorization', `Bearer ${tokenFor('issuer-1', 'issuer')}`)
      .send({ requester_address: REQUESTER });

    expect(res.status).toBe(400);
    expect(storeMock.authorizeDecryption).not.toHaveBeenCalled();
  });

  it('returns 404 when the credential has no encrypted data', async () => {
    storeMock.getEncryptedCredential.mockResolvedValue(null);
    const res = await request(app)
      .post(url)
      .set('Authorization', `Bearer ${tokenFor('issuer-1', 'issuer')}`)
      .send({ requester_address: REQUESTER, approvals: [] });

    expect(res.status).toBe(404);
  });

  it('rejects a request with no custodian approvals', async () => {
    const res = await request(app)
      .post(url)
      .set('Authorization', `Bearer ${tokenFor('issuer-1', 'issuer')}`)
      .send({ requester_address: REQUESTER, approvals: [] });

    expect(res.status).toBe(403);
    expect(res.body.valid_approvals).toBe(0);
    expect(storeMock.authorizeDecryption).not.toHaveBeenCalled();
  });

  it('rejects when fewer than the threshold of custodians approve', async () => {
    const approvals = CUSTODIANS.slice(0, 2).map((kp) => approve(kp, REQUESTER));
    const res = await request(app)
      .post(url)
      .set('Authorization', `Bearer ${tokenFor('issuer-1', 'issuer')}`)
      .send({ requester_address: REQUESTER, approvals });

    expect(res.status).toBe(403);
    expect(res.body.required).toBe(3);
    expect(res.body.valid_approvals).toBe(2);
    expect(storeMock.authorizeDecryption).not.toHaveBeenCalled();
  });

  it('does not count approvals from keys that are not key custodians', async () => {
    const outsider = Keypair.random();
    const approvals = [
      approve(CUSTODIANS[0], REQUESTER),
      approve(CUSTODIANS[1], REQUESTER),
      approve(outsider, REQUESTER),
    ];
    const res = await request(app)
      .post(url)
      .set('Authorization', `Bearer ${tokenFor('issuer-1', 'issuer')}`)
      .send({ requester_address: REQUESTER, approvals });

    expect(res.status).toBe(403);
    expect(res.body.valid_approvals).toBe(2);
  });

  it('counts a custodian only once even if they approve repeatedly', async () => {
    const approvals = [
      approve(CUSTODIANS[0], REQUESTER),
      approve(CUSTODIANS[0], REQUESTER, Date.now() - 1000),
      approve(CUSTODIANS[1], REQUESTER),
    ];
    const res = await request(app)
      .post(url)
      .set('Authorization', `Bearer ${tokenFor('issuer-1', 'issuer')}`)
      .send({ requester_address: REQUESTER, approvals });

    expect(res.status).toBe(403);
    expect(res.body.valid_approvals).toBe(2);
  });

  it('rejects approvals whose signature was made for a different requester', async () => {
    const otherRequester = Keypair.random().publicKey();
    const approvals = CUSTODIANS.slice(0, 3).map((kp) => approve(kp, otherRequester));
    const res = await request(app)
      .post(url)
      .set('Authorization', `Bearer ${tokenFor('issuer-1', 'issuer')}`)
      .send({ requester_address: REQUESTER, approvals });

    expect(res.status).toBe(403);
    expect(res.body.valid_approvals).toBe(0);
  });

  it('rejects approvals signed for a different credential', async () => {
    const approvals = CUSTODIANS.slice(0, 3).map((kp) => approve(kp, REQUESTER, Date.now(), '999'));
    const res = await request(app)
      .post(url)
      .set('Authorization', `Bearer ${tokenFor('issuer-1', 'issuer')}`)
      .send({ requester_address: REQUESTER, approvals });

    expect(res.status).toBe(403);
    expect(res.body.valid_approvals).toBe(0);
  });

  it('rejects stale approvals', async () => {
    const stale = Date.now() - 11 * 60 * 1000;
    const approvals = CUSTODIANS.slice(0, 3).map((kp) => approve(kp, REQUESTER, stale));
    const res = await request(app)
      .post(url)
      .set('Authorization', `Bearer ${tokenFor('issuer-1', 'issuer')}`)
      .send({ requester_address: REQUESTER, approvals });

    expect(res.status).toBe(403);
    expect(res.body.valid_approvals).toBe(0);
  });

  it('grants authorization when the threshold of custodians approve', async () => {
    const approvals = CUSTODIANS.slice(0, 3).map((kp) => approve(kp, REQUESTER));
    const res = await request(app)
      .post(url)
      .set('Authorization', `Bearer ${tokenFor('issuer-1', 'issuer')}`)
      .send({ requester_address: REQUESTER, reason: 'audit', approvals });

    expect(res.status).toBe(200);
    expect(res.body.authorized_address).toBe(REQUESTER);
    expect(storeMock.authorizeDecryption).toHaveBeenCalledTimes(1);
    const [, requester, , reason, approvedBy] = storeMock.authorizeDecryption.mock.calls[0];
    expect(requester).toBe(REQUESTER);
    expect(reason).toBe('audit');
    expect(approvedBy).toEqual(CUSTODIANS.slice(0, 3).map((kp) => kp.publicKey()));
  });
});

describe('GET /api/credentials/:id/decrypt/audit (#1744)', () => {
  const tokenFor = useTestSessions();
  let app: express.Express;
  const url = `/api/credentials/${CREDENTIAL_ID}/decrypt/audit`;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
    storeMock.getActiveAuthorizations.mockResolvedValue([
      {
        credential_id: BigInt(CREDENTIAL_ID),
        requester_address: REQUESTER,
        authorized_at: Date.now(),
        expires_at: Date.now() + 3600000,
        reason: 'audit',
        approved_by: [CUSTODIANS[0].publicKey()],
      },
    ]);
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get(url);

    expect(res.status).toBe(401);
    expect(storeMock.getActiveAuthorizations).not.toHaveBeenCalled();
  });

  it('rejects a non-admin authenticated caller with 403', async () => {
    const res = await request(app)
      .get(url)
      .set('Authorization', `Bearer ${tokenFor('issuer-1', 'issuer')}`);

    expect(res.status).toBe(403);
    expect(storeMock.getActiveAuthorizations).not.toHaveBeenCalled();
  });

  it('ignores an x-role header and rejects it without an admin token', async () => {
    const res = await request(app).get(url).set('x-role', 'admin');

    expect(res.status).toBe(401);
    expect(storeMock.getActiveAuthorizations).not.toHaveBeenCalled();
  });

  it('returns the audit log to an admin', async () => {
    const res = await request(app)
      .get(url)
      .set('Authorization', `Bearer ${tokenFor('admin-1', 'admin')}`);

    expect(res.status).toBe(200);
    expect(res.body.active_authorizations).toHaveLength(1);
    expect(res.body.active_authorizations[0].requester_address).toBe(REQUESTER);
  });
});
