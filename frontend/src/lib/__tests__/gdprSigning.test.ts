import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  generateChallenge,
  signGdprRequest,
  validateSignatureFormat,
  createSignedGdprRequest,
} from '../gdprSigning';

vi.mock('@stellar/freighter-api', () => ({
  signMessage: vi.fn(),
}));

describe('gdprSigning utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateChallenge', () => {
    it('should generate a challenge with timestamp and random suffix', () => {
      const challenge = generateChallenge();
      expect(challenge).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO timestamp
      expect(challenge).toContain(':');
      const parts = challenge.split(':');
      expect(parts.length).toBeGreaterThanOrEqual(2);
    });

    it('should generate unique challenges', () => {
      const c1 = generateChallenge();
      const c2 = generateChallenge();
      expect(c1).not.toEqual(c2);
    });
  });

  describe('validateSignatureFormat', () => {
    it('should accept valid base64-like signatures', () => {
      expect(validateSignatureFormat('SGVsbG8gV29ybGQ=')).toBe(true);
      expect(validateSignatureFormat('ABC123+/=')).toBe(true);
    });

    it('should reject empty signatures', () => {
      expect(validateSignatureFormat('')).toBe(false);
    });

    it('should reject invalid characters', () => {
      expect(validateSignatureFormat('Hello@World')).toBe(false);
      expect(validateSignatureFormat('Hello World')).toBe(false);
    });
  });

  describe('signGdprRequest', () => {
    it('should sign a GDPR request with credentialId, challenge, and subject address', async () => {
      const { signMessage } = await import('@stellar/freighter-api');
      (signMessage as any).mockResolvedValue({
        signedMessage: 'base64encodedSignature==',
      });

      const signature = await signGdprRequest(
        123,
        'challenge_abc123',
        'GAXMCLWLFVD4KELSYDTC35U3OWVEH37RCLJLQ3BX4UD4EW7J5YPAHH'
      );

      expect(signMessage).toHaveBeenCalledWith(
        'GDPR_REQUEST:123:challenge_abc123:GAXMCLWLFVD4KELSYDTC35U3OWVEH37RCLJLQ3BX4UD4EW7J5YPAHH'
      );
      expect(signature).toBe('base64encodedSignature==');
    });

    it('should throw on wallet error', async () => {
      const { signMessage } = await import('@stellar/freighter-api');
      (signMessage as any).mockResolvedValue({
        error: 'User denied signing',
      });

      await expect(
        signGdprRequest(123, 'challenge', 'GAXMCLWLFVD4KELSYDTC35U3OWVEH37RCLJLQ3BX4UD4EW7J5YPAHH')
      ).rejects.toThrow('Failed to sign GDPR request');
    });
  });

  describe('createSignedGdprRequest', () => {
    it('should create a signed GDPR request payload', async () => {
      const { signMessage } = await import('@stellar/freighter-api');
      (signMessage as any).mockResolvedValue({
        signedMessage: 'dGVzdFNpZ25hdHVyZQ==',
      });

      const payload = await createSignedGdprRequest(
        42,
        'GAXMCLWLFVD4KELSYDTC35U3OWVEH37RCLJLQ3BX4UD4EW7J5YPAHH'
      );

      expect(payload.credentialId).toBe(42);
      expect(payload.subjectAddress).toBe('GAXMCLWLFVD4KELSYDTC35U3OWVEH37RCLJLQ3BX4UD4EW7J5YPAHH');
      expect(payload.signature).toBe('dGVzdFNpZ25hdHVyZQ==');
      expect(payload.challenge).toBeTruthy();
      expect(payload.challenge).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should reject invalid signature format', async () => {
      const { signMessage } = await import('@stellar/freighter-api');
      (signMessage as any).mockResolvedValue({
        signedMessage: 'Invalid@Signature!',
      });

      await expect(
        createSignedGdprRequest(42, 'GAXMCLWLFVD4KELSYDTC35U3OWVEH37RCLJLQ3BX4UD4EW7J5YPAHH')
      ).rejects.toThrow('Invalid signature format');
    });
  });
});
