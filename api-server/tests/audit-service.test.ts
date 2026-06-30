import { describe, it, expect } from 'vitest';
import {
  verifyMerkleRoot,
  computeMerkleRoot,
  exportAuditLogs,
  isEntryExpired,
  groupByCredential,
  validateLogIntegrity,
  buildAuditQuery,
} from '../src/services/audit.js';

const mockEntry = (id: bigint, credential_id: bigint, timestamp: bigint) => ({
  id,
  action: 1,
  credential_id,
  actor: 'GACTOR1',
  timestamp,
  ledger_sequence: 100,
  payload_hash: 'aabbcc',
});

const mockNotarization = (merkleRoot: string, entryCount: number, firstId: bigint, lastId: bigint) => ({
  batch_id: 1n,
  merkle_root: merkleRoot,
  entry_count: entryCount,
  first_entry_id: firstId,
  last_entry_id: lastId,
  notarized_at: 1700000000n,
  notarized_ledger: 100,
});

describe('Merkle Root Verification', () => {
  it('computes single leaf root correctly', () => {
    const leaves = ['aabbccdd'];
    const root = computeMerkleRoot(leaves);
    expect(root).toBe('aabbccdd');
  });

  it('computes two-leaf root deterministically', () => {
    const leaves = ['aabbccdd', 'eeff0011'];
    const root1 = computeMerkleRoot(leaves);
    const root2 = computeMerkleRoot(leaves);
    expect(root1).toBe(root2);
  });

  it('verifies matching Merkle root', () => {
    const entries = [mockEntry(1n, 42n, 1700000000n), mockEntry(2n, 42n, 1700000001n)];
    const leaves = entries.map((e) => e.payload_hash);
    const root = computeMerkleRoot(leaves);
    const notarization = mockNotarization(root, 2, 1n, 2n);

    expect(verifyMerkleRoot(entries, notarization)).toBe(true);
  });

  it('rejects mismatched Merkle root', () => {
    const entries = [mockEntry(1n, 42n, 1700000000n), mockEntry(2n, 42n, 1700000001n)];
    const notarization = mockNotarization('0'.repeat(64), 2, 1n, 2n);

    expect(verifyMerkleRoot(entries, notarization)).toBe(false);
  });

  it('rejects empty entries', () => {
    const notarization = mockNotarization('abc', 0, 1n, 0n);
    expect(verifyMerkleRoot([], notarization)).toBe(false);
  });

  it('rejects mismatched entry count', () => {
    const entries = [mockEntry(1n, 42n, 1700000000n)];
    const notarization = mockNotarization('abc', 2, 1n, 2n); // expects 2 entries
    expect(verifyMerkleRoot(entries, notarization)).toBe(false);
  });
});

describe('Audit Log Export', () => {
  it('exports to JSON Lines format', () => {
    const entries = [mockEntry(1n, 42n, 1700000000n), mockEntry(2n, 43n, 1700000001n)];
    const exported = exportAuditLogs(entries, 'jsonl');

    const lines = exported.trim().split('\n');
    expect(lines).toHaveLength(2);

    const record1 = JSON.parse(lines[0]);
    expect(record1.entry_id).toBe('1');
    expect(record1.credential_id).toBe('42');
    expect(record1.action).toBe('CredentialIssued');
  });

  it('exports to JSON format', () => {
    const entries = [mockEntry(1n, 42n, 1700000000n)];
    const exported = exportAuditLogs(entries, 'json');

    const parsed = JSON.parse(exported);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
  });

  it('includes ISO timestamps in export', () => {
    const entries = [mockEntry(1n, 42n, 1700000000n)];
    const exported = exportAuditLogs(entries, 'jsonl');

    const record = JSON.parse(exported);
    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO format check
  });

  it('handles unknown action codes gracefully', () => {
    const entry = { ...mockEntry(1n, 42n, 1700000000n), action: 999 };
    const exported = exportAuditLogs([entry], 'jsonl');

    const record = JSON.parse(exported);
    expect(record.action).toBe('Unknown(999)');
  });
});

describe('Retention Window', () => {
  it('identifies expired entries', () => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const ninetyOneDaysAgo = now - BigInt(91 * 24 * 3600);
    const entry = mockEntry(1n, 42n, ninetyOneDaysAgo);

    expect(isEntryExpired(entry, now)).toBe(true);
  });

  it('identifies non-expired entries', () => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const twoDaysAgo = now - BigInt(2 * 24 * 3600);
    const entry = mockEntry(1n, 42n, twoDaysAgo);

    expect(isEntryExpired(entry, now)).toBe(false);
  });

  it('buildAuditQuery respects 90-day window', () => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const query = buildAuditQuery({});

    expect(query.startTime).toBe(now - BigInt(90 * 24 * 3600));
    expect(query.endTime).toBe(now);
    expect(query.limit).toBe(20);
  });

  it('buildAuditQuery respects custom filters', () => {
    const query = buildAuditQuery({
      credentialId: 42n,
      action: 1,
      limit: 50,
    });

    expect(query.credentialId).toBe(42n);
    expect(query.action).toBe(1);
    expect(query.limit).toBe(50);
  });
});

describe('Log Grouping', () => {
  it('groups entries by credential_id', () => {
    const entries = [
      mockEntry(1n, 42n, 1700000000n),
      mockEntry(2n, 43n, 1700000001n),
      mockEntry(3n, 42n, 1700000002n),
    ];

    const grouped = groupByCredential(entries);
    expect(grouped.size).toBe(2);
    expect(grouped.get(42n)).toHaveLength(2);
    expect(grouped.get(43n)).toHaveLength(1);
  });

  it('handles empty entry list', () => {
    const grouped = groupByCredential([]);
    expect(grouped.size).toBe(0);
  });
});

describe('Log Integrity Validation', () => {
  it('validates sequential IDs', () => {
    const entries = [
      mockEntry(1n, 42n, 1700000000n),
      mockEntry(2n, 42n, 1700000001n),
      mockEntry(3n, 42n, 1700000002n),
    ];

    const result = validateLogIntegrity(entries, []);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('detects non-sequential IDs', () => {
    const entries = [
      mockEntry(1n, 42n, 1700000000n),
      mockEntry(1n, 42n, 1700000001n), // duplicate ID
      mockEntry(3n, 42n, 1700000002n),
    ];

    const result = validateLogIntegrity(entries, []);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Non-sequential'))).toBe(true);
  });

  it('detects non-monotonic timestamps', () => {
    const entries = [
      mockEntry(1n, 42n, 1700000005n),
      mockEntry(2n, 42n, 1700000001n), // backwards in time
      mockEntry(3n, 42n, 1700000010n),
    ];

    const result = validateLogIntegrity(entries, []);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Non-monotonic'))).toBe(true);
  });

  it('validates notarization coverage', () => {
    const entries = [
      mockEntry(1n, 42n, 1700000000n),
      mockEntry(2n, 42n, 1700000001n),
      mockEntry(3n, 42n, 1700000002n),
    ];

    const notarizations = [mockNotarization('abc', 3, 1n, 3n)];

    const result = validateLogIntegrity(entries, notarizations);
    expect(result.valid).toBe(true);
  });

  it('detects uncovered entries', () => {
    const entries = [
      mockEntry(1n, 42n, 1700000000n),
      mockEntry(2n, 42n, 1700000001n),
      mockEntry(3n, 42n, 1700000002n),
    ];

    const notarizations = [mockNotarization('abc', 2, 1n, 2n)]; // only covers 1-2

    const result = validateLogIntegrity(entries, notarizations);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('not covered'))).toBe(true);
  });

  it('handles empty entries', () => {
    const result = validateLogIntegrity([], []);
    expect(result.valid).toBe(true);
  });
});
