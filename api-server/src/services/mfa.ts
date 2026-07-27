/**
 * MFA Service — Issue #1299
 *
 * Implements TOTP-based Multi-Factor Authentication using the RFC 6238 standard.
 * Uses @noble/hashes for HMAC-SHA1 (TOTP standard) without requiring extra deps.
 *
 * Each user can have one active TOTP secret. Pending secrets are stored until
 * the user verifies their first code, at which point MFA is fully enabled.
 */

import crypto from 'crypto';

export interface MfaRecord {
  userId: string;
  secret: string;          // base32-encoded TOTP secret
  enabled: boolean;        // true once the user has verified a code
  enabledAt?: string;      // ISO timestamp when MFA was confirmed
  backupCodes: string[];   // hashed single-use backup codes
}

export interface MfaSetupResult {
  secret: string;          // base32 secret for authenticator app
  otpAuthUrl: string;      // otpauth:// URI for QR code generation
  backupCodes: string[];   // plain-text codes (shown once)
}

// ---------------------------------------------------------------------------
// Base32 helpers (RFC 4648 — subset used by TOTP)
// ---------------------------------------------------------------------------
const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_CHARS[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_CHARS[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(encoded: string): Buffer {
  const clean = encoded.toUpperCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of clean) {
    const idx = BASE32_CHARS.indexOf(char);
    if (idx === -1) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

// ---------------------------------------------------------------------------
// HOTP / TOTP core (RFC 4226 / RFC 6238)
// ---------------------------------------------------------------------------

/**
 * Compute HOTP value for a given secret and counter.
 */
function hotp(secret: Buffer, counter: bigint, digits = 6): string {
  // Encode counter as 8-byte big-endian buffer
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(counter);

  const hmac = crypto.createHmac('sha1', secret).update(counterBuf).digest();

  // Dynamic truncation
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const otp = code % Math.pow(10, digits);
  return String(otp).padStart(digits, '0');
}

/**
 * Compute TOTP value for the current (or provided) timestamp.
 * step = 30 seconds, digits = 6.
 */
export function totp(secret: string, timestampMs = Date.now(), step = 30, digits = 6): string {
  const keyBytes = base32Decode(secret);
  const counter = BigInt(Math.floor(timestampMs / 1000 / step));
  return hotp(keyBytes, counter, digits);
}

/**
 * Verify a TOTP code with a ±1 step tolerance window (allows for clock skew).
 */
export function verifyTotp(
  secret: string,
  code: string,
  timestampMs = Date.now(),
  step = 30,
  window = 1,
): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const keyBytes = base32Decode(secret);
  const counter = BigInt(Math.floor(timestampMs / 1000 / step));
  for (let delta = -window; delta <= window; delta++) {
    const expected = hotp(keyBytes, counter + BigInt(delta), 6);
    if (timingSafeEqual(expected, code)) return true;
  }
  return false;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ---------------------------------------------------------------------------
// Backup codes
// ---------------------------------------------------------------------------

const BACKUP_CODE_COUNT = 8;

function generateBackupCodes(): { plain: string[]; hashed: string[] } {
  const plain: string[] = [];
  const hashed: string[] = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    const code = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10-char hex
    plain.push(code);
    hashed.push(crypto.createHash('sha256').update(code).digest('hex'));
  }
  return { plain, hashed };
}

// ---------------------------------------------------------------------------
// MfaService
// ---------------------------------------------------------------------------

export class MfaService {
  /** userId → MfaRecord */
  private readonly store = new Map<string, MfaRecord>();

  /**
   * Begin MFA setup for a user.
   * Generates a new TOTP secret and backup codes.
   * The setup is NOT active until the user calls verifySetup().
   */
  setupMfa(userId: string, issuerLabel = 'QuorumProof'): MfaSetupResult {
    const secretBytes = crypto.randomBytes(20); // 160-bit secret (recommended)
    const secret = base32Encode(secretBytes);

    const { plain, hashed } = generateBackupCodes();

    // Store the record in pending state (enabled = false)
    this.store.set(userId, {
      userId,
      secret,
      enabled: false,
      backupCodes: hashed,
    });

    const accountName = encodeURIComponent(userId);
    const issuer = encodeURIComponent(issuerLabel);
    const otpAuthUrl = `otpauth://totp/${issuer}:${accountName}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;

    return {
      secret,
      otpAuthUrl,
      backupCodes: plain,
    };
  }

  /**
   * Confirm MFA setup by verifying the user's first TOTP code.
   * Activates MFA if the code is valid.
   */
  verifySetup(userId: string, code: string): boolean {
    const record = this.store.get(userId);
    if (!record) return false;
    if (record.enabled) return false; // already enabled — use verifyCode instead

    if (!verifyTotp(record.secret, code)) return false;

    record.enabled = true;
    record.enabledAt = new Date().toISOString();
    this.store.set(userId, record);
    return true;
  }

  /**
   * Verify a TOTP code for an already-enabled user.
   * Also accepts backup codes (single-use).
   */
  verifyCode(userId: string, code: string): boolean {
    const record = this.store.get(userId);
    if (!record || !record.enabled) return false;

    // Check TOTP
    if (verifyTotp(record.secret, code)) return true;

    // Check backup codes (case-insensitive)
    const upper = code.toUpperCase();
    const hash = crypto.createHash('sha256').update(upper).digest('hex');
    const idx = record.backupCodes.indexOf(hash);
    if (idx !== -1) {
      // Consume the backup code
      record.backupCodes.splice(idx, 1);
      this.store.set(userId, record);
      return true;
    }

    return false;
  }

  /** Check if MFA is enabled for a user. */
  isMfaEnabled(userId: string): boolean {
    return this.store.get(userId)?.enabled ?? false;
  }

  /** Get the MFA record for a user (without exposing the secret). */
  getMfaStatus(userId: string): { enabled: boolean; enabledAt?: string; backupCodesRemaining: number } | null {
    const record = this.store.get(userId);
    if (!record) return null;
    return {
      enabled: record.enabled,
      enabledAt: record.enabledAt,
      backupCodesRemaining: record.backupCodes.length,
    };
  }

  /** Disable MFA for a user (admin use / account recovery). */
  disableMfa(userId: string): boolean {
    const record = this.store.get(userId);
    if (!record) return false;
    this.store.delete(userId);
    return true;
  }

  /** For testing only. */
  _resetForTest(): void {
    this.store.clear();
  }
}

let defaultMfaService: MfaService | undefined;

export function getDefaultMfaService(): MfaService {
  if (!defaultMfaService) defaultMfaService = new MfaService();
  return defaultMfaService;
}

export function _setDefaultMfaServiceForTest(svc: MfaService | undefined): void {
  defaultMfaService = svc;
}
