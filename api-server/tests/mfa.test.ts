/**
 * Tests for MFA Service — Issues #1299 / #1364
 *
 * Tests verify that MFA enrollment and backup code consumption are durable
 * and visible across multiple service instances (multi-instance safety).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  MfaService,
  totp,
  verifyTotp,
  _setDefaultMfaServiceForTest,
} from '../src/services/mfa.js';

/** Create a fresh MFA service for testing with a temp data directory. */
function freshMfaService(): { dataDir: string; service: MfaService } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfa-test-'));
  const service = new MfaService({ dataDir });
  _setDefaultMfaServiceForTest(service);
  return { dataDir, service };
}

describe('MfaService', () => {
  let service: MfaService;
  let dataDir: string;

  beforeEach(() => {
    const fresh = freshMfaService();
    service = fresh.service;
    dataDir = fresh.dataDir;
  });

  // ── MFA Setup ──────────────────────────────────────────────────────────

  describe('setupMfa', () => {
    it('generates a TOTP secret and backup codes', () => {
      const result = service.setupMfa('alice');

      expect(result.secret).toBeDefined();
      expect(result.otpAuthUrl).toContain('otpauth://totp/');
      expect(result.otpAuthUrl).toContain('alice');
      expect(result.backupCodes).toHaveLength(8);
      result.backupCodes.forEach(code => {
        expect(code).toMatch(/^[0-9A-F]{10}$/); // 10-char hex
      });
    });

    it('returns different backup codes each time', () => {
      const result1 = service.setupMfa('user1');
      const result2 = service.setupMfa('user2');

      expect(result1.secret).not.toBe(result2.secret);
      expect(result1.backupCodes).not.toEqual(result2.backupCodes);
    });

    it('stores record in pending state (enabled=false)', () => {
      const userId = 'alice';
      service.setupMfa(userId);

      const status = service.getMfaStatus(userId);
      expect(status).toBeDefined();
      expect(status?.enabled).toBe(false);
    });

    it('creates otpauth URL with custom issuer label', () => {
      const result = service.setupMfa('alice', 'MyApp');
      expect(result.otpAuthUrl).toContain('MyApp');
    });
  });

  // ── MFA Verification ──────────────────────────────────────────────────

  describe('verifySetup', () => {
    it('confirms MFA setup when given a valid TOTP code', () => {
      const userId = 'alice';
      const setup = service.setupMfa(userId);

      const code = totp(setup.secret);
      const result = service.verifySetup(userId, code);

      expect(result).toBe(true);
      expect(service.isMfaEnabled(userId)).toBe(true);
    });

    it('sets enabled=true and enabledAt timestamp', () => {
      const userId = 'alice';
      const setup = service.setupMfa(userId);
      const before = new Date().getTime();

      service.verifySetup(userId, totp(setup.secret));

      const after = new Date().getTime();
      const status = service.getMfaStatus(userId);
      expect(status?.enabled).toBe(true);
      expect(status?.enabledAt).toBeDefined();
      if (status?.enabledAt) {
        const time = new Date(status.enabledAt).getTime();
        expect(time).toBeGreaterThanOrEqual(before);
        expect(time).toBeLessThanOrEqual(after);
      }
    });

    it('returns false for invalid TOTP code', () => {
      const userId = 'alice';
      service.setupMfa(userId);

      const result = service.verifySetup(userId, '000000');
      expect(result).toBe(false);
      expect(service.isMfaEnabled(userId)).toBe(false);
    });

    it('returns false when user has no pending setup', () => {
      const result = service.verifySetup('nonexistent', '123456');
      expect(result).toBe(false);
    });

    it('returns false when already enabled', () => {
      const userId = 'alice';
      const setup = service.setupMfa(userId);
      const code = totp(setup.secret);

      service.verifySetup(userId, code); // First activation
      const result2 = service.verifySetup(userId, code); // Try again

      expect(result2).toBe(false);
    });
  });

  // ── TOTP Verification ──────────────────────────────────────────────────

  describe('verifyCode (TOTP)', () => {
    it('verifies a valid TOTP code for enabled MFA', () => {
      const userId = 'alice';
      const setup = service.setupMfa(userId);

      service.verifySetup(userId, totp(setup.secret));
      const newCode = totp(setup.secret);
      const result = service.verifyCode(userId, newCode);

      expect(result).toBe(true);
    });

    it('returns false for invalid TOTP code', () => {
      const userId = 'alice';
      const setup = service.setupMfa(userId);

      service.verifySetup(userId, totp(setup.secret));
      const result = service.verifyCode(userId, '000000');

      expect(result).toBe(false);
    });

    it('returns false when MFA not enabled', () => {
      const userId = 'alice';
      const setup = service.setupMfa(userId);

      // Don't call verifySetup, so MFA is still in pending state
      const result = service.verifyCode(userId, totp(setup.secret));
      expect(result).toBe(false);
    });

    it('returns false for non-existent user', () => {
      const result = service.verifyCode('nonexistent', '123456');
      expect(result).toBe(false);
    });
  });

  // ── Backup Codes ───────────────────────────────────────────────────────

  describe('Backup codes', () => {
    it('accepts a valid backup code for verification', () => {
      const userId = 'alice';
      const setup = service.setupMfa(userId);
      const backupCode = setup.backupCodes[0];

      service.verifySetup(userId, totp(setup.secret));
      const result = service.verifyCode(userId, backupCode);

      expect(result).toBe(true);
    });

    it('is case-insensitive for backup code matching', () => {
      const userId = 'alice';
      const setup = service.setupMfa(userId);
      const backupCode = setup.backupCodes[0];

      service.verifySetup(userId, totp(setup.secret));
      const result = service.verifyCode(userId, backupCode.toLowerCase());

      expect(result).toBe(true);
    });

    it('consumes backup code after use (single-use)', () => {
      const userId = 'alice';
      const setup = service.setupMfa(userId);
      const backupCode = setup.backupCodes[0];

      service.verifySetup(userId, totp(setup.secret));
      service.verifyCode(userId, backupCode);

      const result = service.verifyCode(userId, backupCode);
      expect(result).toBe(false); // Already consumed
    });

    it('tracks remaining backup codes', () => {
      const userId = 'alice';
      const setup = service.setupMfa(userId);

      service.verifySetup(userId, totp(setup.secret));

      const statusBefore = service.getMfaStatus(userId);
      expect(statusBefore?.backupCodesRemaining).toBe(8);

      service.verifyCode(userId, setup.backupCodes[0]);

      const statusAfter = service.getMfaStatus(userId);
      expect(statusAfter?.backupCodesRemaining).toBe(7);
    });
  });

  // ── Status and State ───────────────────────────────────────────────────

  describe('getMfaStatus', () => {
    it('returns null for non-existent user', () => {
      const status = service.getMfaStatus('nonexistent');
      expect(status).toBeNull();
    });

    it('returns status for user with pending setup', () => {
      const userId = 'alice';
      service.setupMfa(userId);

      const status = service.getMfaStatus(userId);
      expect(status).toBeDefined();
      expect(status?.enabled).toBe(false);
      expect(status?.backupCodesRemaining).toBe(8);
    });

    it('returns status for user with enabled MFA', () => {
      const userId = 'alice';
      const setup = service.setupMfa(userId);

      service.verifySetup(userId, totp(setup.secret));

      const status = service.getMfaStatus(userId);
      expect(status?.enabled).toBe(true);
      expect(status?.enabledAt).toBeDefined();
    });
  });

  describe('isMfaEnabled', () => {
    it('returns false when user has no MFA record', () => {
      expect(service.isMfaEnabled('nonexistent')).toBe(false);
    });

    it('returns false when MFA is pending', () => {
      const userId = 'alice';
      service.setupMfa(userId);

      expect(service.isMfaEnabled(userId)).toBe(false);
    });

    it('returns true when MFA is enabled', () => {
      const userId = 'alice';
      const setup = service.setupMfa(userId);

      service.verifySetup(userId, totp(setup.secret));

      expect(service.isMfaEnabled(userId)).toBe(true);
    });
  });

  // ── Disabling MFA ──────────────────────────────────────────────────────

  describe('disableMfa', () => {
    it('disables MFA for a user', () => {
      const userId = 'alice';
      const setup = service.setupMfa(userId);

      service.verifySetup(userId, totp(setup.secret));
      expect(service.isMfaEnabled(userId)).toBe(true);

      service.disableMfa(userId);

      expect(service.isMfaEnabled(userId)).toBe(false);
      expect(service.getMfaStatus(userId)).toBeNull();
    });

    it('returns true when disabling existing MFA', () => {
      const userId = 'alice';
      const setup = service.setupMfa(userId);

      service.verifySetup(userId, totp(setup.secret));
      const result = service.disableMfa(userId);

      expect(result).toBe(true);
    });

    it('returns false when user has no MFA', () => {
      const result = service.disableMfa('nonexistent');
      expect(result).toBe(false);
    });
  });

  // ── Multi-Instance Durability (Critical for Issue #1364) ──────────────────

  describe('Multi-instance durability', () => {
    it('enrolls MFA via instance A and verifies via instance B', () => {
      const userId = 'alice';

      // Instance A: setup and activate MFA
      const setup = service.setupMfa(userId);
      service.verifySetup(userId, totp(setup.secret));

      expect(service.isMfaEnabled(userId)).toBe(true);

      // Instance B: new service instance, same data directory
      const instanceB = new MfaService({ dataDir });

      // Should see the MFA enrollment from instance A
      expect(instanceB.isMfaEnabled(userId)).toBe(true);

      // Should be able to verify TOTP codes
      const code = totp(setup.secret);
      const result = instanceB.verifyCode(userId, code);
      expect(result).toBe(true);
    });

    it('backup code consumed on A is rejected on B', () => {
      const userId = 'alice';

      // Instance A: setup, enable, and consume backup code
      const setup = service.setupMfa(userId);
      const backupCode = setup.backupCodes[0];

      service.verifySetup(userId, totp(setup.secret));
      service.verifyCode(userId, backupCode); // Consume

      expect(service.verifyCode(userId, backupCode)).toBe(false); // Already consumed

      // Instance B: should also see the code as consumed
      const instanceB = new MfaService({ dataDir });

      const result = instanceB.verifyCode(userId, backupCode);
      expect(result).toBe(false); // Should be rejected
    });

    it('backup code count is accurate across instances', () => {
      const userId = 'alice';

      // Instance A: setup and consume 2 backup codes
      const setup = service.setupMfa(userId);

      service.verifySetup(userId, totp(setup.secret));
      service.verifyCode(userId, setup.backupCodes[0]);
      service.verifyCode(userId, setup.backupCodes[1]);

      let status = service.getMfaStatus(userId);
      expect(status?.backupCodesRemaining).toBe(6);

      // Instance B: should reflect the same count
      const instanceB = new MfaService({ dataDir });

      status = instanceB.getMfaStatus(userId);
      expect(status?.backupCodesRemaining).toBe(6);

      // Can't reuse consumed codes on instance B
      expect(instanceB.verifyCode(userId, setup.backupCodes[0])).toBe(false);
      expect(instanceB.verifyCode(userId, setup.backupCodes[1])).toBe(false);
    });

    it('MFA enrollment survives service restart', () => {
      const userId = 'alice';

      // Enroll and activate MFA
      const setup = service.setupMfa(userId);
      service.verifySetup(userId, totp(setup.secret));

      expect(service.isMfaEnabled(userId)).toBe(true);

      // "Restart" by creating a new service instance pointing to same data
      const restarted = new MfaService({ dataDir });

      // MFA should still be enabled
      expect(restarted.isMfaEnabled(userId)).toBe(true);
      expect(restarted.getMfaStatus(userId)?.enabled).toBe(true);

      // Should be able to use TOTP codes
      const code = totp(setup.secret);
      expect(restarted.verifyCode(userId, code)).toBe(true);
    });

    it('multiple users can enroll independently across instances', () => {
      const user1 = 'alice';
      const user2 = 'bob';

      // Instance A: enroll both users
      const setup1 = service.setupMfa(user1);
      const setup2 = service.setupMfa(user2);

      service.verifySetup(user1, totp(setup1.secret));
      service.verifySetup(user2, totp(setup2.secret));

      // Instance B: should see both users' enrollments
      const instanceB = new MfaService({ dataDir });

      expect(instanceB.isMfaEnabled(user1)).toBe(true);
      expect(instanceB.isMfaEnabled(user2)).toBe(true);

      // Both users should be able to authenticate
      expect(instanceB.verifyCode(user1, totp(setup1.secret))).toBe(true);
      expect(instanceB.verifyCode(user2, totp(setup2.secret))).toBe(true);
    });

    it('disabling MFA on A is visible on B', () => {
      const userId = 'alice';

      // Instance A: enroll and disable
      const setup = service.setupMfa(userId);
      service.verifySetup(userId, totp(setup.secret));

      expect(service.isMfaEnabled(userId)).toBe(true);

      service.disableMfa(userId);

      expect(service.isMfaEnabled(userId)).toBe(false);

      // Instance B: should also see MFA as disabled
      const instanceB = new MfaService({ dataDir });

      expect(instanceB.isMfaEnabled(userId)).toBe(false);
      expect(instanceB.getMfaStatus(userId)).toBeNull();
    });

    it('last-write-wins when same user is setup on multiple instances', () => {
      const userId = 'alice';

      // Instance A: initial setup
      const setup = service.setupMfa(userId);

      // Instance B: setup for same user (overwrites A's setup in durable store)
      const instanceB = new MfaService({ dataDir });
      const setup2 = instanceB.setupMfa(userId);

      // They should have different secrets (last write wins)
      expect(setup.secret).not.toBe(setup2.secret);

      // Instance C (fresh load): should get B's secret
      const instanceC = new MfaService({ dataDir });
      const status = instanceC.getMfaStatus(userId);
      expect(status).toBeDefined();
      expect(status?.enabled).toBe(false); // Still pending from B's setup

      // Verify with C's loaded secret works
      expect(instanceC.verifySetup(userId, totp(setup2.secret))).toBe(true);

      // Instance D (fresh load after C's activation): should see it enabled
      const instanceD = new MfaService({ dataDir });
      expect(instanceD.isMfaEnabled(userId)).toBe(true);
    });
  });

  // ── Internal reset ─────────────────────────────────────────────────────

  describe('_resetForTest', () => {
    it('clears all MFA records', () => {
      const user1 = 'alice';
      const user2 = 'bob';

      const setup1 = service.setupMfa(user1);
      const setup2 = service.setupMfa(user2);

      service.verifySetup(user1, totp(setup1.secret));
      service.verifySetup(user2, totp(setup2.secret));

      service._resetForTest();

      expect(service.isMfaEnabled(user1)).toBe(false);
      expect(service.isMfaEnabled(user2)).toBe(false);
    });
  });
});
