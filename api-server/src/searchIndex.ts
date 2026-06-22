/**
 * Advanced Search Index Service
 * Provides full-text search, faceted filtering, and aggregation for credentials
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
    page: number;
    page_size: number;
    total: number;
    total_pages: number;
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
  page?: number;
  page_size?: number;
  sort_by?: 'id' | 'type' | 'relevance' | 'created_at' | 'updated_at';
  sort_order?: 'asc' | 'desc';
  facets?: string[];
  owner?: string;
};

// Tokenize and normalize text for full-text search
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter(t => t.length > 0)
    .map(t => t.replace(/[^\w]/g, ''));
}

// Calculate relevance score for full-text search
function calculateRelevance(credential: CredentialRecord, query: string): number {
  const queryTokens = tokenize(query);
  let score = 0;

  // Search in multiple fields with different weights
  const fields = [
    { text: credential.issuer || '', weight: 3 },
    { text: credential.subject || '', weight: 2 },
    { text: credential.id, weight: 1.5 },
    { text: String(credential.credential_type), weight: 1 },
    { text: credential.issuer_type || '', weight: 2 },
    { text: JSON.stringify(credential.metadata || {}), weight: 0.5 },
  ];

  for (const field of fields) {
    const fieldTokens = tokenize(field.text);
    for (const queryToken of queryTokens) {
      for (const fieldToken of fieldTokens) {
        if (fieldToken.includes(queryToken) || queryToken.includes(fieldToken)) {
          score += field.weight;
        }
      }
    }
  }

  return score;
}

// Parse date string to Date or null
function parseDate(dateStr: string | undefined): Date | null {
  if (!dateStr) return null;
  const date = new Date(dateStr);
  return isNaN(date.getTime()) ? null : date;
}

export class SearchIndex {
  private credentials: Map<string, CredentialRecord> = new Map();
  private lastIndexed: Date | null = null;

  /**
   * Index credentials into the search index
   */
  indexCredentials(creds: CredentialRecord[]): void {
    this.credentials.clear();
    for (const cred of creds) {
      this.credentials.set(cred.id, cred);
    }
    this.lastIndexed = new Date();
  }

  /**
   * Add or update a credential in the index
   */
  indexCredential(cred: CredentialRecord): void {
    this.credentials.set(cred.id, cred);
  }

  /**
   * Remove a credential from the index
   */
  removeCredential(credentialId: string): void {
    this.credentials.delete(credentialId);
  }

  /**
   * Search credentials with filters and full-text search
   */
  search(options: SearchOptions): SearchResult {
    const startTime = Date.now();
    const {
      query,
      page = 1,
      page_size = 20,
      sort_by = 'id',
      sort_order = 'asc',
      facets = ['issuer', 'credential_type', 'status', 'issuer_type'],
      owner,
    } = options;

    // Validate pagination
    const pageNum = Math.max(1, page);
    const pageSize = Math.min(100, Math.max(1, page_size));

    // Step 1: Apply filters
    let filtered = Array.from(this.credentials.values()).filter(cred => {
      // Permission-based filtering: filter by owner if provided
      if (owner && cred.owner && cred.owner !== owner) {
        return false;
      }

      // Type filter
      if (options.type !== undefined) {
        const types = Array.isArray(options.type) ? options.type : [options.type];
        if (!types.includes(cred.credential_type)) return false;
      }

      // Issuer filter
      if (options.issuer !== undefined) {
        const issuers = Array.isArray(options.issuer) ? options.issuer : [options.issuer];
        if (!issuers.includes(cred.issuer)) return false;
      }

      // Issuer type filter
      if (options.issuer_type !== undefined) {
        const issuerTypes = Array.isArray(options.issuer_type) ? options.issuer_type : [options.issuer_type];
        if (!issuerTypes.includes(cred.issuer_type || '')) return false;
      }

      // Subject filter
      if (options.subject !== undefined && cred.subject !== options.subject) {
        return false;
      }

      // Status filter
      if (options.status !== undefined) {
        if (options.status === 'revoked' && !cred.revoked) return false;
        if (options.status === 'suspended' && !cred.suspended) return false;
        if (options.status === 'active' && (cred.revoked || cred.suspended)) return false;
      }

      // Attestation count filters
      const attestCount = cred.attestation_count ?? 0;
      if (options.attestation_count_min !== undefined && attestCount < options.attestation_count_min) {
        return false;
      }
      if (options.attestation_count_max !== undefined && attestCount > options.attestation_count_max) {
        return false;
      }

      // Date range filters
      if (options.created_after) {
        const createdDate = parseDate(cred.created_at);
        const afterDate = parseDate(options.created_after);
        if (!createdDate || !afterDate || createdDate < afterDate) return false;
      }
      if (options.created_before) {
        const createdDate = parseDate(cred.created_at);
        const beforeDate = parseDate(options.created_before);
        if (!createdDate || !beforeDate || createdDate > beforeDate) return false;
      }
      if (options.expires_after) {
        const expiresDate = parseDate(cred.expires_at || undefined);
        const afterDate = parseDate(options.expires_after);
        if (!expiresDate || !afterDate || expiresDate < afterDate) return false;
      }
      if (options.expires_before) {
        const expiresDate = parseDate(cred.expires_at || undefined);
        const beforeDate = parseDate(options.expires_before);
        if (!expiresDate || !beforeDate || expiresDate > beforeDate) return false;
      }

      return true;
    });

    // Step 2: Apply full-text search with relevance scoring
    if (query) {
      const results = filtered.map(cred => ({
        cred,
        relevance: calculateRelevance(cred, query),
      }));
      // Filter out zero-relevance results
      filtered = results
        .filter(r => r.relevance > 0)
        .sort((a, b) => b.relevance - a.relevance)
        .map(r => r.cred);
    }

    // Step 3: Sort
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
        return sort_order === 'desc' ? bVal.localeCompare(aVal) : aVal.localeCompare(bVal);
      }
      return sort_order === 'desc' ? (bVal as number) - (aVal as number) : (aVal as number) - (bVal as number);
    });

    // Step 4: Calculate facets before pagination
    const facetData: Record<string, Map<string, number>> = {};
    for (const facetName of facets) {
      facetData[facetName] = new Map<string, number>();
    }

    for (const cred of filtered) {
      if (facets.includes('issuer')) {
        const count = facetData.issuer.get(cred.issuer) || 0;
        facetData.issuer.set(cred.issuer, count + 1);
      }
      if (facets.includes('credential_type')) {
        const typeStr = String(cred.credential_type);
        const count = facetData.credential_type.get(typeStr) || 0;
        facetData.credential_type.set(typeStr, count + 1);
      }
      if (facets.includes('status')) {
        let status = 'active';
        if (cred.revoked) status = 'revoked';
        if (cred.suspended) status = 'suspended';
        const count = facetData.status.get(status) || 0;
        facetData.status.set(status, count + 1);
      }
      if (facets.includes('issuer_type')) {
        const issuerType = cred.issuer_type || 'unknown';
        const count = facetData.issuer_type.get(issuerType) || 0;
        facetData.issuer_type.set(issuerType, count + 1);
      }
    }

    // Step 5: Paginate
    const total = filtered.length;
    const start = (pageNum - 1) * pageSize;
    const data = filtered.slice(start, start + pageSize);

    // Step 6: Build facet response
    const facetsResponse: SearchFacet[] = [];
    for (const facetName of facets) {
      const facetValues = facetData[facetName];
      if (facetValues.size > 0) {
        facetsResponse.push({
          name: facetName,
          values: Array.from(facetValues.entries())
            .map(([value, count]) => ({ value, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 50), // Limit to top 50 values per facet
        });
      }
    }

    const executionTime = Date.now() - startTime;

    return {
      data,
      facets: facetsResponse,
      pagination: {
        page: pageNum,
        page_size: pageSize,
        total,
        total_pages: Math.ceil(total / pageSize),
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
        execution_time_ms: executionTime,
      },
    };
  }

  /**
   * Get total number of indexed credentials
   */
  getIndexSize(): number {
    return this.credentials.size;
  }

  /**
   * Get last indexed timestamp
   */
  getLastIndexed(): Date | null {
    return this.lastIndexed;
  }

  /**
   * Clear the index
   */
  clear(): void {
    this.credentials.clear();
    this.lastIndexed = null;
  }
}

export default SearchIndex;
