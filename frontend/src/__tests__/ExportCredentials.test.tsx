import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exportToJSON, exportToCSV, downloadFile, buildQrUrl, exportToPDF } from '../lib/exportUtils';
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

    it('includes all required metadata fields', () => {
      const parsed = JSON.parse(exportToJSON([mockCredential]));
      const entry = parsed[0];
      expect(entry).toHaveProperty('id');
      expect(entry).toHaveProperty('subject');
      expect(entry).toHaveProperty('issuer');
      expect(entry).toHaveProperty('type');
      expect(entry).toHaveProperty('metadataHash');
      expect(entry).toHaveProperty('revoked');
      expect(entry).toHaveProperty('expiresAt');
      expect(entry).toHaveProperty('issuedAt');
    });

    it('serialises expires_at as null when not set', () => {
      const cred = { ...mockCredential, expires_at: null };
      const parsed = JSON.parse(exportToJSON([cred]));
      expect(parsed[0].expiresAt).toBeNull();
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

  describe('buildQrUrl', () => {
    it('returns a URL containing the credential id', () => {
      const url = buildQrUrl('42', 'https://example.com');
      expect(url).toContain('42');
      expect(url).toContain('chart.googleapis.com');
    });

    it('encodes the verify URL in the QR link', () => {
      const url = buildQrUrl('7', 'https://app.example.com');
      expect(url).toContain(encodeURIComponent('https://app.example.com/verify?id=7'));
    });
  });

  describe('exportToPDF', () => {
    it('opens a new window with credential data', () => {
      const mockWrite = vi.fn();
      const mockClose = vi.fn();
      vi.spyOn(window, 'open').mockReturnValue({
        document: { write: mockWrite, close: mockClose },
      } as unknown as Window);

      exportToPDF(mockCredential, 'https://example.com');

      expect(window.open).toHaveBeenCalledWith('', '_blank');
      expect(mockWrite).toHaveBeenCalledOnce();

      const html: string = mockWrite.mock.calls[0][0];
      expect(html).toContain(mockCredential.id.toString());
      expect(html).toContain(mockCredential.subject);
      expect(html).toContain(mockCredential.issuer);
      // QR code image present
      expect(html).toContain('chart.googleapis.com');
      // Verify link present
      expect(html).toContain(`/verify?id=${mockCredential.id}`);
    });

    it('does nothing when window.open returns null', () => {
      vi.spyOn(window, 'open').mockReturnValue(null);
      expect(() => exportToPDF(mockCredential, 'https://example.com')).not.toThrow();
    });

    it('marks revoked credentials in the PDF', () => {
      const mockWrite = vi.fn();
      vi.spyOn(window, 'open').mockReturnValue({
        document: { write: mockWrite, close: vi.fn() },
      } as unknown as Window);

      exportToPDF({ ...mockCredential, revoked: true }, 'https://example.com');
      expect(mockWrite.mock.calls[0][0]).toContain('Revoked');
    });
  });
});
