import { Router, Request, Response } from 'express';
import type { simulateCall as SimulateCallType } from '../soroban.js';
import { SearchIndex, type SearchOptions, type CredentialRecord as SearchCredentialRecord } from '../searchIndex.js';
import { MetadataHashCache } from '../services/metadataHashCache.js';
import { ShardedCredentialStore } from '../services/shardedStorage.js';
import { SearchIndexStore } from '../services/searchIndexStore.js';
import { SearchRebuildManager } from '../services/searchRebuildManager.js';
import { parseFilterTree } from '../services/searchFilterParser.js';

export type SorobanClient = {
  simulateCall: typeof SimulateCallType;
  u64Val: (n: number | bigint) => ReturnType<typeof SimulateCallType>;
  u32Val: (n: number) => ReturnType<typeof SimulateCallType>;
  addressVal: (a: string) => ReturnType<typeof SimulateCallType>;
};

/** Recursively convert BigInt values to strings for JSON serialization. */
function serializeBigInt(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(serializeBigInt);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, serializeBigInt(v)])
    );
  }
  return value;
}

type CredentialRecord = SearchCredentialRecord;

const VALID_SORT_KEYS = ['id', 'type', 'relevance', 'created_at', 'updated_at', 'recency', 'reputation'];

/**
 * Fields that may be used in credential query filters. Only these are
 * accepted so unknown/injected field names are rejected up front.
 */
const FILTERABLE_FIELDS = [
  'credential_type',
  'type',
  'status',
  'issuer',
  'issuer_type',
  'subject',
  'jurisdiction',
  'attestation_count',
  'created_at',
  'updated_at',
  'expires_at',
] as const;

/** Fields that are indexed for fast server-side filtering. */
const INDEXED_FIELDS = ['credential_type', 'type', 'status', 'issuer', 'issuer_type', 'jurisdiction'] as const;

const VALID_STATUSES = ['active', 'revoked', 'suspended'];

/**
 * A single parsed filter clause, e.g. `credential_type=PE` or `status=active`.
 * `field` is always one of FILTERABLE_FIELDS; `value` is the raw string value.
 */
export type CredentialFilterClause = {
  field: string;
  value: string;
};

/**
 * Parse a filter expression string into validated clauses.
 *
 * Syntax: comma-separated `field=value` pairs, e.g.
 *   credential_type=PE,status=active
 *
 * Throws on unknown fields, malformed clauses, or invalid enum values so the
 * caller can respond with 400 instead of silently ignoring bad input.
 */
export function parseCredentialFilters(raw: string): CredentialFilterClause[] {
  const clauses: CredentialFilterClause[] = [];
  const parts = raw.split(',').map(p => p.trim()).filter(Boolean);
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) {
      throw new Error(`Invalid filter clause: "${part}" (expected field=value)`);
    }
    const field = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!(FILTERABLE_FIELDS as readonly string[]).includes(field)) {
      throw new Error(`Unknown filter field: "${field}"`);
    }
    if (value.length === 0) {
      throw new Error(`Filter field "${field}" requires a value`);
    }
    if (field === 'status' && !VALID_STATUSES.includes(value)) {
      throw new Error(`status must be one of: ${VALID_STATUSES.join(', ')}`);
    }
    clauses.push({ field, value });
  }
  return clauses;
}

/**
 * Build an indexed lookup map for a single indexed field so repeated
 * filtering over the same field is O(1) per lookup instead of a full scan.
 */
function buildFieldIndex(
  records: CredentialRecord[],
  field: string
): Map<string, CredentialRecord[]> {
  const index = new Map<string, CredentialRecord[]>();
  for (const record of records) {
    const raw = (record as Record<string, unknown>)[field];
    if (raw === undefined || raw === null) continue;
    const key = String(raw);
    const bucket = index.get(key);
    if (bucket) bucket.push(record);
    else index.set(key, [record]);
  }
  return index;
}

/**
 * Apply validated filter clauses to a set of credential records.
 *
 * Indexed fields (credential_type, status, ...) are resolved through a
 * prebuilt lookup map; non-indexed fields fall back to a linear scan. All
 * clauses are ANDed together.
 */
export function applyCredentialFilters(
  records: CredentialRecord[],
  clauses: CredentialFilterClause[]
): CredentialRecord[] {
  if (clauses.length === 0) return records;

  const indexes = new Map<string, Map<string, CredentialRecord[]>>();
  for (const clause of clauses) {
    if ((INDEXED_FIELDS as readonly string[]).includes(clause.field) && !indexes.has(clause.field)) {
      indexes.set(clause.field, buildFieldIndex(records, clause.field));
    }
  }

  return records.filter(record =>
    clauses.every(clause => {
      const index = indexes.get(clause.field);
      if (index) {
        const bucket = index.get(clause.value);
        return bucket !== undefined && bucket.includes(record);
      }
      const raw = (record as Record<string, unknown>)[clause.field];
      return raw !== undefined && raw !== null && String(raw) === clause.value;
    })
  );
}

export function createCredentialsRouter(soroban: SorobanClient) {
  const router = Router();
  const store = new SearchIndexStore();
  const metadataHashCache = new MetadataHashCache();
  const shardedStore = new ShardedCredentialStore();
  const rebuildManager = new SearchRebuildManager();
  let indexedCredentials: Set<string> = new Set();
  let indexVersion = 0;

  // The live, queryable index. Rebuilds build a fresh instance off to the
  // side and only swap this reference in once fully built, so `/search`
  // always sees either the old index or the new one, never a partial one.
  let currentIndex = new SearchIndex();

  // Hydrate from local disk (no chain RPC) so a process restart doesn't
  // require re-scanning the chain before search works again.
  {
    const persisted = store.all();
    if (persisted.length > 0) {
      currentIndex.indexCredentials(persisted);
      for (const cred of persisted) indexedCredentials.add(cred.id);
      indexVersion++;
    }
  }

  /**
   * Fetches every credential from the chain (1x get_credential_count + Nx
   * get_credential). Only credentials that are new or changed since the last
   * time they were persisted get written to `store` and re-indexed — repeat
   * polls patch the index incrementally instead of rebuilding it from
   * scratch, and diffing happens against the on-disk store so it's true
   * across process restarts too.
   */
  async function populateIndex(): Promise<void> {
    try {
      const credCount: bigint = await soroban.simulateCall('get_credential_count', []);
      const total = Number(credCount);

      for (let i = 1; i <= total; i++) {
        try {
          const cred = await soroban.simulateCall('get_credential', [soroban.u64Val(i)]);
          const credRecord = serializeBigInt(cred) as CredentialRecord;
          // Ensure id is a string
          credRecord.id = String(credRecord.id || i);

          const existing = store.get(credRecord.id);
          const changed =
            !existing ||
            existing.version !== credRecord.version ||
            existing.metadata_hash !== credRecord.metadata_hash ||
            existing.revoked !== credRecord.revoked ||
            existing.suspended !== credRecord.suspended;

          indexedCredentials.add(credRecord.id);
          metadataHashCache.set(credRecord.id, credRecord.metadata_hash, cred as Record<string, unknown>);
          shardedStore.set(credRecord);

          if (changed) {
            store.set(credRecord);
            currentIndex.indexCredential(credRecord);
          }
        } catch {
          // skip missing/expired credentials
        }
      }
      indexVersion++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Failed to populate search index:', msg);
    }
  }

  /**
   * GET /api/credentials/search
   * Advanced search with filters, full-text search, ranking, deduplication,
   * and cursor-based pagination.
   * Query params:
   *   - q: full-text search query
   *   - type: credential type (supports multiple: type=1&type=2)
   *   - issuer: issuer address (supports multiple)
   *   - issuer_type: issuer type (supports multiple)
   *   - subject: subject address
   *   - status: active|revoked|suspended
   *   - jurisdiction: ISO 3166-1/3166-2 or supranational group code
   *     (supports multiple: jurisdiction=US&jurisdiction=EU). Hierarchical —
   *     "US" matches "US-CA" etc., "EU" matches any EU member country.
   *   - attestation_count_min, attestation_count_max: attestation count range
   *   - created_after, created_before: creation date range (ISO 8601)
   *   - expires_after, expires_before: expiration date range (ISO 8601)
   *   - filter: comma-separated `field=value` clauses applied server-side
   *     before pagination (e.g. credential_type=PE,status=active). Only
   *     known fields are accepted; unknown fields or invalid values return
   *     400. Indexed fields (credential_type, status, issuer, ...) are
   *     resolved via lookup maps for fast filtering.
   *   - <field>[gte]/[lte]/[gt]/[lt]/[regex]: advanced per-field operators
   *     (e.g. attestation_count[gte]=2, issuer[regex]=BANK.*, supports
   *     dotted metadata paths like metadata[name][regex]=...)
   *   - filter[and]/[or]/[not]: nested boolean combinations of the above
   *   - deduplicate: when true, collapses same subject+issuer credentials to
   *     the highest version (ties broken by latest updated_at)
   *   - include_versions: when true, includes a `versions` map of every
   *     subject+issuer group in the response
   *   - include_score: when true, attaches a `reputation_score` to each result
   *   - cursor: base64-encoded cursor for pagination (from previous response)
   *   - limit: results per page (default: 20, max: 100)
   *   - sort_by: comma-separated list of id|type|relevance|created_at|
   *     updated_at|recency|reputation (default: relevance if `q` is set,
   *     otherwise id)
   *   - sort_order: asc|desc (default: desc for recency/reputation, else asc)
   *   - facets: comma-separated facet names (default: issuer,credential_type,status,issuer_type,jurisdiction)
   */
  router.get('/search', async (req: Request, res: Response) => {
    try {
      // Populate index on first search or if empty
      if (currentIndex.getIndexSize() === 0) {
        await populateIndex();
      }

      const {
        q,
        type,
        issuer,
        issuer_type,
        subject,
        status,
        jurisdiction,
        attestation_count_min,
        attestation_count_max,
        created_after,
        created_before,
        expires_after,
        expires_before,
        cursor: cursorQ,
        limit: limitQ = '20',
        facets: facetsQ,
        deduplicate: deduplicateQ,
        show_all: showAllQ,
        include_versions: includeVersionsQ,
        include_score: includeScoreQ,
      } = req.query as Record<string, string>;

      // Validate limit
      const limitNum = parseInt(limitQ, 10);
      if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
        res.status(400).json({ error: 'limit must be between 1 and 100' });
        return;
      }

      // Parse and validate server-side filter clauses before doing any work.
      let filterClauses: CredentialFilterClause[] = [];
      if (typeof req.query.filter === 'string' && req.query.filter.length > 0) {
        try {
          filterClauses = parseCredentialFilters(req.query.filter);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          res.status(400).json({ error: msg });
          return;
        }
      }

      // sort_by defaults to 'relevance' when a text query is present (so
      // matches rank by relevance instead of arbitrary id order), else 'id'.
      const sortByRaw =
        typeof req.query.sort_by === 'string' && req.query.sort_by.length > 0
          ? req.query.sort_by
          : q
            ? 'relevance'
            : 'id';
      const sortByParts = sortByRaw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      if (sortByParts.length === 0 || !sortByParts.every(p => VALID_SORT_KEYS.includes(p))) {
        res.status(400).json({ error: `sort_by must be one of: ${VALID_SORT_KEYS.join(', ')}` });


/* … truncated 13614 chars — edit only what you need near the top … */
