import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const {
  generateChallenge,
  verifySignature,
  storeChallenge,
  storeAttestation,
  getLatestAttestation,
} = vi.hoisted(() => ({
  generateChallenge: vi.fn(),
  verifySignature: vi.fn(),
  storeChallenge: vi.fn(),
  storeAttestation: vi.fn(),
  getLatestAttestation: vi.fn(),
}));

vi.mock('../src/crypto/attestation.js', () => ({
  AttestationManager: class {
    generateChallenge = generateChallenge;
    verifySignature = verifySignature;
  },
}));

vi.mock('../src/services/credentialAttestationStore.js', () => ({
  CredentialAttestationStore: class {
    storeChallenge = storeChallenge;
    storeAttestation = storeAttestation;
    getLatestAttestation = getLatestAttestation;
  },
}));

import { createHolderAttestationRouter } from '../src/routes/holderAttestation.js';

const app = express();
app.use(express.json());
app.use('/api/credentials', createHolderAttestationRouter());

const holderAddress = `G${'A'.repeat(55)}`;

beforeEach(() => {
  generateChallenge.mockReset();
  verifySignature.mockReset();
  storeChallenge.mockReset();
  storeAttestation.mockReset();
  getLatestAttestation.mockReset();
});

describe('holder attestation routes', () => {
  it('validates the challenge request and stores a generated challenge', async () => {
    const missing = await request(app).post('/api/credentials/15/attestation/challenge').send({});
    expect(missing.status).toBe(400);

    const invalidAddress = await request(app)
      .post('/api/credentials/15/attestation/challenge')
      .send({ holder_address: 'invalid' });
    expect(invalidAddress.status).toBe(400);

    const challenge = {
      challenge_id: 'challenge-15',
      message: 'Sign this message',
      timestamp: 1000,
      expires_at: 601000,
    };
    generateChallenge.mockReturnValueOnce(challenge);
    const response = await request(app)
      .post('/api/credentials/15/attestation/challenge')
      .send({ holder_address: holderAddress });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      challenge_id: 'challenge-15',
      message: 'Sign this message',
      timestamp: 1000,
      expires_at: 601000,
    });
    expect(storeChallenge).toHaveBeenCalledWith(
      15n, holderAddress, 'challenge-15', 'Sign this message', 601000,
    );
  });

  it('rejects incomplete or invalid signatures and stores a verified attestation', async () => {
    const endpoint = '/api/credentials/15/attestation/verify';
    expect((await request(app).post(endpoint).send({})).status).toBe(400);

    const payload = { challenge_id: 'challenge-15', holder_address: holderAddress, signature: 'signed-value' };
    verifySignature.mockReturnValueOnce(false);
    const invalid = await request(app).post(endpoint).send(payload);
    expect(invalid.status).toBe(400);
    expect(storeAttestation).not.toHaveBeenCalled();

    verifySignature.mockReturnValueOnce(true);
    const verified = await request(app).post(endpoint).send(payload);
    expect(verified.status).toBe(200);
    expect(verified.body).toMatchObject({
      success: true,
      credential_id: '15',
      holder_address: holderAddress,
    });
    expect(verified.body.verified_at).toEqual(expect.any(String));
    expect(verifySignature).toHaveBeenLastCalledWith(
      'challenge-15', holderAddress, 'signed-value', '15',
    );
    expect(storeAttestation).toHaveBeenCalledWith(
      15n, holderAddress, 'challenge-15', 'signed-value',
    );
  });

  it('reports missing, current, and expired attestation statuses', async () => {
    const endpoint = `/api/credentials/15/attestation/status?holder_address=${holderAddress}`;
    const missing = await request(app).get('/api/credentials/15/attestation/status');
    expect(missing.status).toBe(400);

    getLatestAttestation.mockResolvedValueOnce(null);
    const absent = await request(app).get(endpoint);
    expect(absent.status).toBe(200);
    expect(absent.body.status).toBe('no_attestation');

    getLatestAttestation.mockResolvedValueOnce({
      verified: true,
      signed_at: Date.now(),
      created_at: Date.now(),
      expires_at: Date.now() + 60_000,
    });
    const current = await request(app).get(endpoint);
    expect(current.status).toBe(200);
    expect(current.body).toMatchObject({ status: 'verified', verified: true, credential_id: '15' });

    getLatestAttestation.mockResolvedValueOnce({
      verified: true,
      signed_at: Date.now() - 120_000,
      created_at: Date.now() - 120_000,
      expires_at: Date.now() - 60_000,
    });
    const expired = await request(app).get(endpoint);
    expect(expired.status).toBe(200);
    expect(expired.body).toMatchObject({ status: 'invalid', verified: false });
  });
});
