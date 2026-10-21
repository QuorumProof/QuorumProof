import { getPool } from '../db.js';
import type { EncryptedData, ThresholdKeyShare } from '../crypto/thresholdEncryption.js';

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

function invalidRecord(field: string): Error {
  return new Error(`Invalid encrypted credential record: ${field}`);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function parseJsonField(value: unknown, field: string): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw invalidRecord(`${field} contains malformed JSON`);
  }
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidRecord(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseEncryptedData(value: unknown): EncryptedData {
  const data = asRecord(parseJsonField(value, 'encrypted_data'), 'encrypted_data');
  const metadata = data['share_metadata'];
  if (
    typeof data['ciphertext'] !== 'string' ||
    typeof data['iv'] !== 'string' ||
    typeof data['tag'] !== 'string' ||
    !isInteger(data['threshold']) ||
    data['threshold'] < 1 ||
    !isInteger(data['shares_count']) ||
    data['shares_count'] < data['threshold'] ||
    data['shares_count'] > 255 ||
    !Array.isArray(metadata) ||
    metadata.some((entry) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return true;
      const item = entry as Record<string, unknown>;
      return (
        !isInteger(item['share_id']) ||
        item['share_id'] < 1 ||
        item['share_id'] > Number(data['shares_count']) ||
        typeof item['commitment'] !== 'string'
      );
    })
  ) {
    throw invalidRecord('encrypted_data has an invalid shape');
  }
  const metadataIds = metadata.map((entry) => (entry as Record<string, unknown>)['share_id']);
  if (new Set(metadataIds).size !== metadataIds.length || metadataIds.length !== data['shares_count']) {
    throw invalidRecord('encrypted_data share_metadata does not match shares_count');
  }
  return data as unknown as EncryptedData;
}

function parseKeyShares(value: unknown, sharesCount: number): ThresholdKeyShare[] {
  const shares = parseJsonField(value, 'key_shares');
  if (
    !Array.isArray(shares) ||
    shares.length !== sharesCount ||
    shares.some((share) => {
      if (share === null || typeof share !== 'object' || Array.isArray(share)) return true;
      const item = share as Record<string, unknown>;
      return (
        !isInteger(item['share_id']) ||
        item['share_id'] < 1 ||
        item['share_id'] > sharesCount ||
        typeof item['share_value'] !== 'string' ||
        typeof item['commitment'] !== 'string'
      );
    })
  ) {
    throw invalidRecord('key_shares has an invalid shape');
  }
  const shareIds = shares.map((share) => (share as Record<string, unknown>)['share_id']);
  if (new Set(shareIds).size !== shareIds.length) {
    throw invalidRecord('key_shares contains duplicate share IDs');
  }
  return shares as ThresholdKeyShare[];
}

function parseStringArray(value: unknown, field: string): string[] {
  const parsed = parseJsonField(value, field);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw invalidRecord(`${field} must be an array of strings`);
  }
  return parsed;
}

function parseCredentialId(value: unknown): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) throw invalidRecord('credential_id must be a non-negative integer');
    return value;
  }
  if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isSafeInteger(value))) {
    throw invalidRecord('credential_id must be an integer');
  }
  const raw = String(value);
  if (!/^\d+$/.test(raw)) throw invalidRecord('credential_id must be a non-negative integer');
  return BigInt(raw);
}

function parseTimestamp(value: unknown, field: string): number {
  const timestamp = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw invalidRecord(`${field} must be a non-negative integer timestamp`);
  }
  return timestamp;
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

    const result = await pool.query<Record<string, unknown>>(query, [
      credentialId,
      JSON.stringify(encryptedData),
      JSON.stringify(keyShares),
      JSON.stringify(keyCustodians),
      encryptedData.threshold,
      now,
      now,
    ]);

    return this.parseRecord(result.rows[0]);
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

    const result = await pool.query<Record<string, unknown>>(query, [credentialId]);

    return result.rows.length > 0 ? this.parseRecord(result.rows[0]) : null;
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

    return parseStringArray(result.rows[0].key_custodians, 'key_custodians');
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
  private parseRecord(row: unknown): EncryptedCredentialRecord {
    const record = asRecord(row, 'row');
    const encryptedData = parseEncryptedData(record['encrypted_data']);
    const keyShares = parseKeyShares(record['key_shares'], encryptedData.shares_count);
    const threshold = record['threshold'];
    const id = record['id'];
    if (
      !isInteger(id) ||
      id < 1 ||
      !isInteger(threshold) ||
      threshold !== encryptedData.threshold
    ) {
      throw invalidRecord('id or threshold is invalid');
    }
    const commitments = new Map(
      encryptedData.share_metadata.map(({ share_id, commitment }) => [share_id, commitment]),
    );
    if (keyShares.some((share) => commitments.get(share.share_id) !== share.commitment)) {
      throw invalidRecord('key_shares commitments do not match encrypted_data');
    }

    return {
      id,
      credential_id: parseCredentialId(record['credential_id']),
      encrypted_data: encryptedData,
      key_shares: keyShares,
      key_custodians: parseStringArray(record['key_custodians'], 'key_custodians'),
      threshold,
      created_at: parseTimestamp(record['created_at'], 'created_at'),
      updated_at: parseTimestamp(record['updated_at'], 'updated_at'),
    };
  }
}
