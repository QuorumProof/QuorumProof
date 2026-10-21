/**
 * Tests for the test data factories (Issue #1677).
 *
 * These guard the factories themselves: if a factory drifts from the contract
 * shapes or stops enforcing its invariants, every test built on it becomes
 * unreliable, so the factories get their own coverage.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { StrKey } from '@stellar/stellar-sdk';
import {
  buildCredential,
  buildCredentials,
  buildSlice,
  buildSlices,
  buildSbt,
  buildSbts,
  stellarAddressFor,
  resetFactorySequences,
  CREDENTIAL_STATUS,
  RENEWAL_STATUS,
  assertSliceInvariants,
} from './factories/index.js';

beforeEach(() => {
  resetFactorySequences();
});

describe('stellar address helper', () => {
  it('produces valid ed25519 public keys', () => {
    for (let i = 1; i <= 5; i++) {
      expect(StrKey.isValidEd25519PublicKey(stellarAddressFor(i))).toBe(true);
    }
  });

  it('is deterministic and unique per index', () => {
    expect(stellarAddressFor(7)).toBe(stellarAddressFor(7));
    expect(stellarAddressFor(7)).not.toBe(stellarAddressFor(8));
  });
});

describe('credential factory', () => {
  it('builds a credential matching the contract shape with safe defaults', () => {
    const c = buildCredential();
    expect(c.id).toBe(1);
    expect(StrKey.isValidEd25519PublicKey(c.subject)).toBe(true);
    expect(StrKey.isValidEd25519PublicKey(c.issuer)).toBe(true);
    expect(c.subject).not.toBe(c.issuer);
    expect(c.revoked).toBe(false);
    expect(c.suspended).toBe(false);
    expect(c.status).toBe(CREDENTIAL_STATUS.Active);
    expect(c.renewal_status).toBe(RENEWAL_STATUS.Active);
    expect(c.expires_at).toBeNull();
    expect(c.metadata_hash).toHaveLength(64);
  });

  it('applies overrides without touching other fields', () => {
    const c = buildCredential({ revoked: true, expires_at: 1_900_000_000 });
    expect(c.revoked).toBe(true);
    expect(c.expires_at).toBe(1_900_000_000);
    expect(c.suspended).toBe(false);
  });

  it('gives each credential in a batch a unique id, subject and metadata hash', () => {
    const batch = buildCredentials(5);
    expect(new Set(batch.map(c => c.id)).size).toBe(5);
    expect(new Set(batch.map(c => c.subject)).size).toBe(5);
    expect(new Set(batch.map(c => c.metadata_hash)).size).toBe(5);
  });

  it('rejects invariant-breaking overrides', () => {
    expect(() => buildCredential({ required_attestations: 0 })).toThrow(/required_attestations/);
    expect(() => buildCredential({ version: 0 })).toThrow(/version/);
  });
});

describe('slice factory', () => {
  it('defaults to a 2-of-3 equal-weight quorum that satisfies its invariants', () => {
    const s = buildSlice();
    expect(s.attestors).toHaveLength(3);
    expect(s.weights).toEqual([1, 1, 1]);
    expect(s.threshold).toBe(2);
    expect(() => assertSliceInvariants(s)).not.toThrow();
    s.attestors.forEach(a => expect(StrKey.isValidEd25519PublicKey(a)).toBe(true));
  });

  it('defaults weights to one per supplied attestor', () => {
    const attestors = buildSlice().attestors.slice(0, 2);
    const s = buildSlice({ attestors, threshold: 1 });
    expect(s.weights).toEqual([1, 1]);
  });

  it('rejects a threshold above total weight', () => {
    expect(() => buildSlice({ threshold: 99 })).toThrow(/threshold 99/);
  });

  it('rejects mismatched weights and attestors', () => {
    const attestors = buildSlice().attestors;
    expect(() => buildSlice({ attestors, weights: [1, 1] })).toThrow(/must match attestors/);
  });

  it('rejects an empty attestor list and negative weights', () => {
    expect(() => buildSlice({ attestors: [], weights: [] })).toThrow(/at least one attestor/);
    const attestors = buildSlice().attestors;
    expect(() => buildSlice({ attestors, weights: [1, -1, 1] })).toThrow(/non-negative/);
  });

  it('gives each slice in a batch its own id and creator', () => {
    const batch = buildSlices(4);
    expect(new Set(batch.map(s => s.id)).size).toBe(4);
    expect(new Set(batch.map(s => s.creator)).size).toBe(4);
  });
});

describe('sbt factory', () => {
  it('builds an SBT with version 1, no upgrade and no co-owner by default', () => {
    const t = buildSbt();
    expect(t.version).toBe(1);
    expect(t.upgraded_to).toBeNull();
    expect(t.co_owner).toBeNull();
    expect(t.metadata_uri).toMatch(/^ipfs:\/\//);
    expect(StrKey.isValidEd25519PublicKey(t.owner)).toBe(true);
  });

  it('supports a jointly owned SBT with a distinct co-owner', () => {
    const t = buildSbt();
    const co = buildSbt().owner;
    const joint = buildSbt({ owner: t.owner, co_owner: co });
    expect(joint.co_owner).toBe(co);
    expect(() => buildSbt({ owner: t.owner, co_owner: t.owner })).toThrow(/co_owner/);
  });

  it('rejects an SBT upgraded to itself and a version below 1', () => {
    expect(() => buildSbt({ id: 42, upgraded_to: 42 })).toThrow(/itself/);
    expect(() => buildSbt({ version: 0 })).toThrow(/version/);
  });

  it('gives each SBT in a batch a unique id and owner', () => {
    const batch = buildSbts(3);
    expect(new Set(batch.map(t => t.id)).size).toBe(3);
    expect(new Set(batch.map(t => t.owner)).size).toBe(3);
  });
});

describe('resetFactorySequences', () => {
  it('makes id sequences start over so tests are reproducible', () => {
    const first = buildCredential();
    resetFactorySequences();
    const again = buildCredential();
    expect(again.id).toBe(first.id);
    expect(again.subject).toBe(first.subject);
  });
});
