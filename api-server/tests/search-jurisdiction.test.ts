import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createCredentialsRouter } from '../src/routes/credentials.js';
import { SearchIndex, jurisdictionAncestors, jurisdictionOf, normalizeJurisdiction } from '../src/searchIndex.js';

const cred = (id: number, overrides = {}) => ({
  id: BigInt(id),
  subject: 'GSUBJECT',
  issuer: 'GISSUER',
  issuer_type: 'bank',
  credential_type: 1,
  metadata_hash: 'hash',
  metadata: { name: 'Test Credential' },
  revoked: false,
  suspended: false,
  attestation_count: 0,
  expires_at: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  version: 1,
  ...overrides,
});

/** For direct SearchIndex unit tests (no HTTP layer / serializeBigInt), ids must be strings. */
const idxCred = (id: number, overrides = {}) => ({
  ...cred(id, overrides),
  id: String(id),
});

const createTestApp = () => {
  const mockSimulateCall = vi.fn();
  const mockSoroban = {
    simulateCall: mockSimulateCall,
    u64Val: (n: number | bigint) => n as any,
    u32Val: (n: number) => n as any,
    addressVal: (a: string) => a as any,
  };

  const app = express();
  app.use(express.json());
  app.use('/api/credentials', createCredentialsRouter(mockSoroban));

  return { app, mockSimulateCall, mockSoroban };
};

describe('jurisdictionAncestors / jurisdictionOf / normalizeJurisdiction', () => {
  it('normalizes case and whitespace', () => {
    expect(normalizeJurisdiction(' us ')).toBe('US');
  });

  it('a country code has no country ancestor', () => {
    expect(jurisdictionAncestors('DE')).toEqual(['DE', 'EU']);
  });

  it('a subdivision code has its country as an ancestor', () => {
    expect(jurisdictionAncestors('US-CA')).toEqual(['US-CA', 'US']);
  });

  it('a subdivision of an EU member includes the EU group', () => {
    expect(jurisdictionAncestors('FR-75')).toEqual(['FR-75', 'FR', 'EU']);
  });

  it('a non-EU country has no supranational group', () => {
    expect(jurisdictionAncestors('US')).toEqual(['US']);
  });

  it('jurisdictionOf prefers the top-level field over metadata', () => {
    expect(jurisdictionOf({ jurisdiction: 'us', metadata: { jurisdiction: 'de' } } as any)).toBe('US');
  });

  it('jurisdictionOf falls back to metadata.jurisdiction', () => {
    expect(jurisdictionOf({ metadata: { jurisdiction: 'jp' } } as any)).toBe('JP');
  });

  it('jurisdictionOf returns undefined when absent', () => {
    expect(jurisdictionOf({ metadata: {} } as any)).toBeUndefined();
  });
});

describe('SearchIndex jurisdiction filtering (unit)', () => {
  it('a country-level filter matches its subdivisions', () => {
    const index = new SearchIndex();
    index.indexCredentials([
      idxCred(1, { jurisdiction: 'US' }),
      idxCred(2, { jurisdiction: 'US-CA' }),
      idxCred(3, { jurisdiction: 'DE' }),
    ] as any);

    const result = index.search({ jurisdiction: 'US' });
    expect(result.data.map(c => c.id).sort()).toEqual(['1', '2']);
  });

  it('a supranational group filter matches all member countries', () => {
    const index = new SearchIndex();
    index.indexCredentials([
      idxCred(1, { jurisdiction: 'DE' }),
      idxCred(2, { jurisdiction: 'FR-75' }),
      idxCred(3, { jurisdiction: 'US' }),
    ] as any);

    const result = index.search({ jurisdiction: 'EU' });
    expect(result.data.map(c => c.id).sort()).toEqual(['1', '2']);
  });

  it('an exact subdivision filter does not match sibling subdivisions', () => {
    const index = new SearchIndex();
    index.indexCredentials([
      idxCred(1, { jurisdiction: 'US-CA' }),
      idxCred(2, { jurisdiction: 'US-NY' }),
    ] as any);

    const result = index.search({ jurisdiction: 'US-CA' });
    expect(result.data.map(c => c.id)).toEqual(['1']);
  });

  it('supports multiple requested jurisdictions (OR semantics)', () => {
    const index = new SearchIndex();
    index.indexCredentials([
      idxCred(1, { jurisdiction: 'US' }),
      idxCred(2, { jurisdiction: 'DE' }),
      idxCred(3, { jurisdiction: 'JP' }),
    ] as any);

    const result = index.search({ jurisdiction: ['US', 'JP'] });
    expect(result.data.map(c => c.id).sort()).toEqual(['1', '3']);
  });

  it('reads jurisdiction from metadata.jurisdiction when no top-level field is set', () => {
    const index = new SearchIndex();
    index.indexCredentials([
      idxCred(1, { metadata: { jurisdiction: 'sg' } }),
      idxCred(2, { metadata: { jurisdiction: 'br' } }),
    ] as any);

    const result = index.search({ jurisdiction: 'SG' });
    expect(result.data.map(c => c.id)).toEqual(['1']);
  });

  it('excludes credentials with no jurisdiction when a jurisdiction filter is applied', () => {
    const index = new SearchIndex();
    index.indexCredentials([idxCred(1, { jurisdiction: 'US' }), idxCred(2)] as any);

    const result = index.search({ jurisdiction: 'US' });
    expect(result.data.map(c => c.id)).toEqual(['1']);
  });

  it('reindexing a single credential keeps the jurisdiction index consistent', () => {
    const index = new SearchIndex();
    index.indexCredential(idxCred(1, { jurisdiction: 'US-CA' }) as any);
    expect(index.search({ jurisdiction: 'US' }).data).toHaveLength(1);

    index.indexCredential(idxCred(1, { jurisdiction: 'DE' }) as any);
    expect(index.search({ jurisdiction: 'US' }).data).toHaveLength(0);
    expect(index.search({ jurisdiction: 'EU' }).data).toHaveLength(1);
  });

  it('removeCredential cleans up the jurisdiction index', () => {
    const index = new SearchIndex();
    index.indexCredential(idxCred(1, { jurisdiction: 'US' }) as any);
    index.removeCredential('1');
    expect(index.search({ jurisdiction: 'US' }).data).toHaveLength(0);
  });

  it('produces a jurisdiction facet keyed by raw value, not ancestors', () => {
    const index = new SearchIndex();
    index.indexCredentials([
      idxCred(1, { jurisdiction: 'US-CA' }),
      idxCred(2, { jurisdiction: 'US-CA' }),
      idxCred(3, { jurisdiction: 'US-NY' }),
    ] as any);

    const result = index.search({ facets: ['jurisdiction'] });
    const facet = result.facets.find(f => f.name === 'jurisdiction');
    expect(facet?.values).toEqual(
      expect.arrayContaining([
        { value: 'US-CA', count: 2 },
        { value: 'US-NY', count: 1 },
      ]),
    );
  });

  it('full-text query matches on jurisdiction tokens', () => {
    const index = new SearchIndex();
    index.indexCredentials([
      idxCred(1, { jurisdiction: 'DE', metadata: { name: 'Sample Item' } }),
      idxCred(2, { jurisdiction: 'JP', metadata: { name: 'Sample Item' } }),
    ] as any);

    const result = index.search({ query: 'DE' });
    expect(result.data.map(c => c.id)).toEqual(['1']);
  });
});

describe('GET /api/credentials/search?jurisdiction=', () => {
  let mockSimulateCall: ReturnType<typeof vi.fn>;
  let app: express.Application;

  beforeEach(() => {
    const testSetup = createTestApp();
    app = testSetup.app;
    mockSimulateCall = testSetup.mockSimulateCall;
  });

  it('filters by jurisdiction', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(2n)
      .mockResolvedValueOnce(cred(1, { jurisdiction: 'US' }))
      .mockResolvedValueOnce(cred(2, { jurisdiction: 'DE' }));

    const res = await request(app).get('/api/credentials/search?jurisdiction=US');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].jurisdiction).toBe('US');
  });

  it('filters by multiple jurisdictions', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(3n)
      .mockResolvedValueOnce(cred(1, { jurisdiction: 'US' }))
      .mockResolvedValueOnce(cred(2, { jurisdiction: 'DE' }))
      .mockResolvedValueOnce(cred(3, { jurisdiction: 'JP' }));

    const res = await request(app).get('/api/credentials/search?jurisdiction=US&jurisdiction=JP');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.map((c: any) => c.jurisdiction).sort()).toEqual(['JP', 'US']);
  });

  it('a country filter matches subdivisions via the HTTP layer', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(2n)
      .mockResolvedValueOnce(cred(1, { jurisdiction: 'US-CA' }))
      .mockResolvedValueOnce(cred(2, { jurisdiction: 'DE' }));

    const res = await request(app).get('/api/credentials/search?jurisdiction=US');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].jurisdiction).toBe('US-CA');
  });

  it('echoes jurisdiction in query_info.active_filters', async () => {
    mockSimulateCall.mockResolvedValueOnce(1n).mockResolvedValueOnce(cred(1, { jurisdiction: 'US' }));

    const res = await request(app).get('/api/credentials/search?jurisdiction=US');
    expect(res.body.query_info.active_filters.jurisdiction).toBe('US');
  });

  it('includes jurisdiction in the default facets', async () => {
    mockSimulateCall
      .mockResolvedValueOnce(2n)
      .mockResolvedValueOnce(cred(1, { jurisdiction: 'US' }))
      .mockResolvedValueOnce(cred(2, { jurisdiction: 'DE' }));

    const res = await request(app).get('/api/credentials/search');
    const facetNames = res.body.facets.map((f: any) => f.name);
    expect(facetNames).toContain('jurisdiction');
  });
});
