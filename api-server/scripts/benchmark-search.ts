/**
 * Throwaway benchmark: indexes ~1,000,000 synthetic credentials across
 * multiple issuers/jurisdictions and measures REAL p50/p95/p99 latency for
 * 5 representative multi-field queries against SearchIndex.search().
 *
 * Run with: npx tsx scripts/benchmark-search.ts
 */
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import { SearchIndex, type CredentialRecord, type SearchOptions } from '../src/searchIndex.js';
import { SearchIndexStore } from '../src/services/searchIndexStore.js';

const TOTAL = 1_000_000;
const ISSUERS = Array.from({ length: 50 }, (_, i) => `GISSUER${i.toString().padStart(3, '0')}`);
const ISSUER_TYPES = ['bank', 'government', 'private'];
const JURISDICTIONS = ['US', 'UK', 'DE', 'FR', 'JP', 'CA', 'AU', 'SG', 'BR', 'IN'];
const CRED_TYPES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const WORDS = ['Engineering', 'License', 'Certification', 'Degree', 'Mechanical', 'Civil', 'Electrical', 'Software'];

function genCredential(i: number): CredentialRecord {
  const issuer = ISSUERS[i % ISSUERS.length];
  const issuerType = ISSUER_TYPES[i % ISSUER_TYPES.length];
  const jurisdiction = JURISDICTIONS[i % JURISDICTIONS.length];
  const credType = CRED_TYPES[i % CRED_TYPES.length];
  const dayOffset = i % 1000;
  const created = new Date(Date.UTC(2023, 0, 1) + dayOffset * 86400000).toISOString();
  return {
    id: String(i + 1),
    subject: `GSUBJECT${i.toString().padStart(7, '0')}`,
    issuer,
    issuer_type: issuerType,
    credential_type: credType,
    metadata_hash: `hash${i}`,
    metadata: {
      name: `${WORDS[i % WORDS.length]} ${WORDS[(i + 3) % WORDS.length]}`,
      jurisdiction,
    },
    revoked: i % 17 === 0,
    suspended: i % 29 === 0,
    attestation_count: i % 25,
    expires_at: null,
    created_at: created,
    updated_at: created,
    version: 1 + (i % 3),
  };
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function timeQuery(index: SearchIndex, options: SearchOptions, iterations: number): { p50: number; p95: number; p99: number; max: number } {
  const timings: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    index.search(options);
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  return {
    p50: percentile(timings, 50),
    p95: percentile(timings, 95),
    p99: percentile(timings, 99),
    max: timings[timings.length - 1],
  };
}

async function main() {
  console.log(`Generating and indexing ${TOTAL.toLocaleString()} synthetic credentials...`);
  const index = new SearchIndex();
  const buildStart = performance.now();
  const batch: CredentialRecord[] = new Array(TOTAL);
  for (let i = 0; i < TOTAL; i++) batch[i] = genCredential(i);
  index.indexCredentials(batch);
  const buildMs = performance.now() - buildStart;
  console.log(`Indexed ${index.getIndexSize().toLocaleString()} credentials, vocabulary size ${index.getVocabularySize().toLocaleString()}, in ${buildMs.toFixed(0)}ms\n`);

  const queries: Array<{ name: string; options: SearchOptions }> = [
    {
      name: 'issuer + status=active + full-text query',
      options: { issuer: ISSUERS[3], status: 'active', query: 'Engineering License', limit: 20 },
    },
    {
      name: 'issuer_type=bank + attestation_count>=5, sort_by=reputation',
      options: { issuer_type: 'bank', attestation_count_min: 5, sort_by: 'reputation', limit: 20 },
    },
    {
      name: 'type filter + created_after, sort_by=recency',
      options: { type: 3, created_after: '2024-01-01T00:00:00Z', sort_by: 'recency', limit: 20 },
    },
    {
      name: 'deduplicate=true + issuer_type=government',
      options: { deduplicate: true, issuer_type: 'government', limit: 20 },
    },
    {
      name: 'status=active + default facets (broad query)',
      options: { status: 'active', limit: 20 },
    },
  ];

  console.log('Query latency (ms), 200 iterations each:\n');
  for (const q of queries) {
    const stats = timeQuery(index, q.options, 200);
    console.log(
      `- ${q.name}\n    p50=${stats.p50.toFixed(2)}ms  p95=${stats.p95.toFixed(2)}ms  p99=${stats.p99.toFixed(2)}ms  max=${stats.max.toFixed(2)}ms`,
    );
  }

  // Restart-without-chain-hit persistence check.
  console.log('\nPersistence check (DurableLog-backed SearchIndexStore):');
  const dataDir = path.join(os.tmpdir(), 'quorumproof-search-bench', randomUUID());
  const store1 = new SearchIndexStore(dataDir);
  const sample = batch.slice(0, 5000);
  const writeStart = performance.now();
  for (const cred of sample) store1.set(cred);
  console.log(`  wrote ${sample.length.toLocaleString()} records to DurableLog in ${(performance.now() - writeStart).toFixed(0)}ms`);

  const store2 = new SearchIndexStore(dataDir); // fresh instance, same dir — simulates a process restart
  const rehydrateStart = performance.now();
  const reloaded = store2.all();
  const rehydrateMs = performance.now() - rehydrateStart;
  const freshIndex = new SearchIndex();
  freshIndex.indexCredentials(reloaded);
  console.log(
    `  fresh instance pointed at same dir recovered ${reloaded.length.toLocaleString()} records in ${rehydrateMs.toFixed(0)}ms, ZERO chain RPC calls (index size after rebuild: ${freshIndex.getIndexSize().toLocaleString()})`,
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
