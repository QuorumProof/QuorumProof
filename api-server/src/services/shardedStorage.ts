import type { CredentialRecord } from '../searchIndex.js';

export interface ShardStats {
  shard_index: number;
  count: number;
}

function hashAddress(address: string): number {
  let h = 5381;
  for (let i = 0; i < address.length; i++) {
    h = ((h << 5) + h) ^ address.charCodeAt(i);
    h = h >>> 0;
  }
  return h;
}

export class ShardedCredentialStore {
  private shards: Map<string, CredentialRecord>[];
  readonly shardCount: number;

  constructor(shardCount = 8) {
    this.shardCount = shardCount;
    this.shards = Array.from({ length: shardCount }, () => new Map());
  }

  getShardIndex(subjectAddress: string): number {
    if (!subjectAddress) return 0;
    return hashAddress(subjectAddress) % this.shardCount;
  }

  set(credential: CredentialRecord): void {
    const idx = this.getShardIndex(credential.subject ?? '');
    this.shards[idx].set(credential.id, credential);
  }

  get(id: string, subjectAddress: string): CredentialRecord | undefined {
    const idx = this.getShardIndex(subjectAddress);
    return this.shards[idx].get(id);
  }

  getBySubject(subjectAddress: string): CredentialRecord[] {
    const idx = this.getShardIndex(subjectAddress);
    return Array.from(this.shards[idx].values()).filter(
      (c) => c.subject === subjectAddress,
    );
  }

  getAll(): CredentialRecord[] {
    return this.shards.flatMap((s) => Array.from(s.values()));
  }

  delete(id: string, subjectAddress: string): boolean {
    const idx = this.getShardIndex(subjectAddress);
    return this.shards[idx].delete(id);
  }

  clear(): void {
    for (const shard of this.shards) shard.clear();
  }

  getShardStats(): ShardStats[] {
    return this.shards.map((s, i) => ({ shard_index: i, count: s.size }));
  }

  get totalSize(): number {
    return this.shards.reduce((sum, s) => sum + s.size, 0);
  }
}
