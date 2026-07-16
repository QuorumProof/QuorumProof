import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import type { CredentialRecord } from '../searchIndex.js';
import { rendezvousSelect } from './rendezvousHash.js';

export interface ShardStats {
  shard_index: number;
  count: number;
}

export interface ShardedStoreOptions {
  /** Number of replica nodes (N) that mirror each shard's data. Default 3. */
  replicationFactor?: number;
  /** Replicas that must ack a write before it's considered durable (W). Default majority of N. */
  writeQuorum?: number;
  /** Replicas that must be consulted on a read before returning (R). Default majority of N. */
  readQuorum?: number;
  /** Directory each replica persists its write-ahead log under. Defaults to a unique temp directory,
   *  or SHARD_STORE_DATA_DIR if set, so a real path survives process restarts in production. */
  dataDir?: string;
}

export interface RebalanceOptions {
  shardCount?: number;
  replicationFactor?: number;
  writeQuorum?: number;
  readQuorum?: number;
}

export interface RebalanceReport {
  previousShardCount: number;
  newShardCount: number;
  previousReplicationFactor: number;
  newReplicationFactor: number;
  totalKeys: number;
  movedKeys: number;
  remapFraction: number;
}

export class QuorumUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuorumUnavailableError';
  }
}

interface StoredEntry {
  version: number;
  timestamp: number;
  tombstone: boolean;
  record?: CredentialRecord;
}

function validateQuorumConfig(replicationFactor: number, writeQuorum: number, readQuorum: number): void {
  if (replicationFactor < 1) {
    throw new Error('replicationFactor must be >= 1');
  }
  if (writeQuorum < 1 || writeQuorum > replicationFactor) {
    throw new Error(`writeQuorum must be between 1 and replicationFactor (${replicationFactor})`);
  }
  if (readQuorum < 1 || readQuorum > replicationFactor) {
    throw new Error(`readQuorum must be between 1 and replicationFactor (${replicationFactor})`);
  }
}

/**
 * One physical copy of a shard's data. Every write is appended to an
 * on-disk write-ahead log before the in-memory map is considered the
 * source of truth, so a fresh instance pointed at the same dataDir replays
 * the log and recovers state (e.g. after a process restart).
 */
class ReplicaNode {
  up = true;
  private readonly data = new Map<string, StoredEntry>();
  private readonly walPath: string;
  private walLines = 0;

  constructor(
    private readonly shardIndex: number,
    readonly nodeId: number,
    private readonly dataDir: string,
    private readonly generation: number,
  ) {
    fs.mkdirSync(this.dirPath(), { recursive: true });
    this.walPath = path.join(this.dirPath(), `node-${nodeId}.wal.jsonl`);
    this.load();
  }

  private dirPath(): string {
    return path.join(this.dataDir, `gen-${this.generation}`, `shard-${this.shardIndex}`);
  }

  private load(): void {
    if (!fs.existsSync(this.walPath)) return;
    const raw = fs.readFileSync(this.walPath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const { id, entry } = JSON.parse(line) as { id: string; entry: StoredEntry };
        this.data.set(id, entry);
        this.walLines++;
      } catch {
        // Tolerate a torn last line from a crash mid-append; every prior line is a complete record.
      }
    }
  }

  private compact(): void {
    const lines = Array.from(this.data.entries()).map(([id, entry]) => JSON.stringify({ id, entry }));
    fs.writeFileSync(this.walPath, lines.length ? lines.join('\n') + '\n' : '');
    this.walLines = lines.length;
  }

  writeEntry(id: string, entry: StoredEntry): void {
    this.data.set(id, entry);
    fs.appendFileSync(this.walPath, JSON.stringify({ id, entry }) + '\n');
    this.walLines++;
    if (this.walLines > Math.max(200, this.data.size * 4)) this.compact();
  }

  readEntry(id: string): StoredEntry | undefined {
    return this.data.get(id);
  }

  keys(): IterableIterator<string> {
    return this.data.keys();
  }

  clear(): void {
    this.data.clear();
    this.compact();
  }

  destroy(): void {
    try {
      fs.rmSync(this.dirPath(), { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

/** A partition of the keyspace, mirrored across `replicationFactor` independent ReplicaNodes. */
class Shard {
  readonly nodes: ReplicaNode[];

  constructor(readonly index: number, replicationFactor: number, dataDir: string, generation: number) {
    this.nodes = Array.from({ length: replicationFactor }, (_, nodeId) => new ReplicaNode(index, nodeId, dataDir, generation));
  }

  upNodes(): ReplicaNode[] {
    return this.nodes.filter((n) => n.up);
  }
}

export class ShardedCredentialStore {
  private shards: Shard[];
  private _shardCount: number;
  private replicationFactor: number;
  private writeQuorumSize: number;
  private readQuorumSize: number;
  private readonly dataDir: string;
  private generation = 0;
  private versionCounter = 0;

  constructor(shardCount = 8, options: ShardedStoreOptions = {}) {
    this._shardCount = shardCount;
    this.replicationFactor = options.replicationFactor ?? 3;
    this.writeQuorumSize = options.writeQuorum ?? Math.floor(this.replicationFactor / 2) + 1;
    this.readQuorumSize = options.readQuorum ?? Math.floor(this.replicationFactor / 2) + 1;
    validateQuorumConfig(this.replicationFactor, this.writeQuorumSize, this.readQuorumSize);

    this.dataDir = options.dataDir ?? process.env.SHARD_STORE_DATA_DIR ?? path.join(os.tmpdir(), 'quorumproof-shards', randomUUID());
    this.shards = this.buildShards(this._shardCount, this.replicationFactor, this.generation);
  }

  get shardCount(): number {
    return this._shardCount;
  }

  get totalSize(): number {
    return this.getShardStats().reduce((sum, s) => sum + s.count, 0);
  }

  private buildShards(shardCount: number, replicationFactor: number, generation: number): Shard[] {
    return Array.from({ length: shardCount }, (_, i) => new Shard(i, replicationFactor, this.dataDir, generation));
  }

  private shardKeys(shard: Shard): Set<string> {
    const ids = new Set<string>();
    for (const node of shard.upNodes()) {
      for (const id of node.keys()) ids.add(id);
    }
    return ids;
  }

  private quorumWrite(shard: Shard, id: string, entry: StoredEntry): void {
    const up = shard.upNodes();
    if (up.length < this.writeQuorumSize) {
      throw new QuorumUnavailableError(
        `write quorum unavailable for shard ${shard.index}: need ${this.writeQuorumSize} live replicas, have ${up.length}`,
      );
    }
    for (const node of up) node.writeEntry(id, entry);
  }

  private quorumRead(shard: Shard, id: string): StoredEntry | undefined {
    const up = shard.upNodes();
    if (up.length < this.readQuorumSize) {
      throw new QuorumUnavailableError(
        `read quorum unavailable for shard ${shard.index}: need ${this.readQuorumSize} live replicas, have ${up.length}`,
      );
    }
    const sample = up.slice(0, this.readQuorumSize);
    let best: StoredEntry | undefined;
    for (const node of sample) {
      const entry = node.readEntry(id);
      if (entry && (!best || entry.version > best.version)) best = entry;
    }
    if (best) {
      // Read repair: heal any live replica that is missing or behind the winning version.
      for (const node of up) {
        const entry = node.readEntry(id);
        if (!entry || entry.version < best.version) node.writeEntry(id, best);
      }
    }
    return best;
  }

  private shardIndexFor(subjectAddress: string, shardCount: number): number {
    if (!subjectAddress) return 0;
    return rendezvousSelect(subjectAddress, shardCount);
  }

  getShardIndex(subjectAddress: string): number {
    return this.shardIndexFor(subjectAddress, this._shardCount);
  }

  set(credential: CredentialRecord): void {
    const idx = this.getShardIndex(credential.subject ?? '');
    const entry: StoredEntry = { version: ++this.versionCounter, timestamp: Date.now(), tombstone: false, record: credential };
    this.quorumWrite(this.shards[idx], credential.id, entry);
  }

  get(id: string, subjectAddress: string): CredentialRecord | undefined {
    const idx = this.getShardIndex(subjectAddress);
    const entry = this.quorumRead(this.shards[idx], id);
    return entry && !entry.tombstone ? entry.record : undefined;
  }

  getBySubject(subjectAddress: string): CredentialRecord[] {
    const shard = this.shards[this.getShardIndex(subjectAddress)];
    const results: CredentialRecord[] = [];
    for (const id of this.shardKeys(shard)) {
      const entry = this.quorumRead(shard, id);
      if (entry && !entry.tombstone && entry.record?.subject === subjectAddress) {
        results.push(entry.record);
      }
    }
    return results;
  }

  getAll(): CredentialRecord[] {
    const results: CredentialRecord[] = [];
    for (const shard of this.shards) {
      for (const id of this.shardKeys(shard)) {
        const entry = this.quorumRead(shard, id);
        if (entry && !entry.tombstone && entry.record) results.push(entry.record);
      }
    }
    return results;
  }

  delete(id: string, subjectAddress: string): boolean {
    const shard = this.shards[this.getShardIndex(subjectAddress)];
    const existing = this.quorumRead(shard, id);
    const existed = !!existing && !existing.tombstone;
    const entry: StoredEntry = { version: ++this.versionCounter, timestamp: Date.now(), tombstone: true };
    this.quorumWrite(shard, id, entry);
    return existed;
  }

  clear(): void {
    for (const shard of this.shards) {
      for (const node of shard.nodes) node.clear();
    }
  }

  getShardStats(): ShardStats[] {
    return this.shards.map((shard, i) => {
      let count = 0;
      for (const id of this.shardKeys(shard)) {
        const entry = this.quorumRead(shard, id);
        if (entry && !entry.tombstone) count++;
      }
      return { shard_index: i, count };
    });
  }

  /** Marks a specific replica as unreachable, for failure-injection tests. */
  simulateNodeFailure(shardIndex: number, nodeId: number): void {
    const node = this.shards[shardIndex]?.nodes[nodeId];
    if (node) node.up = false;
  }

  restoreNode(shardIndex: number, nodeId: number): void {
    const node = this.shards[shardIndex]?.nodes[nodeId];
    if (node) node.up = true;
  }

  getReplicationStatus() {
    return this.shards.map((shard) => ({
      shard_index: shard.index,
      replication_factor: this.replicationFactor,
      write_quorum: this.writeQuorumSize,
      read_quorum: this.readQuorumSize,
      nodes: shard.nodes.map((n) => ({ node_id: n.nodeId, up: n.up })),
    }));
  }

  /**
   * Recomputes shard (and/or replica) placement and migrates data into a
   * freshly built layout, then atomically swaps it in. Because every step
   * here is synchronous with no `await`, no interleaved set/get call can
   * ever observe a torn state: callers see either the pre-resize or
   * post-resize layout in full, never a partial one — the single-process
   * equivalent of a zero-downtime cutover.
   */
  resize(options: RebalanceOptions): RebalanceReport {
    const newShardCount = options.shardCount ?? this._shardCount;
    const newReplicationFactor = options.replicationFactor ?? this.replicationFactor;
    const newWriteQuorum = options.writeQuorum ?? Math.floor(newReplicationFactor / 2) + 1;
    const newReadQuorum = options.readQuorum ?? Math.floor(newReplicationFactor / 2) + 1;
    validateQuorumConfig(newReplicationFactor, newWriteQuorum, newReadQuorum);

    const previousShardCount = this._shardCount;
    const previousReplicationFactor = this.replicationFactor;

    const snapshot: Array<{ id: string; entry: StoredEntry }> = [];
    for (const shard of this.shards) {
      for (const id of this.shardKeys(shard)) {
        const entry = this.quorumRead(shard, id);
        if (entry) snapshot.push({ id, entry });
      }
    }

    const newGeneration = this.generation + 1;
    const newShards = this.buildShards(newShardCount, newReplicationFactor, newGeneration);

    let moved = 0;
    for (const { id, entry } of snapshot) {
      const subject = entry.record?.subject ?? '';
      const oldIdx = this.shardIndexFor(subject, this._shardCount);
      const newIdx = this.shardIndexFor(subject, newShardCount);
      if (oldIdx !== newIdx) moved++;
      for (const node of newShards[newIdx].nodes) node.writeEntry(id, entry);
    }

    const oldShards = this.shards;

    this.shards = newShards;
    this._shardCount = newShardCount;
    this.replicationFactor = newReplicationFactor;
    this.writeQuorumSize = newWriteQuorum;
    this.readQuorumSize = newReadQuorum;
    this.generation = newGeneration;

    for (const shard of oldShards) {
      for (const node of shard.nodes) node.destroy();
    }

    return {
      previousShardCount,
      newShardCount,
      previousReplicationFactor,
      newReplicationFactor,
      totalKeys: snapshot.length,
      movedKeys: moved,
      remapFraction: snapshot.length ? moved / snapshot.length : 0,
    };
  }

  /** Releases every replica's on-disk state. Call in test teardown to avoid leaking temp files. */
  close(): void {
    for (const shard of this.shards) {
      for (const node of shard.nodes) node.destroy();
    }
  }
}
