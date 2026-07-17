import path from 'path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { DurableLog } from './durableLog.js';

/**
 * Crypto-shredding personal data store.
 *
 * Personal data is never held in plaintext at rest. Each credential's
 * personal data is encrypted with its own randomly generated AES-256-GCM
 * data encryption key (DEK) the first time it is stored. The ciphertext is
 * durable and long-lived; the DEK lives in a separate durable log.
 *
 * "Erasure" (GDPR Art. 17) is implemented as destruction of the DEK via
 * DurableLog#shred — an irreversible operation that zero-overwrites the
 * on-disk key material before recompacting. Once a key is destroyed, the
 * corresponding ciphertext is permanently unrecoverable by anyone, including
 * the operator: there is no code path, backup key, or master secret that can
 * reconstruct a destroyed DEK.
 *
 * See docs/crypto-shredding-architecture.md for the full spec, including a
 * precise statement of what remains verifiable post-erasure (existence,
 * timestamps, the sha256 commitment) versus what becomes permanently
 * inaccessible (the plaintext personal data itself).
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

export class KeyDestroyedError extends Error {
  constructor(credentialId: number) {
    super(`Decryption key for credential ${credentialId} has been permanently destroyed and cannot be recovered`);
    this.name = 'KeyDestroyedError';
  }
}

export class PersonalDataNotFoundError extends Error {
  constructor(credentialId: number) {
    super(`No personal data record exists for credential ${credentialId}`);
    this.name = 'PersonalDataNotFoundError';
  }
}

interface KeyRecord {
  /** hex-encoded 32-byte AES-256 key */
  dek: string;
  createdAt: string;
}

interface CiphertextRecord {
  subject: string;
  /** hex-encoded */
  iv: string;
  /** hex-encoded */
  authTag: string;
  /** hex-encoded */
  ciphertext: string;
  /** sha256 hex digest of the plaintext — the value anchored on-chain as metadata_hash */
  commitment: string;
  storedAt: string;
  updatedAt: string;
}

interface ErasureRecord {
  erasedAt: string;
}

export interface PersonalDataRecord {
  credentialId: number;
  subject: string;
  personalData: unknown;
  commitment: string;
  storedAt: string;
  updatedAt: string;
}

export interface PersonalDataStatus {
  credentialId: number;
  hasData: boolean;
  subject?: string;
  commitment?: string;
  storedAt?: string;
  updatedAt?: string;
  erased: boolean;
  erasedAt?: string;
}

export interface PersonalDataVaultOptions {
  dataDir?: string;
}

function computeCommitment(plaintext: Buffer): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export class PersonalDataVault {
  private readonly keys: DurableLog<KeyRecord>;
  private readonly ciphertexts: DurableLog<CiphertextRecord>;
  private readonly erasures: DurableLog<ErasureRecord>;

  constructor(options: PersonalDataVaultOptions = {}) {
    const dataDir = options.dataDir ?? process.env.GDPR_VAULT_DATA_DIR ?? path.join(process.cwd(), '.data', 'gdpr-vault');
    this.keys = new DurableLog<KeyRecord>(path.join(dataDir, 'keys.jsonl'));
    this.ciphertexts = new DurableLog<CiphertextRecord>(path.join(dataDir, 'ciphertext.jsonl'));
    this.erasures = new DurableLog<ErasureRecord>(path.join(dataDir, 'erasures.jsonl'));
  }

  private keyOf(credentialId: number): string {
    return String(credentialId);
  }

  isErased(credentialId: number): boolean {
    return this.erasures.has(this.keyOf(credentialId));
  }

  hasData(credentialId: number): boolean {
    return this.ciphertexts.has(this.keyOf(credentialId));
  }

  /**
   * Encrypts and durably stores `personalData` for a credential, generating
   * a fresh DEK on first write and reusing it for subsequent updates to the
   * same credential. Returns the sha256 commitment of the plaintext, which
   * callers should anchor on-chain (e.g. as the credential's metadata_hash)
   * so integrity remains verifiable without exposing content.
   */
  store(credentialId: number, subject: string, personalData: unknown): { commitment: string } {
    if (this.isErased(credentialId)) {
      throw new KeyDestroyedError(credentialId);
    }

    const key = this.keyOf(credentialId);
    const plaintext = Buffer.from(JSON.stringify(personalData), 'utf8');
    const commitment = computeCommitment(plaintext);

    let keyRecord = this.keys.get(key);
    if (!keyRecord) {
      keyRecord = { dek: randomBytes(32).toString('hex'), createdAt: new Date().toISOString() };
      this.keys.set(key, keyRecord);
    }

    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, Buffer.from(keyRecord.dek, 'hex'), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const now = new Date().toISOString();
    const existing = this.ciphertexts.get(key);
    this.ciphertexts.set(key, {
      subject,
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
      ciphertext: ciphertext.toString('hex'),
      commitment,
      storedAt: existing?.storedAt ?? now,
      updatedAt: now,
    });

    return { commitment };
  }

  /** Decrypts and returns the personal data. Throws KeyDestroyedError if the DEK has been erased. */
  retrieve(credentialId: number): PersonalDataRecord {
    const key = this.keyOf(credentialId);
    const record = this.ciphertexts.get(key);
    if (!record) throw new PersonalDataNotFoundError(credentialId);

    const keyRecord = this.keys.get(key);
    if (!keyRecord) throw new KeyDestroyedError(credentialId);

    const decipher = createDecipheriv(ALGORITHM, Buffer.from(keyRecord.dek, 'hex'), Buffer.from(record.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(record.authTag, 'hex'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'hex')), decipher.final()]);

    return {
      credentialId,
      subject: record.subject,
      personalData: JSON.parse(plaintext.toString('utf8')),
      commitment: record.commitment,
      storedAt: record.storedAt,
      updatedAt: record.updatedAt,
    };
  }

  /**
   * Returns metadata about a credential's personal data without decrypting
   * it — what stays verifiable regardless of erasure status: existence,
   * subject, timestamps, and the commitment hash.
   */
  status(credentialId: number): PersonalDataStatus {
    const key = this.keyOf(credentialId);
    const record = this.ciphertexts.get(key);
    const erasureRecord = this.erasures.get(key);
    return {
      credentialId,
      hasData: !!record,
      subject: record?.subject,
      commitment: record?.commitment,
      storedAt: record?.storedAt,
      updatedAt: record?.updatedAt,
      erased: !!erasureRecord,
      erasedAt: erasureRecord?.erasedAt,
    };
  }

  /**
   * Irreversibly destroys the DEK for a credential. Idempotent: erasing an
   * already-erased credential is a no-op that reports `alreadyErased: true`.
   * After this call, `retrieve()` always throws KeyDestroyedError — for this
   * process and for any future process that loads the same data directory,
   * since the destruction is itself durably (and irreversibly) recorded.
   */
  eraseKey(credentialId: number): { erased: boolean; alreadyErased: boolean; erasedAt: string } {
    const key = this.keyOf(credentialId);
    const already = this.erasures.get(key);
    if (already) {
      return { erased: true, alreadyErased: true, erasedAt: already.erasedAt };
    }

    this.keys.shred(key);
    const erasedAt = new Date().toISOString();
    this.erasures.set(key, { erasedAt });

    return { erased: true, alreadyErased: false, erasedAt };
  }
}

let defaultVault: PersonalDataVault | undefined;

/** Lazily-constructed process-wide vault, used by the default GDPR router export. */
export function getDefaultVault(): PersonalDataVault {
  if (!defaultVault) defaultVault = new PersonalDataVault();
  return defaultVault;
}
