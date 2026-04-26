import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exportToJSON, exportToCSV, downloadFile } from '../lib/exportUtils';
import type { Credential } from '../lib/contracts/quorumProof';

const mockCredential: Credential = {
  id: BigInt(1),
  subject: 'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2EURIDVXL6B',
  issuer: 'GCZXWX4J3CKPF35VQ4XYVNIS7QQ5QEPL7SZLW5QJSTW2QC4QFSXZJWF',
  credential_type: 1,
  metadata_hash: new Uint8Array([1, 2, 3, 4, 5]),
  revoked: false,
  expires_at: BigInt(1704067200),
};

describe('Export Credentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('exportToJSON', () => {
    it('should export credentials to JSON format', () => {
      const result = exportToJSON([mockCredential]);
      const parsed = JSON.parse(result);

      expect(parsed).toHaveLength(1);
      expect(parsed[0].id).toBe('1');
      expect(parsed[0].subject).toBe(mockCredential.subject);
      expect(parsed[0].issuer).toBe(mockCredential.issuer);
      expect(parsed[0].revoked).toBe(false);
    });

    it('should handle multiple credentials', () => {
      const creds = [mockCredential, { ...mockCredential, id: BigInt(2) }];
      const result = exportToJSON(creds);
      const parsed = JSON.parse(result);

      expect(parsed).toHaveLength(2);
      expect(parsed[0].id).toBe('1');
      expect(parsed[1].id).toBe('2');
    });
  });

  describe('exportToCSV', () => {
    it('should export credentials to CSV format', () => {
      const result = exportToCSV([mockCredential]);
      const lines = result.split('\n');

      expect(lines[0]).toContain('ID');
      expect(lines[0]).toContain('Subject');
      expect(lines[1]).toContain('1');
      expect(lines[1]).toContain(mockCredential.subject);
    });

    it('should properly escape CSV values', () => {
      const result = exportToCSV([mockCredential]);
      const lines = result.split('\n');

      // All values should be quoted
      expect(lines[1]).toMatch(/^".*",".*",".*"/);
    });
  });

  describe('downloadFile', () => {
    it('should create and trigger download', () => {
      const createElementSpy = vi.spyOn(document, 'createElement');
      const appendChildSpy = vi.spyOn(document.body, 'appendChild');
      const removeChildSpy = vi.spyOn(document.body, 'removeChild');

      downloadFile('test content', 'test.json', 'application/json');

      expect(createElementSpy).toHaveBeenCalledWith('a');
      expect(appendChildSpy).toHaveBeenCalled();
      expect(removeChildSpy).toHaveBeenCalled();
    });
  });
});
