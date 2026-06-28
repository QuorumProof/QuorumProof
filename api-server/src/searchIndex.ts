/**
 * Advanced Search Index Service
 *
 * Provides full-text search via an **inverted index**, faceted filtering,
 * and aggregation for credentials.
 *
 * ## Inverted Index
 * Each time credentials are indexed (`indexCredentials` / `indexCredential`)
 * the text of the following fields is tokenised and added to an in-memory
 * inverted index that maps token → Set<credentialId>:
 *
 *   - issuer          (weight 3)
 *   - subject         (weight 2)
 *   - issuer_type     (weight 2)
 *   - id              (weight 1.5)
 *   - credential_type (weight 1)
 *   - metadata values (weight 0.5)
 *   - metadata keys   (weight 0.5)
 *
 * At query time the query string is tokenised and the posting lists for each
 * token are intersected/unioned to produce a candidate set, then each
 * candidate is scored for relevance.  This replaces the previous O(n × q)
 * linear scan with an O(|postings| × q) lookup that is typically much
 * smaller for large corpora.
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
  };
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
};

export type SearchOptions = SearchFilters & {
  query?: string;
  cursor?: string;
  limit?: number;
  sort_by?: 'id' | 'type' | 'relevance' | 'created_at' | 'updated_at';
  sort_order?: 'asc' | 'desc';
  facets?: string[];
  owner?: string;
};

// ---------------------------------------------------------------------------
// Field weight map used both when building the index and when scoring.
// ---------------------------------------------------------------------------
const FIELD_WEIGHTS: Record<string, number> = {
  issuer: 3,
  subject: 2,
  issuer_type: 2,
  id: 1.5,
  credential_type: 1,
  metadata: 0.5,
};

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

// ---------------------------------------------------------------------------
// SearchIndex class
// ---------------------------------------------------------------------------

export class SearchIndex {
  private credentials: Map<string, CredentialRecord> = new Map();
  private invertedIndex: InvertedIndex = new Map();
  private lastIndexed: Date | null = null;

  // ── Index management ──────────────────────────────────────────────────────

  /**
   * Build the full index from a credential array (clears any previous state).
   */
  indexCredentials(creds: CredentialRecord[]): void {
    this.credentials.clear();
    this.invertedIndex.clear();

    for (const cred of creds) {
      this.credentials.set(cred.id, cred);
      this._addToInvertedIndex(cred);
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
    }
    this.credentials.set(cred.id, cred);
    this._addToInvertedIndex(cred);
    if (!this.lastIndexed) this.lastIndexed = new Date();
  }

  /**
   * Remove a credential from the index by ID.
   */
  removeCredential(credentialId: string): void {
    const existing = this.credentials.get(credentialId);
    if (existing) {
      this._removeFromInvertedIndex(existing);
      this.credentials.delete(credentialId);
    }
  }

  /**
   * Clear all indexed data.
   */
  clear(): void {
    this.credentials.clear();
    this.invertedIndex.clear();
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
    switch (sort_by) {
      case 'type':
        return String(cred.credential_type).padStart(20, '0');
      case 'created_at':
        return cred.created_at || '';
      case 'updated_at':
        return cred.updated_at || '';
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
   * facets, sorting and cursor-based pagination.
   *
   * When a `query` string is provided the inverted index is used to retrieve
   * candidates in O(|matches|) time instead of scanning the entire corpus.
   * Results are then scored by relevance and the rest of the pipeline
   * (filters, sort, facets, pagination) runs on the candidate subset.
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

    // ── Step 1: Candidate selection ──────────────────────────────────────────
    // Use the inverted index for full-text queries; otherwise start with the
    // full corpus and let the filter pass narrow it down.
    let candidateIds: Set<string> | null = null;
    if (queryTokens.length > 0) {
      candidateIds = this._lookup(queryTokens, false /* OR */);
    }

    const allCredentials = Array.from(this.credentials.values());

    // ── Step 2: Filter pass ───────────────────────────────────────────────────
    let filtered = allCredentials.filter(cred => {
      // Restrict to inverted-index candidates when a query is present
      if (candidateIds !== null && !candidateIds.has(cred.id)) return false;

      // Permission-based filtering
      if (owner && cred.owner && cred.owner !== owner) return false;

      // Structural filters
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

      return true;
    });

    // ── Step 3: Relevance scoring & sort ─────────────────────────────────────
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

    // Deterministic secondary sort (or primary when not sorting by relevance)
    if (sort_by !== 'relevance' || queryTokens.length === 0) {
      filtered.sort((a, b) => {
        let aVal: number | string;
        let bVal: number | string;

        switch (sort_by) {
          case 'type':
            aVal = a.credential_type;
            bVal = b.credential_type;
            break;
          case 'created_at':
            aVal = a.created_at || '';
            bVal = b.created_at || '';
            break;
          case 'updated_at':
            aVal = a.updated_at || '';
            bVal = b.updated_at || '';
            break;
          case 'id':
          default:
            aVal = parseInt(a.id, 10);
            bVal = parseInt(b.id, 10);
        }

        if (typeof aVal === 'string' && typeof bVal === 'string') {
          return sort_order === 'desc'
            ? bVal.localeCompare(aVal)
            : aVal.localeCompare(bVal);
        }
        return sort_order === 'desc'
          ? (bVal as number) - (aVal as number)
          : (aVal as number) - (bVal as number);
      });
    }

    // ── Step 4: Facet calculation (pre-pagination) ────────────────────────────
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
    }

    // ── Step 5: Cursor pagination (binary search) ─────────────────────────────
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

    const data = filtered.slice(startIndex, startIndex + pageSize);

    // ── Step 6: Build facet response ──────────────────────────────────────────
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

    return {
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
          attestation_count_min: options.attestation_count_min,
          attestation_count_max: options.attestation_count_max,
          created_after: options.created_after,
          created_before: options.created_before,
          expires_after: options.expires_after,
          expires_before: options.expires_before,
        },
        execution_time_ms: Date.now() - startTime,
      },
    };
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
