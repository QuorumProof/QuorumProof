import type { Credential } from './contracts/quorumProof';

export interface ImportResult {
  credentials: Credential[];
  errors: string[];
}

function hexToUint8Array(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string');
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return arr;
}

function parseCredentialFromObject(raw: Record<string, unknown>, index: number): Credential {
  const id = raw.id !== undefined ? BigInt(raw.id as string) : undefined;
  const subject = raw.subject as string | undefined;
  const issuer = raw.issuer as string | undefined;
  const credential_type = raw.credential_type !== undefined
    ? Number(raw.credential_type)
    : raw.type !== undefined ? Number(raw.type) : undefined;
  const metadataHex = (raw.metadataHash ?? raw.metadata_hash ?? '') as string;
  const revoked = raw.revoked === true || raw.revoked === 'Yes';
  const expires_at = raw.expiresAt != null && raw.expiresAt !== 'Never' && raw.expiresAt !== ''
    ? BigInt(raw.expiresAt as string)
    : raw.expires_at != null && raw.expires_at !== 'Never' && raw.expires_at !== ''
    ? BigInt(raw.expires_at as string)
    : null;

  if (id === undefined) throw new Error(`Row ${index + 1}: missing "id"`);
  if (!subject) throw new Error(`Row ${index + 1}: missing "subject"`);
  if (!issuer) throw new Error(`Row ${index + 1}: missing "issuer"`);
  if (credential_type === undefined || isNaN(credential_type)) throw new Error(`Row ${index + 1}: missing or invalid "credential_type"`);

  let metadata_hash: Uint8Array;
  try {
    metadata_hash = metadataHex ? hexToUint8Array(metadataHex) : new Uint8Array();
  } catch {
    throw new Error(`Row ${index + 1}: invalid "metadataHash"`);
  }

  return { id, subject, issuer, credential_type, metadata_hash, revoked, expires_at };
}

export function parseJSON(content: string): ImportResult {
  const errors: string[] = [];
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    return { credentials: [], errors: ['Invalid JSON: could not parse file'] };
  }

  if (!Array.isArray(parsed)) {
    return { credentials: [], errors: ['Invalid JSON: expected an array of credentials'] };
  }

  const credentials: Credential[] = [];
  for (let i = 0; i < parsed.length; i++) {
    try {
      credentials.push(parseCredentialFromObject(parsed[i] as Record<string, unknown>, i));
    } catch (e) {
      errors.push((e as Error).message);
    }
  }

  return { credentials, errors };
}

export function parseCSV(content: string): ImportResult {
  const errors: string[] = [];
  const lines = content.trim().split('\n');

  if (lines.length < 2) {
    return { credentials: [], errors: ['CSV file must have a header row and at least one data row'] };
  }

  const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim().toLowerCase());
  const credentials: Credential[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.replace(/^"|"$/g, '').trim());
    const row: Record<string, unknown> = {};
    headers.forEach((h, idx) => { row[h] = values[idx] ?? ''; });

    // Map CSV column names to object keys
    const mapped: Record<string, unknown> = {
      id: row['id'],
      subject: row['subject'],
      issuer: row['issuer'],
      credential_type: row['credential_type'] ?? row['type'],
      metadataHash: row['metadata hash'] ?? row['metadatahash'] ?? row['metadata_hash'],
      revoked: row['revoked'],
      expiresAt: row['expires at'] ?? row['expiresat'] ?? row['expires_at'],
    };

    try {
      credentials.push(parseCredentialFromObject(mapped, i - 1));
    } catch (e) {
      errors.push((e as Error).message);
    }
  }

  return { credentials, errors };
}

export function parseImportFile(content: string, format: 'json' | 'csv'): ImportResult {
  return format === 'json' ? parseJSON(content) : parseCSV(content);
}
