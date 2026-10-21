import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, loggerMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  loggerMock: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../src/db.js', () => ({
  getPool: () => ({ query: queryMock }),
}));

vi.mock('../src/services/logger.js', () => ({
  logger: loggerMock,
}));

import { CredentialAuditTrail } from '../src/services/credentialAuditTrail.js';
import { EncryptedCredentialStore } from '../src/services/encryptedCredentialStore.js';

describe('database row parsing', () => {
  beforeEach(() => {
    queryMock.mockReset();
    vi.clearAllMocks();
  });

  it('returns an empty custodian list and reports malformed JSON', async () => {
    queryMock.mockResolvedValue({ rows: [{ key_custodians: '{invalid' }] });

    const custodians = await new EncryptedCredentialStore().getKeyCustodians(42n);

    expect(custodians).toEqual([]);
    expect(loggerMock.error).toHaveBeenCalledWith(
      'Skipping malformed key custodians value',
      'encrypted-credential-store',
      expect.objectContaining({ credentialId: '42' }),
    );
  });

  it('skips an encrypted credential with malformed serialized data', async () => {
    queryMock.mockResolvedValue({
      rows: [{
        id: 1,
        credential_id: 42n,
        encrypted_data: '{invalid',
        key_shares: '[]',
        key_custodians: '[]',
        threshold: 2,
        created_at: 1,
        updated_at: 1,
      }],
    });

    const credential = await new EncryptedCredentialStore().getEncryptedCredential(42n);

    expect(credential).toBeNull();
    expect(loggerMock.error).toHaveBeenCalledWith(
      'Skipping malformed encrypted credential row',
      'encrypted-credential-store',
      expect.objectContaining({ credentialId: '42' }),
    );
  });

  it('skips encrypted credentials with valid JSON but invalid field shapes', async () => {
    queryMock.mockResolvedValue({
      rows: [{
        id: 1,
        credential_id: 42n,
        encrypted_data: JSON.stringify({
          ciphertext: 'ciphertext',
          iv: 'iv',
          tag: 'tag',
          threshold: 2,
          shares_count: 3,
          share_metadata: [],
        }),
        key_shares: JSON.stringify([{ share_id: 1 }]),
        key_custodians: '[]',
        threshold: 2,
        created_at: 1,
        updated_at: 1,
      }],
    });

    const credential = await new EncryptedCredentialStore().getEncryptedCredential(42n);

    expect(credential).toBeNull();
    expect(loggerMock.error).toHaveBeenCalledWith(
      'Skipping malformed encrypted credential row',
      'encrypted-credential-store',
      expect.objectContaining({ credentialId: '42' }),
    );
  });

  it('skips malformed audit rows in exports and reports an incomplete history', async () => {
    queryMock.mockResolvedValue({
      rows: [
        {
          change_id: 'bad-change',
          credential_id: 42n,
          field_name: 'name',
          old_value: '{invalid',
          new_value: '"valid"',
          changed_at: 1,
          changed_by: 'user-1',
          change_reason: 'test',
          hash: 'invalid',
        },
        {
          change_id: 'valid-change',
          credential_id: 42n,
          field_name: 'name',
          old_value: '"old"',
          new_value: '"new"',
          changed_at: 2,
          changed_by: 'user-1',
          change_reason: 'test',
          hash: 'invalid',
        },
      ],
    });

    const report = await new CredentialAuditTrail().generateAuditReport(42n);

    expect(report.changes).toHaveLength(1);
    expect(report.changes[0].change_id).toBe('valid-change');
    expect(report.integrity_status).toBe('tampered');
    expect(loggerMock.error).toHaveBeenCalledWith(
      'Skipping malformed credential change row',
      'credential-audit-trail',
      expect.objectContaining({ changeId: 'bad-change', source: 'change-history' }),
    );
  });
});
