import { describe, it, expect } from 'vitest';
import { filterAndSortCards } from '../lib/credentialUtils';
import type { CredCardData } from '../lib/credentialUtils';
import type { SearchFilters } from '../components/CredentialSearchFilter';
import type { Credential } from '../lib/contracts/quorumProof';

function makeCard(overrides: Partial<Credential> & { attested?: boolean; expired?: boolean }): CredCardData {
  const { attested = false, expired = false, ...credOverrides } = overrides;
  return {
    credential: {
      id: BigInt(1),
      subject: 'GSUBJECT000000000000000000000000000000000000000000000000',
      issuer: 'GISSUER0000000000000000000000000000000000000000000000000',
      credential_type: 1,
      metadata_hash: new Uint8Array(),
      revoked: false,
      expires_at: null,
      ...credOverrides,
    },
    attested,
    expired,
    slice: null,
    sliceError: false,
    credError: null,
  };
}

const BASE_FILTERS: SearchFilters = {
  query: '',
  status: 'all',
  sortField: 'issued',
  sortOrder: 'desc',
};

describe('filterAndSortCards', () => {
  describe('search query', () => {
    it('matches by issuer address substring', () => {
      const cards = [
        makeCard({ id: BigInt(1), issuer: 'GABC123' }),
        makeCard({ id: BigInt(2), issuer: 'GXYZ999' }),
      ];
      const result = filterAndSortCards(cards, { ...BASE_FILTERS, query: 'abc' });
      expect(result).toHaveLength(1);
      expect(result[0].credential.issuer).toBe('GABC123');
    });

    it('matches by subject address substring', () => {
      const cards = [
        makeCard({ id: BigInt(1), subject: 'GHOLDER_ALICE' }),
        makeCard({ id: BigInt(2), subject: 'GHOLDER_BOB' }),
      ];
      const result = filterAndSortCards(cards, { ...BASE_FILTERS, query: 'alice' });
      expect(result).toHaveLength(1);
    });

    it('matches by credential type label', () => {
      const cards = [
        makeCard({ id: BigInt(1), credential_type: 1 }), // 🎓 Degree
        makeCard({ id: BigInt(2), credential_type: 2 }), // 🏛️ License
      ];
      const result = filterAndSortCards(cards, { ...BASE_FILTERS, query: 'degree' });
      expect(result).toHaveLength(1);
      expect(result[0].credential.credential_type).toBe(1);
    });

    it('returns all cards when query is empty', () => {
      const cards = [makeCard({ id: BigInt(1) }), makeCard({ id: BigInt(2) })];
      expect(filterAndSortCards(cards, BASE_FILTERS)).toHaveLength(2);
    });
  });

  describe('credential type filter', () => {
    it('filters to matching type only', () => {
      const cards = [
        makeCard({ id: BigInt(1), credential_type: 1 }),
        makeCard({ id: BigInt(2), credential_type: 2 }),
        makeCard({ id: BigInt(3), credential_type: 1 }),
      ];
      const result = filterAndSortCards(cards, { ...BASE_FILTERS, credentialType: 1 });
      expect(result).toHaveLength(2);
      result.forEach((c) => expect(c.credential.credential_type).toBe(1));
    });

    it('returns all when credentialType is undefined', () => {
      const cards = [makeCard({ credential_type: 1 }), makeCard({ credential_type: 3 })];
      expect(filterAndSortCards(cards, BASE_FILTERS)).toHaveLength(2);
    });
  });

  describe('status filter', () => {
    it('filters active (attested + pending)', () => {
      const cards = [
        makeCard({ id: BigInt(1), attested: true }),
        makeCard({ id: BigInt(2), attested: false }),
        makeCard({ id: BigInt(3), revoked: true }),
        makeCard({ id: BigInt(4), expired: true }),
      ];
      const result = filterAndSortCards(cards, { ...BASE_FILTERS, status: 'active' });
      expect(result).toHaveLength(2);
    });

    it('filters expired only', () => {
      const cards = [
        makeCard({ id: BigInt(1), expired: true }),
        makeCard({ id: BigInt(2), attested: true }),
      ];
      const result = filterAndSortCards(cards, { ...BASE_FILTERS, status: 'expired' });
      expect(result).toHaveLength(1);
      expect(result[0].expired).toBe(true);
    });

    it('filters revoked only', () => {
      const cards = [
        makeCard({ id: BigInt(1), revoked: true }),
        makeCard({ id: BigInt(2) }),
      ];
      const result = filterAndSortCards(cards, { ...BASE_FILTERS, status: 'revoked' });
      expect(result).toHaveLength(1);
      expect(result[0].credential.revoked).toBe(true);
    });

    it('returns all when status is "all"', () => {
      const cards = [
        makeCard({ id: BigInt(1), revoked: true }),
        makeCard({ id: BigInt(2), expired: true }),
        makeCard({ id: BigInt(3), attested: true }),
      ];
      expect(filterAndSortCards(cards, BASE_FILTERS)).toHaveLength(3);
    });
  });

  describe('sort options', () => {
    it('sorts by id (issued) descending by default', () => {
      const cards = [
        makeCard({ id: BigInt(1) }),
        makeCard({ id: BigInt(3) }),
        makeCard({ id: BigInt(2) }),
      ];
      const result = filterAndSortCards(cards, BASE_FILTERS);
      expect(result.map((c) => Number(c.credential.id))).toEqual([3, 2, 1]);
    });

    it('sorts by id (issued) ascending', () => {
      const cards = [
        makeCard({ id: BigInt(3) }),
        makeCard({ id: BigInt(1) }),
        makeCard({ id: BigInt(2) }),
      ];
      const result = filterAndSortCards(cards, { ...BASE_FILTERS, sortOrder: 'asc' });
      expect(result.map((c) => Number(c.credential.id))).toEqual([1, 2, 3]);
    });

    it('sorts by expiry date ascending', () => {
      const cards = [
        makeCard({ id: BigInt(1), expires_at: BigInt(300) }),
        makeCard({ id: BigInt(2), expires_at: BigInt(100) }),
        makeCard({ id: BigInt(3), expires_at: BigInt(200) }),
      ];
      const result = filterAndSortCards(cards, { ...BASE_FILTERS, sortField: 'expiry', sortOrder: 'asc' });
      expect(result.map((c) => Number(c.credential.expires_at))).toEqual([100, 200, 300]);
    });

    it('sorts by expiry date descending', () => {
      const cards = [
        makeCard({ id: BigInt(1), expires_at: BigInt(100) }),
        makeCard({ id: BigInt(2), expires_at: BigInt(300) }),
      ];
      const result = filterAndSortCards(cards, { ...BASE_FILTERS, sortField: 'expiry', sortOrder: 'desc' });
      expect(result.map((c) => Number(c.credential.expires_at))).toEqual([300, 100]);
    });

    it('sorts by issuer alphabetically ascending', () => {
      const cards = [
        makeCard({ id: BigInt(1), issuer: 'GC' }),
        makeCard({ id: BigInt(2), issuer: 'GA' }),
        makeCard({ id: BigInt(3), issuer: 'GB' }),
      ];
      const result = filterAndSortCards(cards, { ...BASE_FILTERS, sortField: 'issuer', sortOrder: 'asc' });
      expect(result.map((c) => c.credential.issuer)).toEqual(['GA', 'GB', 'GC']);
    });

    it('sorts by issuer alphabetically descending', () => {
      const cards = [
        makeCard({ id: BigInt(1), issuer: 'GA' }),
        makeCard({ id: BigInt(2), issuer: 'GC' }),
      ];
      const result = filterAndSortCards(cards, { ...BASE_FILTERS, sortField: 'issuer', sortOrder: 'desc' });
      expect(result.map((c) => c.credential.issuer)).toEqual(['GC', 'GA']);
    });
  });

  describe('combined filters', () => {
    it('applies query + status + type together', () => {
      const cards = [
        makeCard({ id: BigInt(1), credential_type: 1, issuer: 'GABC', attested: true }),
        makeCard({ id: BigInt(2), credential_type: 2, issuer: 'GABC', attested: true }),
        makeCard({ id: BigInt(3), credential_type: 1, issuer: 'GXYZ', attested: true }),
        makeCard({ id: BigInt(4), credential_type: 1, issuer: 'GABC', revoked: true }),
      ];
      const result = filterAndSortCards(cards, {
        query: 'abc',
        credentialType: 1,
        status: 'active',
        sortField: 'issued',
        sortOrder: 'asc',
      });
      expect(result).toHaveLength(1);
      expect(result[0].credential.id).toBe(BigInt(1));
    });
  });
});
