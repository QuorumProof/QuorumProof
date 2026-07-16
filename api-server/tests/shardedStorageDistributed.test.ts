import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { ShardedCredentialStore, QuorumUnavailableError } from '../src/services/shardedStorage.js';

function makeCred(i: number) {
  return {
    id: `cred-${i}`,
    subject: `GSUBJECT${i}-${randomUUID()}`,
    issuer: 'GISSUER',
    credential_type: 1,
    revoked: false,
    suspended: false,
    expires_at: null,
    metadata_hash: 'h',
    version: 1,
  };
}

describe('ShardedCredentialStore resize (consistent hashing)', () => {
  let store: ShardedCredentialStore | undefined;
  afterEach(() => store?.close());

  it('remaps only ~1/N of keys when shard count grows by one, not ~100%', () => {
    store = new ShardedCredentialStore(8);
    const creds = Array.from({ length: 2000 }, (_, i) => makeCred(i));
    for (const c of creds) store!.set(c);

    const report = store.resize({ shardCount: 9 });

    expect(store.shardCount).toBe(9);
    expect(report.totalKeys).toBe(creds.length);
    // Rendezvous hashing guarantees an expected remap fraction of 1 - N/M = 1/9 ≈ 0.111
    // when growing from N=8 to M=9 candidates. Bounds below give ~8 sigma of headroom.
    expect(report.remapFraction).toBeGreaterThan(0.05);
    expect(report.remapFraction).toBeLessThan(0.2);
    // Sanity check against the bug being fixed: modulo hashing remaps nearly everything.
    expect(report.remapFraction).toBeLessThan(0.5);

    expect(store.totalSize).toBe(creds.length);
    for (const c of creds) {
      expect(store.get(c.id, c.subject)?.id).toBe(c.id);
    }
  });

  it('preserves all data and stays available while changing only the replication factor', () => {
    store = new ShardedCredentialStore(4, { replicationFactor: 3 });
    const cred = makeCred(1);
    store.set(cred);

    const report = store.resize({ replicationFactor: 5, writeQuorum: 3, readQuorum: 3 });

    expect(report.movedKeys).toBe(0); // shard count unchanged -> no partition remap
    expect(store.get(cred.id, cred.subject)?.id).toBe(cred.id);
  });
});

describe('ShardedCredentialStore replication & quorum', () => {
  let store: ShardedCredentialStore | undefined;
  afterEach(() => store?.close());

  it('keeps serving reads and writes via quorum after one of three replicas fails', () => {
    store = new ShardedCredentialStore(4, { replicationFactor: 3, writeQuorum: 2, readQuorum: 2 });
    const cred = makeCred(1);
    store.set(cred);
    const shardIndex = store.getShardIndex(cred.subject);

    store.simulateNodeFailure(shardIndex, 0);

    expect(store.get(cred.id, cred.subject)?.id).toBe(cred.id);
    expect(store.getBySubject(cred.subject)).toHaveLength(1);

    const cred2 = makeCred(2);
    store.set(cred2);
    expect(store.get(cred2.id, cred2.subject)?.id).toBe(cred2.id);

    store.restoreNode(shardIndex, 0);
  });

  it('throws QuorumUnavailableError once too many replicas of a shard are down', () => {
    store = new ShardedCredentialStore(4, { replicationFactor: 3, writeQuorum: 2, readQuorum: 2 });
    const cred = makeCred(3);
    store.set(cred);
    const shardIndex = store.getShardIndex(cred.subject);

    store.simulateNodeFailure(shardIndex, 0);
    store.simulateNodeFailure(shardIndex, 1);

    expect(() => store!.get(cred.id, cred.subject)).toThrow(QuorumUnavailableError);
  });
});

describe('ShardedCredentialStore persistence', () => {
  it('recovers data from disk when a new instance points at the same data directory', () => {
    const dataDir = path.join(os.tmpdir(), 'quorumproof-shards-test', randomUUID());
    const store1 = new ShardedCredentialStore(4, { dataDir });
    const cred = makeCred(42);
    store1.set(cred);

    const store2 = new ShardedCredentialStore(4, { dataDir });
    expect(store2.get(cred.id, cred.subject)?.id).toBe(cred.id);

    store1.close();
    store2.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});
