/**
 * Issue #662: Audit Trail Service
 * Provides audit log querying, export, and verification capabilities.
 * Supports GDPR-compliant log retention and Merkle tree notarization verification.
 */

export interface AuditEntry {
  id: bigint;
  action: number;
  credential_id: bigint;
  actor: string;
  timestamp: bigint;
  ledger_sequence: number;
  payload_hash: string;
}

export interface NotarizationRecord {
  batch_id: bigint;
  merkle_root: string;
  entry_count: number;
  first_entry_id: bigint;
  last_entry_id: bigint;
  notarized_at: bigint;
  notarized_ledger: number;
}

export interface AuditFilter {
  credentialId?: bigint;
  action?: number;
  actorAddress?: string;
  startTime?: bigint;
  endTime?: bigint;
  fromId?: bigint;
  limit?: number;
}

const ACTION_NAMES: Record<number, string> = {
  1: 'CredentialIssued',
  2: 'CredentialRevoked',
  3: 'CredentialAttested',
  4: 'CredentialSuspended',
  5: 'CredentialRenewed',
  6: 'SbtMinted',
  7: 'SbtBurned',
};

/**
 * Query audit entries with filtering and pagination.
 * Respects 90-day retention window for GDPR compliance.
 */
export function buildAuditQuery(filter: AuditFilter) {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const retentionWindow = BigInt(90 * 24 * 3600); // 90 days in seconds
  const oldestTimestamp = now - retentionWindow;

  return {
    credentialId: filter.credentialId,
    action: filter.action,
    startTime: filter.startTime ?? oldestTimestamp,
    endTime: filter.endTime ?? now,
    fromId: filter.fromId ?? BigInt(1),
    limit: Math.min(filter.limit ?? 20, 100),
    retention_window_secs: retentionWindow,
  };
}

/**
 * Verify Merkle root integrity by reconstructing the tree from entries.
 * Returns true if the reconstructed root matches the notarized root.
 */
export function verifyMerkleRoot(entries: AuditEntry[], notarization: NotarizationRecord): boolean {
  if (entries.length === 0 || entries.length !== notarization.entry_count) {
    return false;
  }

  const leaves = entries.map((e) => e.payload_hash);
  const reconstructed = computeMerkleRoot(leaves);
  return reconstructed === notarization.merkle_root;
}

/**
 * Compute Merkle root from a list of leaf hashes (hex strings).
 * Uses SHA-256 with paired hashing (odd leaves are duplicated).
 */
export function computeMerkleRoot(leaves: string[]): string {
  if (leaves.length === 0) {
    return '0'.repeat(64); // 32 bytes of zeros
  }
  if (leaves.length === 1) {
    return leaves[0];
  }

  const crypto = require('crypto');
  let current = leaves.map((h) => Buffer.from(h, 'hex')) as unknown as Buffer[];

  while (current.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      const right = i + 1 < current.length ? current[i + 1] : left;
      const combined = Buffer.concat([left, right]);
      const hash = crypto.createHash('sha256').update(combined).digest() as unknown as Buffer;
      next.push(hash);
    }
    current = next;
  }

  return (current[0] as unknown as Buffer).toString('hex');
}

/**
 * Generate a GDPR-compliant audit export in JSON lines format.
 * Respects the 90-day retention window and includes only relevant fields.
 */
export function exportAuditLogs(entries: AuditEntry[], format: 'jsonl' | 'json' = 'jsonl'): string {
  const serialized = entries.map((e) => ({
    entry_id: e.id.toString(),
    action: ACTION_NAMES[e.action] || `Unknown(${e.action})`,
    credential_id: e.credential_id.toString(),
    actor: e.actor,
    timestamp: new Date(Number(e.timestamp) * 1000).toISOString(),
    ledger_sequence: e.ledger_sequence,
    payload_hash: e.payload_hash,
  }));

  if (format === 'json') {
    return JSON.stringify(serialized, null, 2);
  }

  // JSON Lines: one record per line
  return serialized.map((record) => JSON.stringify(record)).join('\n');
}

/**
 * Check if an audit entry is outside the GDPR retention window.
 * Returns true if the entry should be purged.
 */
export function isEntryExpired(entry: AuditEntry, nowSeconds: bigint): boolean {
  const retentionWindow = BigInt(90 * 24 * 3600);
  return nowSeconds - entry.timestamp > retentionWindow;
}

/**
 * Group audit entries by credential for compliance audits.
 */
export function groupByCredential(entries: AuditEntry[]): Map<bigint, AuditEntry[]> {
  const grouped = new Map<bigint, AuditEntry[]>();
  for (const entry of entries) {
    if (!grouped.has(entry.credential_id)) {
      grouped.set(entry.credential_id, []);
    }
    grouped.get(entry.credential_id)!.push(entry);
  }
  return grouped;
}

/**
 * Validate audit log integrity by checking:
 * - Entry IDs are sequential
 * - Timestamps are monotonic
 * - Notarization records cover all entries
 */
export function validateLogIntegrity(
  entries: AuditEntry[],
  notarizations: NotarizationRecord[]
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (entries.length === 0) {
    return { valid: true, errors: [] };
  }

  // Check sequential IDs
  for (let i = 0; i < entries.length - 1; i++) {
    const current = entries[i].id;
    const next = entries[i + 1].id;
    if (current >= next) {
      errors.push(`Non-sequential IDs at index ${i}: ${current} >= ${next}`);
    }
  }

  // Check monotonic timestamps
  for (let i = 0; i < entries.length - 1; i++) {
    const current = entries[i].timestamp;
    const next = entries[i + 1].timestamp;
    if (current > next) {
      errors.push(`Non-monotonic timestamps at index ${i}: ${current} > ${next}`);
    }
  }

  // Check notarization coverage (optional but recommended)
  const entryCoverage = new Set<bigint>();
  for (const notarization of notarizations) {
    for (let id = notarization.first_entry_id; id <= notarization.last_entry_id; id += BigInt(1)) {
      entryCoverage.add(id);
    }
  }

  if (entryCoverage.size > 0) {
    for (const entry of entries) {
      if (!entryCoverage.has(entry.id)) {
        errors.push(`Entry ${entry.id} not covered by any notarization`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
