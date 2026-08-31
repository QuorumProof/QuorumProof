/**
 * MFA Service — Issue #1299 / #1364 / #1431
 *
 * Implements TOTP-based Multi-Factor Authentication using the RFC 6238 standard.
 * Uses Node's built-in crypto for HMAC-SHA1 (TOTP standard).
 *
 * Storage: Postgres-backed (mfa_enrollments table) when a pool is available,
 * with TOTP secrets encrypted at rest using AES-256-GCM. Falls back to the
 * original DurableLog implementation in test environments where no pool is
 * initialised (preserving all existing DurableLog-based test contracts).
 *
 * Encryption key: MFA_ENCRYPTION_KEY environment variable (hex-encoded 32-byte
 * key, i.e. 64 hex chars). If unset, a fixed dev key is used and a warning is
 * logged.
 */

import crypto from 'crypto';
import path from 'path';
import { DurableLog } from './durableLog.js';
import { getPool } from '../db.js';
import type { Pool as PgPool } from 'pg';

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
// Encryption helpers (AES-256-GCM)
// ---------------------------------------------------------------------------

const DEV_ENCRYPTION_KEY = '0000000000000000000000000000000000000000000000000000000000000000';
let _warnedAboutDevKey = false;

function getEncryptionKey(): Buffer {
  const hexKey = process.env.MFA_ENCRYPTION_KEY;
  if (!hexKey) {
    if (!_warnedAboutDevKey) {
      console.warn(
        '[MFA] WARNING: MFA_ENCRYPTION_KEY is not set. ' +
        'Using a fixed dev key — do NOT use this in production.'
      );
      _warnedAboutDevKey = true;
    }
    return Buffer.from(DEV_ENCRYPTION_KEY, 'hex');
  }
  if (hexKey.length !== 64) {
    throw new Error('MFA_ENCRYPTION_KEY must be a 64-char hex string (32 bytes).');
  }
  return Buffer.from(hexKey, 'hex');
}

function encryptSecret(plaintext: string): { enc: string; iv: string; tag: string } {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    enc: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

function decryptSecret(enc: string, iv: string, tag: string): string {
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(enc, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
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

function hotp(secret: Buffer, counter: bigint, digits = 6): string {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(counter);
  const hmac = crypto.createHmac('sha1', secret).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const otp = code % Math.pow(10, digits);
  return String(otp).padStart(digits, '0');
}

export function totp(secret: string, timestampMs = Date.now(), step = 30, digits = 6): string {
  const keyBytes = base32Decode(secret);
  const counter = BigInt(Math.floor(timestampMs / 1000 / step));
  return hotp(keyBytes, counter, digits);
}

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
    const code = crypto.randomBytes(5).toString('hex').toUpperCase();
    plain.push(code);
    hashed.push(crypto.createHash('sha256').update(code).digest('hex'));
  }
  return { plain, hashed };
}

// ---------------------------------------------------------------------------
// Dual-mode pool helper
// ---------------------------------------------------------------------------

function getPoolSafe(): PgPool | null {
  try {
    return getPool();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// MfaService
// ---------------------------------------------------------------------------

export interface MfaServiceOptions {
  /** Postgres pool to use (takes precedence over the global singleton). */
  pool?: PgPool;
  /** Legacy: path to a directory for DurableLog files (used in fallback mode). */
  dataDir?: string;
}

export class MfaService {
  readonly dataDir: string;
  /** DurableLog — only used when no Postgres pool is available. */
  private readonly _fallbackStore: DurableLog<MfaRecord>;
  /** Explicit pool override (from constructor options or test injection). */
  private readonly _pool: PgPool | undefined;

  constructor(options: MfaServiceOptions = {}) {
    const dataDir = options.dataDir ?? process.env.MFA_STORE_DATA_DIR ?? path.join(process.cwd(), '.data', 'mfa');
    this.dataDir = dataDir;
    this._pool = options.pool;
    this._fallbackStore = new DurableLog<MfaRecord>(path.join(dataDir, 'records.jsonl'));
  }

  /** Returns the active pool or null (triggers DurableLog fallback). */
  private pool(): PgPool | null {
    return this._pool ?? getPoolSafe();
  }

  // ── Setup ──────────────────────────────────────────────────────────────

  /**
   * Begin MFA setup for a user.
   * Generates a new TOTP secret and backup codes.
   * The setup is NOT active until the user calls verifySetup().
   */
  async setupMfa(userId: string, issuerLabel = 'QuorumProof'): Promise<MfaSetupResult> {
    const secretBytes = crypto.randomBytes(20);
    const secret = base32Encode(secretBytes);
    const { plain, hashed } = generateBackupCodes();

    const pool = this.pool();
    if (pool) {
      const { enc, iv, tag } = encryptSecret(secret);
      await pool.query(
        `INSERT INTO mfa_enrollments
           (user_id, secret_enc, secret_iv, secret_tag, enabled, backup_codes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, false, $5, now(), now())
         ON CONFLICT (user_id) DO UPDATE SET
           secret_enc  = EXCLUDED.secret_enc,
           secret_iv   = EXCLUDED.secret_iv,
           secret_tag  = EXCLUDED.secret_tag,
           enabled     = false,
           enabled_at  = NULL,
           backup_codes = EXCLUDED.backup_codes,
           updated_at  = now()`,
        [userId, enc, iv, tag, hashed]
      );
    } else {
      this._fallbackStore.set(userId, {
        userId,
        secret,
        enabled: false,
        backupCodes: hashed,
      });
    }

    const accountName = encodeURIComponent(userId);
    const issuer = encodeURIComponent(issuerLabel);
    const otpAuthUrl = `otpauth://totp/${issuer}:${accountName}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;

    return { secret, otpAuthUrl, backupCodes: plain };
  }

  // ── Verify setup ───────────────────────────────────────────────────────

  /**
   * Confirm MFA setup by verifying the user's first TOTP code.
   * Activates MFA if the code is valid.
   */
  async verifySetup(userId: string, code: string): Promise<boolean> {
    const pool = this.pool();
    if (pool) {
      const result = await pool.query<{
        secret_enc: string; secret_iv: string; secret_tag: string; enabled: boolean;
      }>(
        `SELECT secret_enc, secret_iv, secret_tag, enabled
         FROM mfa_enrollments WHERE user_id = $1`,
        [userId]
      );
      if (result.rows.length === 0) return false;
      const row = result.rows[0];
      if (row.enabled) return false;
      const secret = decryptSecret(row.secret_enc, row.secret_iv, row.secret_tag);
      if (!verifyTotp(secret, code)) return false;
      await pool.query(
        `UPDATE mfa_enrollments SET enabled = true, enabled_at = now(), updated_at = now()
         WHERE user_id = $1`,
        [userId]
      );
      return true;
    }

    // DurableLog fallback
    const record = this._fallbackStore.get(userId);
    if (!record) return false;
    if (record.enabled) return false;
    if (!verifyTotp(record.secret, code)) return false;
    record.enabled = true;
    record.enabledAt = new Date().toISOString();
    this._fallbackStore.set(userId, record);
    return true;
  }

  // ── Verify code ────────────────────────────────────────────────────────

  /**
   * Verify a TOTP code for an already-enabled user.
   * Also accepts backup codes (single-use).
   */
  async verifyCode(userId: string, code: string): Promise<boolean> {
    const pool = this.pool();
    if (pool) {
      const result = await pool.query<{
        secret_enc: string; secret_iv: string; secret_tag: string;
        enabled: boolean; backup_codes: string[];
      }>(
        `SELECT secret_enc, secret_iv, secret_tag, enabled, backup_codes
         FROM mfa_enrollments WHERE user_id = $1`,
        [userId]
      );
      if (result.rows.length === 0) return false;
      const row = result.rows[0];
      if (!row.enabled) return false;

      const secret = decryptSecret(row.secret_enc, row.secret_iv, row.secret_tag);
      if (verifyTotp(secret, code)) return true;

      // Check backup codes
      const upper = code.toUpperCase();
      const hash = crypto.createHash('sha256').update(upper).digest('hex');
      const idx = row.backup_codes.indexOf(hash);
      if (idx !== -1) {
        const updated = [...row.backup_codes];
        updated.splice(idx, 1);
        await pool.query(
          `UPDATE mfa_enrollments SET backup_codes = $1, updated_at = now() WHERE user_id = $2`,
          [updated, userId]
        );
        return true;
      }
      return false;
    }

    // DurableLog fallback
    const record = this._fallbackStore.get(userId);
    if (!record || !record.enabled) return false;
    if (verifyTotp(record.secret, code)) return true;

    const upper = code.toUpperCase();
    const hash = crypto.createHash('sha256').update(upper).digest('hex');
    const idx = record.backupCodes.indexOf(hash);
    if (idx !== -1) {
      record.backupCodes.splice(idx, 1);
      this._fallbackStore.set(userId, record);
      return true;
    }
    return false;
  }

  // ── isMfaEnabled ───────────────────────────────────────────────────────

  /** Check if MFA is enabled for a user. */
  async isMfaEnabled(userId: string): Promise<boolean> {
    const pool = this.pool();
    if (pool) {
      const result = await pool.query<{ enabled: boolean }>(
        `SELECT enabled FROM mfa_enrollments WHERE user_id = $1`,
        [userId]
      );
      return result.rows[0]?.enabled ?? false;
    }
    return this._fallbackStore.get(userId)?.enabled ?? false;
  }

  // ── getMfaStatus ───────────────────────────────────────────────────────

  /** Get the MFA status for a user (without exposing the secret). */
  async getMfaStatus(userId: string): Promise<{ enabled: boolean; enabledAt?: string; backupCodesRemaining: number } | null> {
    const pool = this.pool();
    if (pool) {
      const result = await pool.query<{
        enabled: boolean; enabled_at: Date | null; backup_codes: string[];
      }>(
        `SELECT enabled, enabled_at, backup_codes FROM mfa_enrollments WHERE user_id = $1`,
        [userId]
      );
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      return {
        enabled: row.enabled,
        enabledAt: row.enabled_at instanceof Date ? row.enabled_at.toISOString() : row.enabled_at ?? undefined,
        backupCodesRemaining: row.backup_codes.length,
      };
    }

    const record = this._fallbackStore.get(userId);
    if (!record) return null;
    return {
      enabled: record.enabled,
      enabledAt: record.enabledAt,
      backupCodesRemaining: record.backupCodes.length,
    };
  }

  // ── disableMfa ─────────────────────────────────────────────────────────

  /** Disable MFA for a user (admin use / account recovery). */
  async disableMfa(userId: string): Promise<boolean> {
    const pool = this.pool();
    if (pool) {
      const result = await pool.query(
        `DELETE FROM mfa_enrollments WHERE user_id = $1`,
        [userId]
      );
      return (result.rowCount ?? 0) > 0;
    }
    if (!this._fallbackStore.has(userId)) return false;
    this._fallbackStore.delete(userId);
    return true;
  }

  // ── _resetForTest ──────────────────────────────────────────────────────

  /** For testing only. */
  async _resetForTest(): Promise<void> {
    const pool = this.pool();
    if (pool) {
      await pool.query('DELETE FROM mfa_enrollments');
    } else {
      for (const key of this._fallbackStore.keys()) this._fallbackStore.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let defaultMfaService: MfaService | undefined;

export function getDefaultMfaService(): MfaService {
  if (!defaultMfaService) defaultMfaService = new MfaService();
  return defaultMfaService;
}

export function _setDefaultMfaServiceForTest(svc: MfaService | undefined): void {
  defaultMfaService = svc;
}
