import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { DurableLog } from './durableLog.js';
import type { CredentialRecord } from '../searchIndex.js';

/**
 * Durable, restart-surviving store for the credential records that back the
 * search index. Backed by DurableLog (fsync'd JSONL, replayed on load) — the
 * same primitive gdprRequestStore.ts/cryptoShredding.ts already use — so a
 * fresh process pointed at the same data dir recovers the full credential
 * set from local disk without re-fetching anything from the chain.
 */
export class SearchIndexStore {
  private readonly log: DurableLog<CredentialRecord>;

  constructor(dataDir?: string) {
    const dir =
      dataDir ?? process.env.SEARCH_INDEX_DATA_DIR ?? path.join(os.tmpdir(), 'quorumproof-search-index', randomUUID());
    this.log = new DurableLog<CredentialRecord>(path.join(dir, 'credentials.jsonl'));
  }

  set(cred: CredentialRecord): void {
    this.log.set(cred.id, cred);
  }

  get(id: string): CredentialRecord | undefined {
    return this.log.get(id);
  }

  delete(id: string): void {
    this.log.delete(id);
  }

  all(): CredentialRecord[] {
    return this.log.values();
  }

  size(): number {
    return this.log.keys().length;
  }
}

export default SearchIndexStore;
