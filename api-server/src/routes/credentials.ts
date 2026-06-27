import { Router, Request, Response } from 'express';
import type { simulateCall as SimulateCallType } from '../soroban.js';
import { SearchIndex, type SearchOptions, type CredentialRecord as SearchCredentialRecord } from '../searchIndex.js';
import { MetadataHashCache } from '../services/metadataHashCache.js';

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

export function createCredentialsRouter(soroban: SorobanClient) {
  const router = Router();
  const searchIndex = new SearchIndex();
  const metadataHashCache = new MetadataHashCache();
  let indexedCredentials: Set<string> = new Set();

  /**
   * Helper function to populate the search index from Soroban
   */
  async function populateIndex(): Promise<void> {
    try {
      const credCount: bigint = await soroban.simulateCall('get_credential_count', []);
      const total = Number(credCount);

      const allCredentials: CredentialRecord[] = [];
      for (let i = 1; i <= total; i++) {
        try {
          const cred = await soroban.simulateCall('get_credential', [soroban.u64Val(i)]);
          const credRecord = serializeBigInt(cred) as CredentialRecord;
          // Ensure id is a string
          credRecord.id = String(credRecord.id || i);
          allCredentials.push(credRecord);
          indexedCredentials.add(credRecord.id);
          // Populate metadata hash cache
          metadataHashCache.set(credRecord.id, credRecord.metadata_hash, cred as Record<string, unknown>);
        } catch {
          // skip missing/expired credentials
        }
      }

      searchIndex.indexCredentials(allCredentials);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Failed to populate search index:', msg);
    }
  }

  /**
   * GET /api/credentials/search
   * Advanced search with filters, full-text search, and cursor-based pagination
   * Query params:
   *   - q: full-text search query
   *   - type: credential type (supports multiple: type=1&type=2)
   *   - issuer: issuer address (supports multiple)
   *   - issuer_type: issuer type (supports multiple)
   *   - subject: subject address
   *   - status: active|revoked|suspended
   *   - attestation_count_min, attestation_count_max: attestation count range
   *   - created_after, created_before: creation date range (ISO 8601)
   *   - expires_after, expires_before: expiration date range (ISO 8601)
   *   - cursor: base64-encoded cursor for pagination (from previous response)
   *   - limit: results per page (default: 20, max: 100)
   *   - sort_by: id|type|relevance|created_at|updated_at (default: id)
   *   - sort_order: asc|desc (default: asc)
   *   - facets: comma-separated facet names (default: issuer,credential_type,status,issuer_type)
   */
  router.get('/search', async (req: Request, res: Response) => {
    try {
      // Populate index on first search or if empty
      if (searchIndex.getIndexSize() === 0) {
        await populateIndex();
      }

      const {
        q,
        type,
        issuer,
        issuer_type,
        subject,
        status,
        attestation_count_min,
        attestation_count_max,
        created_after,
        created_before,
        expires_after,
        expires_before,
        cursor: cursorQ,
        limit: limitQ = '20',
        sort_by: sortBy = 'id',
        sort_order: sortOrder = 'asc',
        facets: facetsQ,
      } = req.query as Record<string, string>;

      // Validate limit
      const limitNum = parseInt(limitQ, 10);
      if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
        res.status(400).json({ error: 'limit must be between 1 and 100' });
        return;
      }

      // Validate sort parameters
      const validSortBy = ['id', 'type', 'relevance', 'created_at', 'updated_at'];
      if (!validSortBy.includes(sortBy)) {
        res.status(400).json({ error: `sort_by must be one of: ${validSortBy.join(', ')}` });
        return;
      }
      if (!['asc', 'desc'].includes(sortOrder)) {
        res.status(400).json({ error: 'sort_order must be "asc" or "desc"' });
        return;
      }

      // Parse facets
      const facets = (facetsQ || 'issuer,credential_type,status,issuer_type').split(',').map(f => f.trim());

      // Build search options
      const options: SearchOptions = {
        query: q,
        cursor: cursorQ,
        limit: limitNum,
        sort_by: (sortBy as any) || 'id',
        sort_order: (sortOrder as any) || 'asc',
        facets,
      };

      // Parse type filter (can be multiple)
      if (type) {
        const types = Array.isArray(type) ? type : [type];
        options.type = types.map(t => parseInt(t, 10)).filter(t => !isNaN(t));
        if (options.type.length === 1) {
          options.type = options.type[0];
        }
      }

      // Parse issuer filter (can be multiple)
      if (issuer) {
        options.issuer = Array.isArray(issuer) ? issuer : [issuer];
        if ((options.issuer as string[]).length === 1) {
          options.issuer = (options.issuer as string[])[0];
        }
      }

      // Parse issuer_type filter (can be multiple)
      if (issuer_type) {
        options.issuer_type = Array.isArray(issuer_type) ? issuer_type : [issuer_type];
        if ((options.issuer_type as string[]).length === 1) {
          options.issuer_type = (options.issuer_type as string[])[0];
        }
      }

      if (subject) options.subject = subject;
      if (status) options.status = status as 'active' | 'revoked' | 'suspended';
      if (attestation_count_min) options.attestation_count_min = parseInt(attestation_count_min, 10);
      if (attestation_count_max) options.attestation_count_max = parseInt(attestation_count_max, 10);
      if (created_after) options.created_after = created_after;
      if (created_before) options.created_before = created_before;
      if (expires_after) options.expires_after = expires_after;
      if (expires_before) options.expires_before = expires_before;

      // Execute search
      const result = searchIndex.search(options);

      res.json({
        data: result.data,
        facets: result.facets,
        pagination: result.pagination,
        query_info: result.query_info,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * POST /api/credentials/verify-batch
   * Body: { credential_ids: number[], slice_id: number }
   * Returns array of { credential_id, attested } results.
   */
  router.post('/verify-batch', async (req: Request, res: Response) => {
    const { credential_ids, slice_id } = req.body as {
      credential_ids?: unknown;
      slice_id?: unknown;
    };

    if (!Array.isArray(credential_ids) || credential_ids.length === 0) {
      res.status(400).json({ error: 'credential_ids must be a non-empty array' });
      return;
    }
    if (typeof slice_id !== 'number' || !Number.isInteger(slice_id) || slice_id <= 0) {
      res.status(400).json({ error: 'slice_id must be a positive integer' });
      return;
    }
    if (credential_ids.length > 50) {
      res.status(400).json({ error: 'credential_ids cannot exceed 50 items' });
      return;
    }
    for (const id of credential_ids) {
      if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: `Invalid credential_id: ${id}` });
        return;
      }
    }

    const results = await Promise.all(
      (credential_ids as number[]).map(async (credential_id) => {
        try {
          const attested: boolean = await soroban.simulateCall('is_attested', [
            soroban.u64Val(credential_id),
            soroban.u64Val(slice_id),
          ]);
          return { credential_id, attested: Boolean(attested), error: null };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return { credential_id, attested: false, error: msg };
        }
      })
    );

    res.json({ results: serializeBigInt(results) });
  });

  /**
   * POST /api/credentials/search/refresh-index
   * Force refresh of the search index from blockchain
   */
  router.post('/search/refresh-index', async (req: Request, res: Response) => {
    try {
      metadataHashCache.invalidateAll();
      await populateIndex();
      res.json({
        success: true,
        index_size: searchIndex.getIndexSize(),
        cache_size: metadataHashCache.size,
        last_indexed: searchIndex.getLastIndexed(),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * GET /api/credentials/search/index-stats
   * Get search index and metadata hash cache statistics
   */
  router.get('/search/index-stats', (_req: Request, res: Response) => {
    res.json({
      index_size: searchIndex.getIndexSize(),
      vocabulary_size: searchIndex.getVocabularySize(),
      cache_size: metadataHashCache.size,
      last_indexed: searchIndex.getLastIndexed(),
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * GET /api/credentials/:id/metadata-hash
   * Returns the cached metadata hash for a credential, fetching from chain if needed.
   */
  router.get('/:id/metadata-hash', async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid credential ID' });
      return;
    }

    const cached = metadataHashCache.get(String(id));
    if (cached) {
      res.json({ credential_id: id, metadata_hash: cached.metadata_hash, cached: true });
      return;
    }

    try {
      const cred = await soroban.simulateCall('get_credential', [soroban.u64Val(id)]);
      const record = serializeBigInt(cred) as CredentialRecord;
      metadataHashCache.set(String(id), record.metadata_hash, cred as Record<string, unknown>);
      res.json({ credential_id: id, metadata_hash: record.metadata_hash, cached: false });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('CredentialNotFound') || msg.includes('not found')) {
        res.status(404).json({ error: 'Credential not found' });
      } else {
        res.status(500).json({ error: msg });
      }
    }
  });

  return router;
}

// Default export using real soroban client
import { simulateCall, u64Val, u32Val, addressVal } from '../soroban.js';
export default createCredentialsRouter({
  simulateCall,
  u64Val: u64Val as SorobanClient['u64Val'],
  u32Val: u32Val as SorobanClient['u32Val'],
  addressVal: addressVal as SorobanClient['addressVal'],
});
