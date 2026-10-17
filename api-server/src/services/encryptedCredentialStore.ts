import { getPool } from '../db.js';
import type { EncryptedData, ThresholdKeyShare } from '../crypto/thresholdEncryption.js';
import { logger } from './logger.js';

/**
 * Encrypted Credential Store
 * Manages persistence and access control for encrypted sensitive credential data
 */

export interface EncryptedCredentialRecord {
  id: number;
  credential_id: bigint;
  encrypted_data: EncryptedData;
  key_shares: ThresholdKeyShare[];
  key_custodians: string[]; // Addresses of parties who hold key shares
  threshold: number;
  created_at: number;
  updated_at: number;
}

export interface DecryptionAuthorization {
  credential_id: bigint;
  requester_address: string;
  authorized_at: number;
  expires_at: number;
  reason: string;
  approved_by: string[];
}

type EncryptedCredentialDatabaseRow = Omit<
  EncryptedCredentialRecord,
  'encrypted_data' | 'key_shares' | 'key_custodians'
> & {
  encrypted_data: unknown;
  key_shares: unknown;
  key_custodians: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonField<T>(
  value: unknown,
  field: string,
  isExpected: (candidate: unknown) => candidate is T,
): T {
  let parsed: unknown;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    throw new Error(`Invalid JSON in ${field}`);
  }

  if (!isExpected(parsed)) {
    throw new Error(`Invalid ${field} shape`);
  }
  return parsed;
}

function isEncryptedData(value: unknown): value is EncryptedData {
  return isRecord(value) &&
    typeof value.ciphertext === 'string' &&
    typeof value.iv === 'string' &&
    typeof value.tag === 'string' &&
    Number.isInteger(value.threshold) &&
    Number.isInteger(value.shares_count) &&
    Array.isArray(value.share_metadata) &&
    value.share_metadata.every((item) =>
      isRecord(item) &&
      Number.isInteger(item.share_id) &&
      typeof item.commitment === 'string'
    );
}

function isThresholdKeyShares(value: unknown): value is ThresholdKeyShare[] {
  return Array.isArray(value) && value.every((share) =>
    isRecord(share) &&
    Number.isInteger(share.share_id) &&
    typeof share.share_value === 'string' &&
    typeof share.commitment === 'string'
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export class EncryptedCredentialStore {
  /**
   * Store encrypted credential data
   */
  async storeEncryptedCredential(
    credentialId: bigint,
    encryptedData: EncryptedData,
    keyShares: ThresholdKeyShare[],
    keyCustodians: string[]
  ): Promise<EncryptedCredentialRecord> {
    const pool = getPool();
    const now = Date.now();

    const query = `
      INSERT INTO encrypted_credentials (
        credential_id,
        encrypted_data,
        key_shares,
        key_custodians,
        threshold,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (credential_id)
      DO UPDATE SET
        encrypted_data = $2,
        key_shares = $3,
        updated_at = $7
      RETURNING *;
    `;

    const result = await pool.query<EncryptedCredentialDatabaseRow>(query, [
      credentialId,
      JSON.stringify(encryptedData),
      JSON.stringify(keyShares),
      JSON.stringify(keyCustodians),
      encryptedData.threshold,
      now,
      now,
    ]);

    try {
      return this.parseRecord(result.rows[0]);
    } catch (error) {
      logger.error('Failed to parse encrypted credential returned from database', 'encrypted-credential-store', {
        credentialId: credentialId.toString(),
        error: String(error),
      });
      throw error;
    }
  }

  /**
   * Retrieve encrypted credential data
   */
  async getEncryptedCredential(credentialId: bigint): Promise<EncryptedCredentialRecord | null> {
    const pool = getPool();

    const query = `
      SELECT *
      FROM encrypted_credentials
      WHERE credential_id = $1;
    `;

    const result = await pool.query<EncryptedCredentialDatabaseRow>(query, [credentialId]);

    if (result.rows.length === 0) return null;

    try {
      return this.parseRecord(result.rows[0]);
    } catch (error) {
      logger.error('Skipping malformed encrypted credential row', 'encrypted-credential-store', {
        credentialId: credentialId.toString(),
        error: String(error),
      });
      return null;
    }
  }

  /**
   * Authorize decryption of a credential for a specific address
   */
  async authorizeDecryption(
    credentialId: bigint,
    requesterAddress: string,
    expiresIn: number = 3600000, // 1 hour default
    reason: string = 'Not specified',
    approvedBy: string[] = []
  ): Promise<DecryptionAuthorization> {
    const pool = getPool();
    const now = Date.now();
    const expiresAt = now + expiresIn;

    const query = `
      INSERT INTO decryption_authorizations (
        credential_id,
        requester_address,
        authorized_at,
        expires_at,
        reason,
        approved_by
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (credential_id, requester_address)
      DO UPDATE SET
        authorized_at = $3,
        expires_at = $4,
        reason = $5,
        approved_by = $6
      RETURNING *;
    `;

    const result = await pool.query<DecryptionAuthorization>(query, [
      credentialId,
      requesterAddress,
      now,
      expiresAt,
      reason,
      JSON.stringify(approvedBy),
    ]);

    return result.rows[0];
  }

  /**
   * Check if a requester is authorized to decrypt a credential
   */
  async isDecryptionAuthorized(credentialId: bigint, requesterAddress: string): Promise<boolean> {
    const pool = getPool();
    const now = Date.now();

    const query = `
      SELECT 1
      FROM decryption_authorizations
      WHERE credential_id = $1
        AND requester_address = $2
        AND expires_at > $3
      LIMIT 1;
    `;

    const result = await pool.query<{ one: number }>(query, [
      credentialId,
      requesterAddress,
      now,
    ]);

    return result.rows.length > 0;
  }

  /**
   * Revoke decryption authorization
   */
  async revokeDecryptionAuthorization(
    credentialId: bigint,
    requesterAddress: string
  ): Promise<boolean> {
    const pool = getPool();

    const query = `
      DELETE FROM decryption_authorizations
      WHERE credential_id = $1 AND requester_address = $2;
    `;

    const result = await pool.query(query, [credentialId, requesterAddress]);

    return (result.rowCount || 0) > 0;
  }

  /**
   * Get all active authorizations for a credential
   */
  async getActiveAuthorizations(credentialId: bigint): Promise<DecryptionAuthorization[]> {
    const pool = getPool();
    const now = Date.now();

    const query = `
      SELECT *
      FROM decryption_authorizations
      WHERE credential_id = $1 AND expires_at > $2
      ORDER BY authorized_at DESC;
    `;

    const result = await pool.query<DecryptionAuthorization>(query, [credentialId, now]);

    return result.rows;
  }

  /**
   * Get key custodians for a credential
   */
  async getKeyCustodians(credentialId: bigint): Promise<string[]> {
    const pool = getPool();

    const query = `
      SELECT key_custodians
      FROM encrypted_credentials
      WHERE credential_id = $1;
    `;

    const result = await pool.query<{ key_custodians: unknown }>(query, [credentialId]);

    if (result.rows.length === 0) {
      return [];
    }

    try {
      return parseJsonField(result.rows[0].key_custodians, 'key_custodians', isStringArray);
    } catch (error) {
      logger.error('Skipping malformed key custodians value', 'encrypted-credential-store', {
        credentialId: credentialId.toString(),
        error: String(error),
      });
      return [];
    }
  }

  /**
   * Audit log for decryption attempts
   */
  async logDecryptionAttempt(
    credentialId: bigint,
    requesterAddress: string,
    success: boolean,
    details: Record<string, unknown> = {}
  ): Promise<void> {
    const pool = getPool();
    const now = Date.now();

    const query = `
      INSERT INTO decryption_audit_log (
        credential_id,
        requester_address,
        success,
        details,
        timestamp
      ) VALUES ($1, $2, $3, $4, $5);
    `;

    await pool.query(query, [
      credentialId,
      requesterAddress,
      success,
      JSON.stringify(details),
      now,
    ]);
  }

  /**
   * Cleanup expired authorizations
   */
  async cleanupExpiredAuthorizations(): Promise<number> {
    const pool = getPool();
    const now = Date.now();

    const query = `
      DELETE FROM decryption_authorizations
      WHERE expires_at < $1;
    `;

    const result = await pool.query(query, [now]);

    return result.rowCount || 0;
  }

  /**
   * Parse a record from database query result
   */
  private parseRecord(row: EncryptedCredentialDatabaseRow): EncryptedCredentialRecord {
    return {
      ...row,
      encrypted_data: parseJsonField(row.encrypted_data, 'encrypted_data', isEncryptedData),
      key_shares: parseJsonField(row.key_shares, 'key_shares', isThresholdKeyShares),
      key_custodians: parseJsonField(row.key_custodians, 'key_custodians', isStringArray),
    };
  }
}
