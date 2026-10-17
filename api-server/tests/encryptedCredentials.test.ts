import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import {
  buildDecryptionAuthorizationMessage,
  buildDecryptionRequestMessage,
  createEncryptedCredentialsRouter,
} from '../src/routes/encryptedCredentials.js';
import { ThresholdEncryption } from '../src/crypto/thresholdEncryption.js';
import { EncryptedCredentialStore } from '../src/services/encryptedCredentialStore.js';
import * as soroban from '../src/soroban.js';

describe('Encrypted credential routes', () => {
  const store = new EncryptedCredentialStore();
  const encryption = new ThresholdEncryption(3, 5);
  const requester = Keypair.random();
  const custodians = Array.from({ length: 5 }, () => Keypair.random());
  const encryptedRecord = encryption.encryptSensitiveData('{}');
  const encryptedData = encryptedRecord.encrypted;
  const credentialRecord = {
    id: 1,
    credential_id: 42n,
    encrypted_data: encryptedData,
    key_shares: encryptedRecord.keyShares,
    key_custodians: custodians.map((keypair) => keypair.publicKey()),
    threshold: 3,
    created_at: 1,
    updated_at: 1,
  };
  const simulateCall = vi.fn<typeof soroban.simulateCall>();
  const getKeyCustodians = vi.spyOn(store, 'getKeyCustodians');
  const storeEncryptedCredential = vi.spyOn(store, 'storeEncryptedCredential');
  const authorizeDecryption = vi.spyOn(store, 'authorizeDecryption');
  const isDecryptionAuthorized = vi.spyOn(store, 'isDecryptionAuthorized');
  const getEncryptedCredential = vi.spyOn(store, 'getEncryptedCredential');
  const logDecryptionAttempt = vi.spyOn(store, 'logDecryptionAttempt');
  const getActiveAuthorizations = vi.spyOn(store, 'getActiveAuthorizations');
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    getKeyCustodians.mockResolvedValue(credentialRecord.key_custodians);
    authorizeDecryption.mockResolvedValue({
      credential_id: 42n,
      requester_address: requester.publicKey(),
      authorized_at: Date.now(),
      expires_at: Date.now() + 60_000,
      reason: 'Need to verify',
      approved_by: custodians.slice(0, 3).map((keypair) => keypair.publicKey()),
    });
    isDecryptionAuthorized.mockResolvedValue(true);
    getEncryptedCredential.mockResolvedValue(credentialRecord);
    logDecryptionAttempt.mockResolvedValue();
    getActiveAuthorizations.mockResolvedValue([]);
    simulateCall.mockResolvedValue({
      subject: requester.publicKey(),
      issuer: Keypair.random().publicKey(),
    });

    app = express();
    app.use(express.json());
    app.use('/api/credentials', createEncryptedCredentialsRouter({ store, encryption, simulateCall }));
  });

  function signedAuthorization(approverKeys = custodians.slice(0, 3)) {
    const timestamp = Date.now();
    const nonce = 'a'.repeat(32);
    const reason = 'Need to verify';
    const message = buildDecryptionAuthorizationMessage(
      '42',
      requester.publicKey(),
      reason,
      timestamp,
      nonce,
    );
    return {
      requester_address: requester.publicKey(),
      reason,
      timestamp,
      nonce,
      signature: requester.sign(Buffer.from(message)).toString('base64'),
      approvals: approverKeys.map((keypair) => ({
        address: keypair.publicKey(),
        signature: keypair.sign(Buffer.from(message)).toString('base64'),
      })),
    };
  }

  function signedDecrypt() {
    const timestamp = Date.now();
    const nonce = 'b'.repeat(32);
    const message = buildDecryptionRequestMessage('42', requester.publicKey(), timestamp, nonce);
    return {
      requester_address: requester.publicKey(),
      key_shares: credentialRecord.key_shares.slice(0, 3),
      timestamp,
      nonce,
      signature: requester.sign(Buffer.from(message)).toString('base64'),
    };
  }

  it('requires the requester signature and threshold approvals from configured custodians', async () => {
    const payload = signedAuthorization(Array.from({ length: 3 }, () => Keypair.random()));
    const response = await request(app).post('/api/credentials/42/decrypt/authorize').send(payload);

    expect(response.status).toBe(403);
    expect(authorizeDecryption).not.toHaveBeenCalled();
  });

  it('records authorization only for an eligible signed requester and approved custodians', async () => {
    const response = await request(app)
      .post('/api/credentials/42/decrypt/authorize')
      .send(signedAuthorization());

    expect(response.status).toBe(200);
    expect(simulateCall).toHaveBeenCalledWith('get_credential', [expect.anything()]);
    expect(authorizeDecryption).toHaveBeenCalledWith(
      42n,
      requester.publicKey(),
      3600000,
      'Need to verify',
      custodians.slice(0, 3).map((keypair) => keypair.publicKey()),
    );
  });

  it('rejects an address that is neither the credential subject nor issuer', async () => {
    const outsider = Keypair.random();
    const timestamp = Date.now();
    const nonce = 'c'.repeat(32);
    const message = buildDecryptionAuthorizationMessage(
      '42',
      outsider.publicKey(),
      'Need to verify',
      timestamp,
      nonce,
    );
    const payload = signedAuthorization();
    const response = await request(app)
      .post('/api/credentials/42/decrypt/authorize')
      .send({
        ...payload,
        requester_address: outsider.publicKey(),
        timestamp,
        nonce,
        signature: outsider.sign(Buffer.from(message)).toString('base64'),
      });

    expect(response.status).toBe(403);
    expect(authorizeDecryption).not.toHaveBeenCalled();
  });

  it('rejects decrypt requests without a valid requester signature', async () => {
    const response = await request(app)
      .post('/api/credentials/42/decrypt')
      .send({ ...signedDecrypt(), signature: Buffer.alloc(64).toString('base64') });

    expect(response.status).toBe(401);
    expect(isDecryptionAuthorized).not.toHaveBeenCalled();
  });

  it('rejects an invalid requester address before authorization checks', async () => {
    const response = await request(app)
      .post('/api/credentials/42/decrypt')
      .send({ ...signedDecrypt(), requester_address: 'not-a-stellar-address' });

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body.details)).toContain('requester_address');
    expect(isDecryptionAuthorized).not.toHaveBeenCalled();
  });

  it('rejects malformed key shares before authorization checks', async () => {
    const response = await request(app)
      .post('/api/credentials/42/decrypt')
      .send({ ...signedDecrypt(), key_shares: ['not-a-key-share'] });

    expect(response.status).toBe(400);
    expect(isDecryptionAuthorized).not.toHaveBeenCalled();
  });

  it('rejects invalid key custodian addresses before encrypting', async () => {
    const response = await request(app)
      .post('/api/credentials/42/encrypt')
      .send({ sensitive_fields: { secret: 'value' }, keyCustodians: ['invalid'] });

    expect(response.status).toBe(400);
    expect(storeEncryptedCredential).not.toHaveBeenCalled();
  });

  it('records malformed decrypted JSON as one failed attempt', async () => {
    const decryptSpy = vi.spyOn(encryption, 'decryptSensitiveData').mockReturnValue(Buffer.from('not-json'));

    const response = await request(app)
      .post('/api/credentials/42/decrypt')
      .send(signedDecrypt());
    decryptSpy.mockRestore();

    expect(response.status).toBe(400);
    expect(logDecryptionAttempt).toHaveBeenCalledTimes(1);
    expect(logDecryptionAttempt).toHaveBeenCalledWith(
      42n,
      requester.publicKey(),
      false,
      expect.objectContaining({ verified_identity: requester.publicKey() }),
    );
  });

  it('decrypts with valid shares and records the verified requester identity', async () => {
    const response = await request(app)
      .post('/api/credentials/42/decrypt')
      .send(signedDecrypt());

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.decrypted_data).toEqual({});
    expect(logDecryptionAttempt).toHaveBeenCalledTimes(1);
    expect(logDecryptionAttempt).toHaveBeenCalledWith(
      42n,
      requester.publicKey(),
      true,
      expect.objectContaining({ verified_identity: requester.publicKey() }),
    );
  });

  it('requires the admin permission to read the decryption audit log', async () => {
    const unauthenticated = await request(app).get('/api/credentials/42/decrypt/audit');
    expect(unauthenticated.status).toBe(401);

    const nonAdmin = await request(app)
      .get('/api/credentials/42/decrypt/audit')
      .set('x-role', 'verifier');
    expect(nonAdmin.status).toBe(403);

    const admin = await request(app)
      .get('/api/credentials/42/decrypt/audit')
      .set('x-role', 'admin');
    expect(admin.status).toBe(200);
    expect(getActiveAuthorizations).toHaveBeenCalledWith(42n);
  });
});
