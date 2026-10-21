import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EncryptedCredentialStore } from '../src/services/encryptedCredentialStore.js';
import type { EncryptedData, ThresholdKeyShare } from '../src/crypto/thresholdEncryption.js';

const db = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('../src/db.js', () => ({
  getPool: () => ({ query: db.query }),
}));

const encryptedData: EncryptedData = {
  ciphertext: 'ciphertext',
  iv: 'initialization-vector',
  tag: 'authentication-tag',
  threshold: 2,
  shares_count: 2,
  share_metadata: [
    { share_id: 1, commitment: 'commitment-1' },
    { share_id: 2, commitment: 'commitment-2' },
  ],
};

const keyShares: ThresholdKeyShare[] = [
  { share_id: 1, share_value: 'share-1', commitment: 'commitment-1' },
  { share_id: 2, share_value: 'share-2', commitment: 'commitment-2' },
];

function storedRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    credential_id: '42',
    encrypted_data: JSON.stringify(encryptedData),
    key_shares: JSON.stringify(keyShares),
    key_custodians: JSON.stringify(['custodian-1', 'custodian-2']),
    threshold: 2,
    created_at: '1700000000000',
    updated_at: 1700000001000,
    ...overrides,
  };
}

describe('EncryptedCredentialStore', () => {
  beforeEach(() => {
    db.query.mockReset();
  });

  it('stores encrypted payloads and parses the returned database row', async () => {
    db.query.mockResolvedValueOnce({ rows: [storedRecord()], rowCount: 1 });
    const store = new EncryptedCredentialStore();

    const record = await store.storeEncryptedCredential(
      42n,
      encryptedData,
      keyShares,
      ['custodian-1', 'custodian-2'],
    );

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO encrypted_credentials'),
      [
        42n,
        JSON.stringify(encryptedData),
        JSON.stringify(keyShares),
        JSON.stringify(['custodian-1', 'custodian-2']),
        2,
        expect.any(Number),
        expect.any(Number),
      ],
    );
    expect(record.credential_id).toBe(42n);
    expect(record.encrypted_data).toEqual(encryptedData);
    expect(record.key_shares).toEqual(keyShares);
    expect(record.key_custodians).toEqual(['custodian-1', 'custodian-2']);
    expect(record.created_at).toBe(1700000000000);
  });

  it('returns null for absent credentials and rejects malformed stored rows', async () => {
    const store = new EncryptedCredentialStore();
    db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(store.getEncryptedCredential(42n)).resolves.toBeNull();

    const brokenRows = [
      { encrypted_data: '{invalid json', expectedError: 'encrypted_data contains malformed JSON' },
      {
        key_shares: JSON.stringify([{ share_id: 1, commitment: 'missing share value' }]),
        expectedError: 'key_shares has an invalid shape',
      },
      { threshold: 1, expectedError: 'id or threshold is invalid' },
      { key_custodians: JSON.stringify(['valid', 123]), expectedError: 'key_custodians must be an array of strings' },
    ];

    for (const { expectedError, ...override } of brokenRows) {
      db.query.mockResolvedValueOnce({ rows: [storedRecord(override)], rowCount: 1 });
      await expect(store.getEncryptedCredential(42n)).rejects.toThrow(expectedError);
    }
  });

  it('validates key-custodian rows and reports authorization and cleanup results', async () => {
    const store = new EncryptedCredentialStore();
    db.query.mockResolvedValueOnce({ rows: [{ key_custodians: '["custodian-1"]' }], rowCount: 1 });
    await expect(store.getKeyCustodians(42n)).resolves.toEqual(['custodian-1']);

    db.query.mockResolvedValueOnce({ rows: [{ key_custodians: '{broken' }], rowCount: 1 });
    await expect(store.getKeyCustodians(42n)).rejects.toThrow('key_custodians contains malformed JSON');

    db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(store.isDecryptionAuthorized(42n, 'requester')).resolves.toBe(false);
    expect(db.query.mock.calls[2][0]).toContain('expires_at > $3');

    db.query.mockResolvedValueOnce({ rows: [], rowCount: 3 });
    await expect(store.cleanupExpiredAuthorizations()).resolves.toBe(3);
  });
});
