import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const { logDecryptionAttempt, decryptSensitiveData } = vi.hoisted(() => ({
  logDecryptionAttempt: vi.fn(),
  decryptSensitiveData: vi.fn(),
}));

vi.mock('../src/services/encryptedCredentialStore.js', () => ({
  EncryptedCredentialStore: class {
    isDecryptionAuthorized = vi.fn().mockResolvedValue(true);
    getEncryptedCredential = vi.fn().mockResolvedValue({
      encrypted_data: {},
    });
    logDecryptionAttempt = logDecryptionAttempt;
  },
}));

vi.mock('../src/crypto/thresholdEncryption.js', () => ({
  ThresholdEncryption: class {
    decryptSensitiveData = decryptSensitiveData;
    getConfig = () => ({ threshold: 3, shares: 5 });
  },
}));

import { createEncryptedCredentialsRouter } from '../src/routes/encryptedCredentials.js';

describe('POST /api/credentials/:id/decrypt audit logging', () => {
  beforeEach(() => {
    logDecryptionAttempt.mockReset().mockResolvedValue(undefined);
    decryptSensitiveData.mockReset().mockReturnValue(Buffer.from('{invalid json'));
  });

  it('records a malformed decrypted JSON payload as one failed attempt', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/credentials', createEncryptedCredentialsRouter());

    const response = await request(app)
      .post('/api/credentials/17/decrypt')
      .send({ requester_address: 'GREQUESTER', key_shares: [] });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Decryption failed');
    expect(logDecryptionAttempt).toHaveBeenCalledTimes(1);
    expect(logDecryptionAttempt).toHaveBeenCalledWith(
      17n,
      'GREQUESTER',
      false,
      expect.objectContaining({ share_count: 0 }),
    );
  });
});
