/**
 * Advanced Search Index Service
 *
 * Provides full-text search via an **inverted index**, faceted filtering,
 * ranking, deduplication, and aggregation for credentials.
 *
 * ## Inverted Index
 * Each time credentials are indexed (`indexCredentials` / `indexCredential`)
 * the text of the following fields is tokenised and added to an in-memory
 * inverted index that maps token → Set<credentialId>:
 *
 *   - issuer          (weight 3)
 *   - subject         (weight 2)
 *   - issuer_type     (weight 2)
 *   - jurisdiction    (weight 2)
 *   - id              (weight 1.5)
 *   - credential_type (weight 1)
 *   - metadata values (weight 0.5)
 *   - metadata keys   (weight 0.5)
 *
 * At query time the query string is tokenised and the posting lists for each
 * token are intersected/unioned to produce a candidate set, then each
 * candidate is scored for relevance.
 *
 * ## Field indexes
 * `issuer`, `issuer_type`, `credential_type`, and `status` are additionally
 * indexed as value → Set<credentialId> maps so that structural filters (and
 * a text query) narrow the candidate set via index lookups *before* any
 * per-record scan — the per-record filter pass below only runs over that
 * narrowed candidate set, not the full corpus.
 *
 * ## Jurisdiction
 * A credential's jurisdiction (`jurisdiction`, falling back to
 * `metadata.jurisdiction`) is an ISO 3166-1 country code ("US"), ISO 3166-2
 * subdivision code ("US-CA"), or supranational group code ("EU"). It is
 * indexed hierarchically — under itself, its parent country, and any groups
 * the country belongs to — so filtering by "EU" matches every EU member
 * country's credentials and filtering by "US" matches "US" and every
 * "US-*" subdivision. See jurisdictionAncestors().
 */

export type CredentialRecord = {
  id: string;
  subject: string;
  issuer: string;
  issuer_type?: string;
  credential_type: number;
  metadata_hash: string;
  metadata?: Record<string, unknown>;
  revoked: boolean;
  suspended: boolean;
  attestation_count?: number;
  expires_at: string | null;
  created_at?: string;
  updated_at?: string;
  version: number;
  owner?: string;
  /**
   * ISO 3166-1 alpha-2 country code ("US"), ISO 3166-2 subdivision code
   * ("US-CA"), or a supranational group code ("EU"). Falls back to
   * `metadata.jurisdiction` if not set directly — see jurisdictionOf().
   */
  jurisdiction?: string;
};

export type SearchFacet = {
  name: string;
  values: {
    value: string;
    count: number;
  }[];
};

export type SearchResult = {
  data: CredentialRecord[];
  facets: SearchFacet[];
  pagination: {
    cursor: string | null;
    next_cursor: string | null;
    limit: number;
    total: number;
    has_more: boolean;
  };
  query_info?: {
    full_text_query?: string;
    active_filters: Record<string, unknown>;
    execution_time_ms: number;
    sort_by?: string;
    sort_order?: string;
  };
  deduplication_stats?: {
    total_before: number;
    total_after: number;
    duplicates_removed: number;
  };
  versions?: Record<string, CredentialRecord[]>;
};

export type SearchFilters = {
  type?: number | number[];
  issuer?: string | string[];
  issuer_type?: string | string[];
  subject?: string;
  status?: 'active' | 'revoked' | 'suspended';
  attestation_count_min?: number;
  attestation_count_max?: number;
  created_after?: string;
  created_before?: string;
  expires_after?: string;
  expires_before?: string;
  /**
   * ISO 3166-1/3166-2 or supranational group code(s), e.g. "US", "US-CA",
   * "EU". Matching is hierarchical: querying "US" matches credentials in
   * "US" and any "US-*" subdivision; querying "EU" matches credentials in
   * any EU member country (and their subdivisions). See jurisdictionAncestors().
   */
  jurisdiction?: string | string[];
};

// ---------------------------------------------------------------------------
// Advanced filter tree (bracket operators / and-or-not trees from the route)
// ---------------------------------------------------------------------------

export type FilterOp = 'eq' | 'gte' | 'lte' | 'gt' | 'lt' | 'regex';

export type FilterNode =
  | { and: FilterNode[] }
  | { or: FilterNode[] }
  | { not: FilterNode }
  | { field: string; op: FilterOp; value: unknown };

export type SearchOptions = SearchFilters & {
  query?: string;
  cursor?: string;
  limit?: number;
  /** Comma-separated list of: id|type|relevance|created_at|updated_at|recency|reputation */
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
  facets?: string[];
  owner?: string;
  filterTree?: FilterNode[];
  deduplicate?: boolean;
  include_versions?: boolean;
  include_score?: boolean;
};

// ---------------------------------------------------------------------------
// Field weight map used both when building the index and when scoring.
// ---------------------------------------------------------------------------
const FIELD_WEIGHTS: Record<string, number> = {
  issuer: 3,
  subject: 2,
  issuer_type: 2,
  jurisdiction: 2,
  id: 1.5,
  credential_type: 1,
  metadata: 0.5,
};

const ISSUER_TYPE_REPUTATION_WEIGHT: Record<string, number> = {
  government: 3,
  bank: 2,
  private: 1,
};

/** Higher-is-better score combining attestor count with issuer-type trust weight. */
function reputationScore(cred: CredentialRecord): number {
  const attestation = cred.attestation_count ?? 0;
  const issuerWeight = ISSUER_TYPE_REPUTATION_WEIGHT[(cred.issuer_type || '').toLowerCase()] ?? 0;
  return attestation * 10 + issuerWeight;
}

// ---------------------------------------------------------------------------
// Jurisdiction modeling
//
// Codes are ISO 3166-1 alpha-2 country codes ("US"), ISO 3166-2 subdivision
// codes ("US-CA", country + "-" + subdivision), or a supranational group
// code ("EU"). Hierarchy is two-level by design (country -> subdivision),
// matching the ISO 3166-2 standard, plus a static country -> group mapping
// for supranational bodies. A credential's jurisdiction is indexed at every
// ancestor level so a query for any level (country, group) matches without
// needing to know the full descendant set at query time.
// ---------------------------------------------------------------------------

const SUPRANATIONAL_GROUPS: Record<string, string[]> = {
  EU: [
    'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
    'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
    'SI', 'ES', 'SE',
  ],
};

const COUNTRY_TO_GROUPS: Map<string, string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const [group, members] of Object.entries(SUPRANATIONAL_GROUPS)) {
    for (const country of members) {
      const groups = map.get(country);
      if (groups) groups.push(group);
      else map.set(country, [group]);
    }
  }
  return map;
})();

export function normalizeJurisdiction(code: string): string {
  return code.trim().toUpperCase();
}

/** Read a credential's jurisdiction, preferring the top-level field and falling back to metadata. */
export function jurisdictionOf(cred: CredentialRecord): string | undefined {
  const raw = cred.jurisdiction ?? (cred.metadata?.jurisdiction as string | undefined);
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined;
  return normalizeJurisdiction(raw);
}

/**
 * Every level a credential's jurisdiction code should be indexed/matched
 * under: itself, its parent country (if it's a subdivision), and any
 * supranational groups its country belongs to.
 *
 * e.g. "US-CA" -> ["US-CA", "US"]; "DE" -> ["DE", "EU"]; "FR-75" -> ["FR-75", "FR", "EU"]
 */
export function jurisdictionAncestors(code: string): string[] {
  const normalized = normalizeJurisdiction(code);
  const ancestors = [normalized];
  const dashIndex = normalized.indexOf('-');
  const country = dashIndex === -1 ? normalized : normalized.slice(0, dashIndex);
  if (dashIndex !== -1) ancestors.push(country);
  const groups = COUNTRY_TO_GROUPS.get(country);
  if (groups) ancestors.push(...groups);
  return ancestors;
}

// ---------------------------------------------------------------------------
// Tokenisation helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a string to lowercase alphanumeric tokens.
 * Non-word characters are treated as delimiters.
 * Tokens shorter than 2 characters are dropped (reduces noise while keeping
 * useful short identifiers like "G1" or "v2").
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\W]+/)
    .map(t => t.replace(/[^\w]/g, ''))
    .filter(t => t.length >= 2);
}

/**
 * Extract all searchable text fields from a credential as (fieldName, text)
 * pairs so the caller can weight them appropriately.
 */
function extractFields(cred: CredentialRecord): Array<{ field: string; text: string }> {
  const fields: Array<{ field: string; text: string }> = [
    { field: 'issuer', text: cred.issuer || '' },
    { field: 'subject', text: cred.subject || '' },
    { field: 'issuer_type', text: cred.issuer_type || '' },
    { field: 'jurisdiction', text: jurisdictionOf(cred) || '' },
    { field: 'id', text: String(cred.id) },
    { field: 'credential_type', text: String(cred.credential_type) },
  ];

  // Flatten metadata object into searchable text
  if (cred.metadata && typeof cred.metadata === 'object') {
    const flattenMetadata = (obj: Record<string, unknown>, prefix = ''): void => {
      for (const [key, val] of Object.entries(obj)) {
        // Index key names
        fields.push({ field: 'metadata', text: prefix ? `${prefix}_${key}` : key });
        if (val === null || val === undefined) continue;
        if (typeof val === 'object' && !Array.isArray(val)) {
          flattenMetadata(val as Record<string, unknown>, key);
        } else if (Array.isArray(val)) {
          for (const item of val) {
            if (item !== null && typeof item !== 'object') {
              fields.push({ field: 'metadata', text: String(item) });
            }
          }
        } else {
          fields.push({ field: 'metadata', text: String(val) });
        }
      }
    };
    flattenMetadata(cred.metadata);
  }

  return fields;
}

// ---------------------------------------------------------------------------
// Relevance scoring
// ---------------------------------------------------------------------------

/**
 * Score a credential against a query using the inverted index for candidate
 * generation and per-field weighted token matching for scoring.
 *
 * Returns 0 if there is no match at all.
 */
function scoreCredential(cred: CredentialRecord, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const fields = extractFields(cred);
  let score = 0;

  for (const { field, text } of fields) {
    const weight = FIELD_WEIGHTS[field] ?? 0.5;
    const fieldTokens = tokenize(text);
    for (const qt of queryTokens) {
      for (const ft of fieldTokens) {
        if (ft === qt) {
          // Exact match — full weight
          score += weight * 2;
        } else if (ft.includes(qt) || qt.includes(ft)) {
          // Partial / prefix match — half weight
          score += weight;
        }
      }
    }
  }

  return score;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function parseDate(dateStr: string | undefined): Date | null {
  if (!dateStr) return null;
  const date = new Date(dateStr);
  return isNaN(date.getTime()) ? null : date;
}

// ---------------------------------------------------------------------------
// Advanced filter tree evaluation
// ---------------------------------------------------------------------------

function getFieldValue(record: CredentialRecord, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = record;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function toComparable(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  const n = Number(value);
  if (!isNaN(n)) return n;
  const d = new Date(String(value));
  const t = d.getTime();
  return isNaN(t) ? null : t;
}

function evalFilterNode(node: FilterNode, record: CredentialRecord): boolean {
  if ('and' in node) return node.and.every(n => evalFilterNode(n, record));
  if ('or' in node) return node.or.some(n => evalFilterNode(n, record));
  if ('not' in node) return !evalFilterNode(node.not, record);

  const actual = getFieldValue(record, node.field);
  switch (node.op) {
    case 'eq':
      return String(actual) === String(node.value);
    case 'gte':
    case 'lte':
    case 'gt':
    case 'lt': {
      const a = toComparable(actual);
      const b = toComparable(node.value);
      if (a === null || b === null) return false;
      if (node.op === 'gte') return a >= b;
      if (node.op === 'lte') return a <= b;
      if (node.op === 'gt') return a > b;
      return a < b;
    }
    case 'regex': {
      try {
        let pattern = String(node.value);
        let flags = '';
        const caseInsensitive = pattern.match(/^\(\?i\)(.*)$/);
        if (caseInsensitive) {
          pattern = caseInsensitive[1];
          flags = 'i';
        }
        const re = new RegExp(pattern, flags);
        return re.test(String(actual ?? ''));
      } catch {
        return false;
      }
    }
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// Sorting helpers
// ---------------------------------------------------------------------------

function sortKeyValue(cred: CredentialRecord, key: string): number | string {
  switch (key) {
    case 'type':
      return cred.credential_type;
    case 'created_at':
      return cred.created_at || '';
    case 'updated_at':
      return cred.updated_at || '';
    case 'recency':
      return Date.parse(cred.created_at || cred.updated_at || '') || 0;
    case 'reputation':
      return reputationScore(cred);
    case 'relevance':
      return 0;
    case 'id':
    default:
      return parseInt(cred.id, 10);
  }
}

function compareByKeys(a: CredentialRecord, b: CredentialRecord, keys: string[], order: 'asc' | 'desc'): number {
  for (const key of keys) {
    const av = sortKeyValue(a, key);
    const bv = sortKeyValue(b, key);
    const cmp = typeof av === 'string' && typeof bv === 'string' ? av.localeCompare(bv) : (av as number) - (bv as number);
    if (cmp !== 0) return order === 'desc' ? -cmp : cmp;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupeKey(cred: CredentialRecord): string {
  return `${cred.subject ?? ''}::${cred.issuer ?? ''}`;
}

function deduplicateRecords(records: CredentialRecord[]): {
  deduped: CredentialRecord[];
  stats: { total_before: number; total_after: number; duplicates_removed: number };
  groups: Map<string, CredentialRecord[]>;
} {
  const groups = new Map<string, CredentialRecord[]>();
  for (const record of records) {
    const key = dedupeKey(record);
    const group = groups.get(key);
    if (group) group.push(record);
    else groups.set(key, [record]);
  }

  const deduped: CredentialRecord[] = [];
  for (const group of groups.values()) {
    let best = group[0];
    for (const candidate of group.slice(1)) {
      const bestVersion = best.version ?? 0;
      const candidateVersion = candidate.version ?? 0;
      if (candidateVersion > bestVersion) {
        best = candidate;
      } else if (candidateVersion === bestVersion) {
        const bestTime = Date.parse(best.updated_at || '') || 0;
        const candidateTime = Date.parse(candidate.updated_at || '') || 0;
        if (candidateTime >= bestTime) best = candidate;
      }
    }
    deduped.push(best);
  }

  return {
    deduped,
    stats: {
      total_before: records.length,
      total_after: deduped.length,
      duplicates_removed: records.length - deduped.length,
    },
    groups,
  };
}

// ---------------------------------------------------------------------------
// Inverted index data structures
// ---------------------------------------------------------------------------

/**
 * A posting entry stores the credential ID and which field the token appeared
 * in so we can re-use field weights during scoring without re-parsing text.
 */
type Posting = { credId: string; field: string };

/**
 * The inverted index maps a normalised token string to the list of postings
 * (credential + field) where that token appears.
 */
type InvertedIndex = Map<string, Posting[]>;

type IndexedFieldName = 'issuer' | 'issuer_type' | 'credential_type' | 'status';
const INDEXED_FIELDS: IndexedFieldName[] = ['issuer', 'issuer_type', 'credential_type', 'status'];

function statusOf(cred: CredentialRecord): string {
  return cred.revoked ? 'revoked' : cred.suspended ? 'suspended' : 'active';
}

function fieldIndexValue(cred: CredentialRecord, field: IndexedFieldName): string {
  switch (field) {
    case 'issuer':
      return cred.issuer ?? '';
    case 'issuer_type':
      return cred.issuer_type || 'unknown';
    case 'credential_type':
      return String(cred.credential_type);
    case 'status':
      return statusOf(cred);
  }
}

function intersectSets(a: Set<string>, b: Set<string>): Set<string> {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  const result = new Set<string>();
  for (const id of small) {
    if (big.has(id)) result.add(id);
  }
  return result;
}

function unionFieldIndex(map: Map<string, Set<string>>, values: string[]): Set<string> {
  const result = new Set<string>();
  for (const value of values) {
    const set = map.get(value);
    if (set) for (const id of set) result.add(id);
  }
  return result;
}

// ---------------------------------------------------------------------------
// SearchIndex class
// ---------------------------------------------------------------------------

export class SearchIndex {
  private credentials: Map<string, CredentialRecord> = new Map();
  private invertedIndex: InvertedIndex = new Map();
  private fieldIndex: Record<IndexedFieldName, Map<string, Set<string>>> = {
    issuer: new Map(),
    issuer_type: new Map(),
    credential_type: new Map(),
    status: new Map(),
  };
  /**
   * Jurisdiction is indexed separately from fieldIndex because a single
   * credential is indexed under *multiple* keys (itself + ancestors —
   * see jurisdictionAncestors()), unlike the single-value fields above.
   */
  private jurisdictionIndex: Map<string, Set<string>> = new Map();
  private lastIndexed: Date | null = null;

  // ── Index management ──────────────────────────────────────────────────────

  /**
   * Build the full index from a credential array (clears any previous state).
   */
  indexCredentials(creds: CredentialRecord[]): void {
    this.credentials.clear();
    this.invertedIndex.clear();
    for (const field of INDEXED_FIELDS) this.fieldIndex[field].clear();
    this.jurisdictionIndex.clear();

    for (const cred of creds) {
      this.credentials.set(cred.id, cred);
      this._addToInvertedIndex(cred);
      this._addToFieldIndex(cred);
      this._addToJurisdictionIndex(cred);
    }
    this.lastIndexed = new Date();
  }

  /**
   * Add or update a single credential in the index.
   * If an existing credential with the same ID is present it is removed first
   * so the inverted index stays consistent.
   */
  indexCredential(cred: CredentialRecord): void {
    const existing = this.credentials.get(cred.id);
    if (existing) {
      this._removeFromInvertedIndex(existing);
      this._removeFromFieldIndex(existing);
      this._removeFromJurisdictionIndex(existing);
    }
    this.credentials.set(cred.id, cred);
    this._addToInvertedIndex(cred);
    this._addToFieldIndex(cred);
    this._addToJurisdictionIndex(cred);
    if (!this.lastIndexed) this.lastIndexed = new Date();
  }

  /**
   * Remove a credential from the index by ID.
   */
  removeCredential(credentialId: string): void {
    const existing = this.credentials.get(credentialId);
    if (existing) {
      this._removeFromInvertedIndex(existing);
      this._removeFromFieldIndex(existing);
      this._removeFromJurisdictionIndex(existing);
      this.credentials.delete(credentialId);
    }
  }

  /**
   * Clear all indexed data.
   */
  clear(): void {
    this.credentials.clear();
    this.invertedIndex.clear();
    for (const field of INDEXED_FIELDS) this.fieldIndex[field].clear();
    this.jurisdictionIndex.clear();
    this.lastIndexed = null;
  }

  // ── Inverted index maintenance ────────────────────────────────────────────

  private _addToInvertedIndex(cred: CredentialRecord): void {
    const fields = extractFields(cred);
    // De-duplicate (token, field) pairs per credential to avoid counting the
    // same field-token pair multiple times.
    const seen = new Set<string>();

    for (const { field, text } of fields) {
      for (const token of tokenize(text)) {
        const key = `${token}::${field}`;
        if (seen.has(key)) continue;
        seen.add(key);

        let postings = this.invertedIndex.get(token);
        if (!postings) {
          postings = [];
          this.invertedIndex.set(token, postings);
        }
        postings.push({ credId: cred.id, field });
      }
    }
  }

  private _removeFromInvertedIndex(cred: CredentialRecord): void {
    const fields = extractFields(cred);
    const seen = new Set<string>();

    for (const { field, text } of fields) {
      for (const token of tokenize(text)) {
        const key = `${token}::${field}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const postings = this.invertedIndex.get(token);
        if (!postings) continue;
        const filtered = postings.filter(p => p.credId !== cred.id);
        if (filtered.length === 0) {
          this.invertedIndex.delete(token);
        } else {
          this.invertedIndex.set(token, filtered);
        }
      }
    }
  }

  // ── Field (structural filter) index maintenance ───────────────────────────

  private _addToFieldIndex(cred: CredentialRecord): void {
    for (const field of INDEXED_FIELDS) {
      const value = fieldIndexValue(cred, field);
      const map = this.fieldIndex[field];
      let set = map.get(value);
      if (!set) {
        set = new Set();
        map.set(value, set);
      }
      set.add(cred.id);
    }
  }

  private _removeFromFieldIndex(cred: CredentialRecord): void {
    for (const field of INDEXED_FIELDS) {
      const value = fieldIndexValue(cred, field);
      const map = this.fieldIndex[field];
      const set = map.get(value);
      if (!set) continue;
      set.delete(cred.id);
      if (set.size === 0) map.delete(value);
    }
  }

  // ── Jurisdiction index maintenance (multi-key: self + ancestors) ──────────

  private _addToJurisdictionIndex(cred: CredentialRecord): void {
    const jurisdiction = jurisdictionOf(cred);
    if (!jurisdiction) return;
    for (const key of jurisdictionAncestors(jurisdiction)) {
      let set = this.jurisdictionIndex.get(key);
      if (!set) {
        set = new Set();
        this.jurisdictionIndex.set(key, set);
      }
      set.add(cred.id);
    }
  }

  private _removeFromJurisdictionIndex(cred: CredentialRecord): void {
    const jurisdiction = jurisdictionOf(cred);
    if (!jurisdiction) return;
    for (const key of jurisdictionAncestors(jurisdiction)) {
      const set = this.jurisdictionIndex.get(key);
      if (!set) continue;
      set.delete(cred.id);
      if (set.size === 0) this.jurisdictionIndex.delete(key);
    }
  }

  // ── Full-text candidate lookup via inverted index ─────────────────────────

  /**
   * Return the set of credential IDs that match at least one query token.
   * If `requireAll` is true only credentials matching ALL tokens are returned
   * (AND semantics); otherwise OR semantics is used.
   *
   * OR semantics is used for search (max recall), scoring then ranks by
   * relevance.
   */
  private _lookup(queryTokens: string[], requireAll = false): Set<string> {
    if (queryTokens.length === 0) return new Set(this.credentials.keys());

    const postingSets: Set<string>[] = queryTokens.map(qt => {
      const matches = new Set<string>();
      // Exact token match
      const exact = this.invertedIndex.get(qt);
      if (exact) {
        for (const p of exact) matches.add(p.credId);
      }
      // Prefix / substring scan over the index vocabulary for partial matches.
      // This is O(|vocabulary|) in the worst case but is only triggered when
      // there is no exact match and is bounded by the vocabulary size.
      for (const [token, postings] of this.invertedIndex) {
        if (token !== qt && (token.includes(qt) || qt.includes(token))) {
          for (const p of postings) matches.add(p.credId);
        }
      }
      return matches;
    });

    if (requireAll) {
      // Intersection
      let result = postingSets[0];
      for (let i = 1; i < postingSets.length; i++) {
        result = new Set([...result].filter(id => postingSets[i].has(id)));
      }
      return result;
    }

    // Union
    const result = new Set<string>();
    for (const s of postingSets) {
      for (const id of s) result.add(id);
    }
    return result;
  }

  // ── Cursor helpers ────────────────────────────────────────────────────────

  private decodeCursor(cursor: string | undefined): string | null {
    if (!cursor) return null;
    try {
      return Buffer.from(cursor, 'base64').toString('utf-8');
    } catch {
      return null;
    }
  }

  private encodeCursor(value: string): string {
    return Buffer.from(value).toString('base64');
  }

  private getSortValue(cred: CredentialRecord, sort_by: string): string {
    const key = sort_by.split(',')[0]?.trim() || 'id';
    switch (key) {
      case 'type':
        return String(cred.credential_type).padStart(20, '0');
      case 'created_at':
        return cred.created_at || '';
      case 'updated_at':
        return cred.updated_at || '';
      case 'recency':
        return String(Math.max(0, Math.floor(Date.parse(cred.created_at || cred.updated_at || '') || 0))).padStart(
          20,
          '0',
        );
      case 'reputation':
        return String(Math.max(0, Math.floor(reputationScore(cred)))).padStart(20, '0');
      case 'relevance':
        return String(0).padStart(20, '0');
      case 'id':
      default:
        return String(cred.id).padStart(20, '0');
    }
  }

  // ── Main search entry point ───────────────────────────────────────────────

  /**
   * Search credentials with optional full-text query, structural filters,
   * an advanced filter tree, deduplication, ranking, facets and cursor-based
   * pagination.
   *
   * When a `query` string or a structural filter (type/issuer/issuer_type/
   * status) is provided, the inverted index / field indexes are used to
   * narrow the candidate set *before* the per-record filter pass runs, so
   * the pass below scans the narrowed set rather than the full corpus.
   */
  search(options: SearchOptions): SearchResult {
    const startTime = Date.now();
    const {
      query,
      cursor,
      limit = 20,
      sort_by = 'id',
      sort_order = 'asc',
      facets = ['issuer', 'credential_type', 'status', 'issuer_type'],
      owner,
    } = options;

    const pageSize = Math.min(100, Math.max(1, limit));
    const queryTokens = query ? tokenize(query) : [];

    // ── Step 1: Candidate selection via inverted index + field indexes ───────
    let candidateIds: Set<string> | null = null;
    if (queryTokens.length > 0) {
      candidateIds = this._lookup(queryTokens, false /* OR */);
    }

    const narrowByField = (map: Map<string, Set<string>>, values: string[]): void => {
      const idx = unionFieldIndex(map, values);
      candidateIds = candidateIds !== null ? intersectSets(candidateIds, idx) : idx;
    };

    if (options.type !== undefined) {
      const types = (Array.isArray(options.type) ? options.type : [options.type]).map(String);
      narrowByField(this.fieldIndex.credential_type, types);
    }
    if (options.issuer !== undefined) {
      const issuers = Array.isArray(options.issuer) ? options.issuer : [options.issuer];
      narrowByField(this.fieldIndex.issuer, issuers);
    }
    if (options.issuer_type !== undefined) {
      const issuerTypes = Array.isArray(options.issuer_type) ? options.issuer_type : [options.issuer_type];
      narrowByField(this.fieldIndex.issuer_type, issuerTypes);
    }
    if (options.status !== undefined) {
      narrowByField(this.fieldIndex.status, [options.status]);
    }
    if (options.jurisdiction !== undefined) {
      const jurisdictions = (Array.isArray(options.jurisdiction) ? options.jurisdiction : [options.jurisdiction]).map(
        normalizeJurisdiction,
      );
      narrowByField(this.jurisdictionIndex, jurisdictions);
    }

    const baseRecords: CredentialRecord[] =
      candidateIds !== null
        ? Array.from(candidateIds)
            .map(id => this.credentials.get(id))
            .filter((c): c is CredentialRecord => !!c)
        : Array.from(this.credentials.values());

    // ── Step 2: Filter pass (over the narrowed candidate set) ────────────────
    let filtered = baseRecords.filter(cred => {
      // Permission-based filtering
      if (owner && cred.owner && cred.owner !== owner) return false;

      // Structural filters (re-checked here as a correctness safety net —
      // the field-index narrowing above is an optimization, not the only
      // source of truth).
      if (options.type !== undefined) {
        const types = Array.isArray(options.type) ? options.type : [options.type];
        if (!types.includes(cred.credential_type)) return false;
      }

      if (options.issuer !== undefined) {
        const issuers = Array.isArray(options.issuer) ? options.issuer : [options.issuer];
        if (!issuers.includes(cred.issuer)) return false;
      }

      if (options.issuer_type !== undefined) {
        const issuerTypes = Array.isArray(options.issuer_type)
          ? options.issuer_type
          : [options.issuer_type];
        if (!issuerTypes.includes(cred.issuer_type || '')) return false;
      }

      if (options.subject !== undefined && cred.subject !== options.subject) return false;

      if (options.jurisdiction !== undefined) {
        const jurisdiction = jurisdictionOf(cred);
        if (!jurisdiction) return false;
        const requested = (Array.isArray(options.jurisdiction) ? options.jurisdiction : [options.jurisdiction]).map(
          normalizeJurisdiction,
        );
        const ancestors = jurisdictionAncestors(jurisdiction);
        if (!requested.some(r => ancestors.includes(r))) return false;
      }

      if (options.status !== undefined) {
        if (options.status === 'revoked' && !cred.revoked) return false;
        if (options.status === 'suspended' && !cred.suspended) return false;
        if (options.status === 'active' && (cred.revoked || cred.suspended)) return false;
      }

      const attestCount = cred.attestation_count ?? 0;
      if (options.attestation_count_min !== undefined && attestCount < options.attestation_count_min) return false;
      if (options.attestation_count_max !== undefined && attestCount > options.attestation_count_max) return false;

      if (options.created_after) {
        const cd = parseDate(cred.created_at);
        const after = parseDate(options.created_after);
        if (!cd || !after || cd < after) return false;
      }
      if (options.created_before) {
        const cd = parseDate(cred.created_at);
        const before = parseDate(options.created_before);
        if (!cd || !before || cd > before) return false;
      }
      if (options.expires_after) {
        const ed = parseDate(cred.expires_at || undefined);
        const after = parseDate(options.expires_after);
        if (!ed || !after || ed < after) return false;
      }
      if (options.expires_before) {
        const ed = parseDate(cred.expires_at || undefined);
        const before = parseDate(options.expires_before);
        if (!ed || !before || ed > before) return false;
      }

      // Advanced filter tree (bracket operators / and-or-not, from the route)
      if (options.filterTree && options.filterTree.length > 0) {
        if (!options.filterTree.every(node => evalFilterNode(node, cred))) return false;
      }

      return true;
    });

    // ── Step 3: Relevance scoring & zero-score drop ───────────────────────────
    if (queryTokens.length > 0) {
      // Score each candidate and drop zero-scorers (no real match).
      const scored = filtered
        .map(cred => ({ cred, score: scoreCredential(cred, queryTokens) }))
        .filter(r => r.score > 0);

      if (sort_by === 'relevance') {
        scored.sort((a, b) => b.score - a.score);
        filtered = scored.map(r => r.cred);
      } else {
        // Score used only to drop irrelevant results; primary sort applied below.
        filtered = scored.map(r => r.cred);
      }
    }

    // ── Step 4: Deduplication (before sort/facets/pagination) ────────────────
    let deduplicationStats: SearchResult['deduplication_stats'];
    let versionGroups: Map<string, CredentialRecord[]> | undefined;
    if (options.include_versions) {
      versionGroups = deduplicateRecords(filtered).groups;
    }
    if (options.deduplicate) {
      const { deduped, stats } = deduplicateRecords(filtered);
      filtered = deduped;
      deduplicationStats = stats;
    }

    // ── Step 5: Sort ───────────────────────────────────────────────────────
    const sortKeys = sort_by
      .split(',')
      .map(k => k.trim())
      .filter(Boolean);
    if (sort_by !== 'relevance' || queryTokens.length === 0) {
      filtered.sort((a, b) => compareByKeys(a, b, sortKeys.length ? sortKeys : ['id'], sort_order));
    }

    // ── Step 6: Facet calculation (pre-pagination) ────────────────────────────
    const facetData: Record<string, Map<string, number>> = {};
    for (const facetName of facets) {
      facetData[facetName] = new Map<string, number>();
    }

    for (const cred of filtered) {
      if (facets.includes('issuer')) {
        facetData.issuer.set(cred.issuer, (facetData.issuer.get(cred.issuer) ?? 0) + 1);
      }
      if (facets.includes('credential_type')) {
        const t = String(cred.credential_type);
        facetData.credential_type.set(t, (facetData.credential_type.get(t) ?? 0) + 1);
      }
      if (facets.includes('status')) {
        const s = cred.revoked ? 'revoked' : cred.suspended ? 'suspended' : 'active';
        facetData.status.set(s, (facetData.status.get(s) ?? 0) + 1);
      }
      if (facets.includes('issuer_type')) {
        const it = cred.issuer_type || 'unknown';
        facetData.issuer_type.set(it, (facetData.issuer_type.get(it) ?? 0) + 1);
      }
      if (facets.includes('jurisdiction')) {
        const j = jurisdictionOf(cred) || 'unknown';
        facetData.jurisdiction.set(j, (facetData.jurisdiction.get(j) ?? 0) + 1);
      }
    }

    // ── Step 7: Cursor pagination (binary search) ─────────────────────────────
    const total = filtered.length;
    const cursorVal = this.decodeCursor(cursor);
    let startIndex = 0;

    if (cursorVal) {
      let low = 0;
      let high = filtered.length - 1;
      while (low <= high) {
        const mid = (low + high) >>> 1;
        const midVal = this.getSortValue(filtered[mid], sort_by);
        if (midVal < cursorVal) {
          low = mid + 1;
        } else if (midVal > cursorVal) {
          high = mid - 1;
        } else {
          startIndex = mid + 1;
          break;
        }
      }
      if (startIndex === 0) startIndex = low;
    }

    let data = filtered.slice(startIndex, startIndex + pageSize);
    if (options.include_score) {
      data = data.map(cred => ({ ...cred, reputation_score: reputationScore(cred) }) as CredentialRecord);
    }

    // ── Step 8: Build facet response ──────────────────────────────────────────
    const facetsResponse: SearchFacet[] = [];
    for (const facetName of facets) {
      const facetValues = facetData[facetName];
      if (facetValues && facetValues.size > 0) {
        facetsResponse.push({
          name: facetName,
          values: Array.from(facetValues.entries())
            .map(([value, count]) => ({ value, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 50),
        });
      }
    }

    const hasMore = startIndex + pageSize < total;
    const nextCursor =
      hasMore && data.length > 0
        ? this.encodeCursor(this.getSortValue(data[data.length - 1], sort_by))
        : null;

    const result: SearchResult = {
      data,
      facets: facetsResponse,
      pagination: {
        cursor: cursor || null,
        next_cursor: nextCursor,
        limit: pageSize,
        total,
        has_more: hasMore,
      },
      query_info: {
        full_text_query: query,
        active_filters: {
          type: options.type,
          issuer: options.issuer,
          issuer_type: options.issuer_type,
          subject: options.subject,
          status: options.status,
          jurisdiction: options.jurisdiction,
          attestation_count_min: options.attestation_count_min,
          attestation_count_max: options.attestation_count_max,
          created_after: options.created_after,
          created_before: options.created_before,
          expires_after: options.expires_after,
          expires_before: options.expires_before,
          filter: options.filterTree && options.filterTree.length > 0 ? options.filterTree : undefined,
        },
        execution_time_ms: Date.now() - startTime,
        sort_by,
        sort_order,
      },
    };

    if (deduplicationStats) result.deduplication_stats = deduplicationStats;
    if (versionGroups) {
      result.versions = Object.fromEntries(versionGroups);
    }

    return result;
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  getIndexSize(): number {
    return this.credentials.size;
  }

  getLastIndexed(): Date | null {
    return this.lastIndexed;
  }

  /** Returns the number of unique tokens in the inverted index vocabulary. */
  getVocabularySize(): number {
    return this.invertedIndex.size;
  }
}

export default SearchIndex;
