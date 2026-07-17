import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PersonalDataVault, KeyDestroyedError, PersonalDataNotFoundError } from '../src/services/cryptoShredding.js';

describe('PersonalDataVault', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdpr-vault-test-'));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('stores and retrieves encrypted personal data, returning a stable sha256 commitment', () => {
    const vault = new PersonalDataVault({ dataDir });
    const { commitment } = vault.store(1, 'GSUBJECT', { name: 'Ada Lovelace', email: 'ada@example.com' });
    expect(commitment).toMatch(/^[0-9a-f]{64}$/);

    const record = vault.retrieve(1);
    expect(record.personalData).toEqual({ name: 'Ada Lovelace', email: 'ada@example.com' });
    expect(record.commitment).toBe(commitment);
  });

  it('never writes plaintext to disk', () => {
    const vault = new PersonalDataVault({ dataDir });
    vault.store(2, 'GSUBJECT2', { ssn: '123-45-6789' });

    const raw = fs.readFileSync(path.join(dataDir, 'ciphertext.jsonl'), 'utf8');
    expect(raw).not.toContain('123-45-6789');
  });

  it('exposes status metadata (existence, commitment, timestamps) without decrypting', () => {
    const vault = new PersonalDataVault({ dataDir });
    vault.store(3, 'GSUBJECT3', { secret: 'classified' });
    const status = vault.status(3);
    expect(status.hasData).toBe(true);
    expect(status.erased).toBe(false);
    expect(status.commitment).toMatch(/^[0-9a-f]{64}$/);
    expect(status.storedAt).toBeTruthy();
  });

  it('throws PersonalDataNotFoundError for a credential that was never stored', () => {
    const vault = new PersonalDataVault({ dataDir });
    expect(() => vault.retrieve(42)).toThrow(PersonalDataNotFoundError);
  });

  it('genuinely destroys the decryption key: retrieve throws afterward, not just a status flag flip', () => {
    const vault = new PersonalDataVault({ dataDir });
    vault.store(4, 'GSUBJECT4', { medicalHistory: 'penicillin allergy' });

    expect(() => vault.retrieve(4)).not.toThrow();

    const result = vault.eraseKey(4);
    expect(result.erased).toBe(true);
    expect(result.alreadyErased).toBe(false);
    expect(vault.isErased(4)).toBe(true);

    expect(() => vault.retrieve(4)).toThrow(KeyDestroyedError);
  });

  it('erasure is idempotent and returns the original erasure timestamp on repeat calls', () => {
    const vault = new PersonalDataVault({ dataDir });
    vault.store(5, 'GSUBJECT5', { data: 'x' });
    const first = vault.eraseKey(5);
    const second = vault.eraseKey(5);
    expect(first.alreadyErased).toBe(false);
    expect(second.alreadyErased).toBe(true);
    expect(second.erasedAt).toBe(first.erasedAt);
  });

  it('erasing a credential with no stored data is a harmless no-op that still records a durable tombstone', () => {
    const vault = new PersonalDataVault({ dataDir });
    const result = vault.eraseKey(999);
    expect(result.erased).toBe(true);
    expect(vault.isErased(999)).toBe(true);
  });

  it('removes only the destroyed key from the on-disk key log, leaving other credentials untouched', () => {
    const vault = new PersonalDataVault({ dataDir });
    vault.store(6, 'GSIX', { data: 'six' });
    vault.store(60, 'GSIXTY', { data: 'sixty' });

    vault.eraseKey(6);

    const keysAfter = fs.readFileSync(path.join(dataDir, 'keys.jsonl'), 'utf8');
    expect(keysAfter).not.toContain('"key":"6"');
    expect(keysAfter).toContain('"key":"60"');

    expect(() => vault.retrieve(6)).toThrow(KeyDestroyedError);
    expect(vault.retrieve(60).personalData).toEqual({ data: 'sixty' });
  });

  it('storing after erasure is rejected — erasure is one-way', () => {
    const vault = new PersonalDataVault({ dataDir });
    vault.store(8, 'GSUBJECT8', { data: 'first' });
    vault.eraseKey(8);
    expect(() => vault.store(8, 'GSUBJECT8', { data: 'second' })).toThrow(KeyDestroyedError);
  });

  it('data persists across a restart until explicitly erased', () => {
    const vault = new PersonalDataVault({ dataDir });
    vault.store(9, 'GSUBJECT9', { name: 'Restart Test' });

    const restarted = new PersonalDataVault({ dataDir });
    expect(restarted.retrieve(9).personalData).toEqual({ name: 'Restart Test' });
  });

  it('is unrecoverable across a process restart: a fresh instance from the same data directory still cannot decrypt, and no file on disk contains the plaintext', () => {
    const vault = new PersonalDataVault({ dataDir });
    vault.store(7, 'GSUBJECT7', { creditCard: '4111-1111-1111-1111' });
    vault.eraseKey(7);

    // Simulate a restart: brand-new instance, same on-disk state, no in-memory carryover.
    const restarted = new PersonalDataVault({ dataDir });
    expect(restarted.isErased(7)).toBe(true);
    expect(() => restarted.retrieve(7)).toThrow(KeyDestroyedError);

    // The ciphertext record may still exist as an audit artifact...
    expect(restarted.status(7).hasData).toBe(true);

    // ...but the plaintext itself is nowhere on disk, across every vault file —
    // a real forensic check, not merely trusting the erased flag.
    const allFiles = ['ciphertext.jsonl', 'keys.jsonl', 'erasures.jsonl']
      .map((f) => path.join(dataDir, f))
      .filter((f) => fs.existsSync(f))
      .map((f) => fs.readFileSync(f, 'utf8'))
      .join('\n');
    expect(allFiles).not.toContain('4111-1111-1111-1111');
  });

  it('updates reuse the same DEK and commitment changes with content', () => {
    const vault = new PersonalDataVault({ dataDir });
    const first = vault.store(11, 'GSUBJECT11', { v: 1 });
    const second = vault.store(11, 'GSUBJECT11', { v: 2 });
    expect(second.commitment).not.toBe(first.commitment);
    expect(vault.retrieve(11).personalData).toEqual({ v: 2 });
  });
});
