/**
 * sliceBackup.ts — issue #469
 * Encrypted backup and recovery for quorum slice configurations.
 * Uses Web Crypto AES-GCM with a password-derived key (PBKDF2).
 */

export interface SliceBackupData {
  version: 1;
  creator: string;
  attestors: Array<{ address: string; role: string }>;
  threshold: number;
  createdAt: string;
}

const SALT_LEN = 16;
const IV_LEN = 12;
const ITERATIONS = 100_000;

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt slice data with a password. Returns a base64-encoded blob. */
export async function encryptBackup(data: SliceBackupData, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveKey(password, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  // Pack: salt (16) + iv (12) + ciphertext
  const packed = new Uint8Array(SALT_LEN + IV_LEN + ciphertext.byteLength);
  packed.set(salt, 0);
  packed.set(iv, SALT_LEN);
  packed.set(new Uint8Array(ciphertext), SALT_LEN + IV_LEN);
  return btoa(String.fromCharCode(...packed));
}

/** Decrypt a base64-encoded backup blob. Throws on wrong password or corrupt data. */
export async function decryptBackup(blob: string, password: string): Promise<SliceBackupData> {
  const packed = Uint8Array.from(atob(blob), (c) => c.charCodeAt(0));
  const salt = packed.slice(0, SALT_LEN);
  const iv = packed.slice(SALT_LEN, SALT_LEN + IV_LEN);
  const ciphertext = packed.slice(SALT_LEN + IV_LEN);
  const key = await deriveKey(password, salt);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  } catch {
    throw new Error('Decryption failed — wrong password or corrupt backup.');
  }
  return JSON.parse(new TextDecoder().decode(plaintext)) as SliceBackupData;
}

/** Trigger a file download of the encrypted backup. */
export function downloadBackupFile(blob: string, filename = 'quorum-slice-backup.qpb'): void {
  const a = document.createElement('a');
  a.href = `data:application/octet-stream;base64,${blob}`;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
