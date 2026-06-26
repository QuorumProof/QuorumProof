type CacheEntry = {
  metadata_hash: string;
  credential: Record<string, unknown>;
  cachedAt: number;
};

export class MetadataHashCache {
  private cache: Map<string, CacheEntry>;
  private ttlMs: number;

  constructor(ttlMs = 300000) {
    this.cache = new Map();
    this.ttlMs = ttlMs;
  }

  get(credentialId: string): CacheEntry | undefined {
    const entry = this.cache.get(credentialId);
    if (!entry) return undefined;
    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.cache.delete(credentialId);
      return undefined;
    }
    return entry;
  }

  getMetadataHash(credentialId: string): string | undefined {
    return this.get(credentialId)?.metadata_hash;
  }

  set(credentialId: string, metadata_hash: string, credential: Record<string, unknown>): void {
    this.cache.set(credentialId, { metadata_hash, credential, cachedAt: Date.now() });
  }

  invalidate(credentialId: string): void {
    this.cache.delete(credentialId);
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.cachedAt > this.ttlMs) {
        this.cache.delete(key);
      }
    }
  }
}

export default MetadataHashCache;
