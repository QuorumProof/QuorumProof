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
 *
 * A holder_id -> [sbt_ids] reverse index is maintained alongside the primary
 * store so SBTs can be looked up directly by holder without scanning every
 * record. The index is rebuilt from the primary store on construction
 * (migration for existing data) and kept in sync on every mutation.
 */
export class SearchIndexStore {
  private readonly log: DurableLog<CredentialRecord>;
  private readonly holderIndex: Map<string, Set<string>> = new Map();

  constructor(dataDir?: string) {
    const dir =
      dataDir ?? process.env.SEARCH_INDEX_DATA_DIR ?? path.join(os.tmpdir(), 'quorumproof-search-index', randomUUID());
    this.log = new DurableLog<CredentialRecord>(path.join(dir, 'credentials.jsonl'));
    this.rebuildIndex();
  }

  set(cred: CredentialRecord): void {
    const existing = this.log.get(cred.id);
    if (existing) {
      this.removeFromIndex(existing);
    }
    this.log.set(cred.id, cred);
    this.addToIndex(cred);
  }

  get(id: string): CredentialRecord | undefined {
    return this.log.get(id);
  }

  delete(id: string): void {
    const existing = this.log.get(id);
    if (existing) {
      this.removeFromIndex(existing);
    }
    this.log.delete(id);
  }

  all(): CredentialRecord[] {
    return this.log.values();
  }

  size(): number {
    return this.log.keys().length;
  }

  /**
   * Direct lookup of SBT ids held by a given holder via the reverse index.
   */
  getByHolder(holderId: string): string[] {
    const ids = this.holderIndex.get(holderId);
    return ids ? Array.from(ids) : [];
  }

  /**
   * Rebuild the reverse index from the primary store. Used on construction to
   * migrate existing data and available for explicit reconciliation.
   */
  rebuildIndex(): void {
    this.holderIndex.clear();
    for (const cred of this.log.values()) {
      this.addToIndex(cred);
    }
  }

  /**
   * Consistency check: verify the reverse index matches the primary store and
   * reconcile any drift. Returns true when the index was already consistent.
   */
  checkConsistency(): boolean {
    const expected = new Map<string, Set<string>>();
    for (const cred of this.log.values()) {
      const holder = this.holderOf(cred);
      if (!holder) continue;
      let set = expected.get(holder);
      if (!set) {
        set = new Set();
        expected.set(holder, set);
      }
      set.add(cred.id);
    }

    let consistent = expected.size === this.holderIndex.size;
    if (consistent) {
      for (const [holder, ids] of expected) {
        const current = this.holderIndex.get(holder);
        if (!current || current.size !== ids.size) {
          consistent = false;
          break;
        }
        for (const id of ids) {
          if (!current.has(id)) {
            consistent = false;
            break;
          }
        }
        if (!consistent) break;
      }
    }

    if (!consistent) {
      this.holderIndex.clear();
      for (const [holder, ids] of expected) {
        this.holderIndex.set(holder, ids);
      }
    }

    return consistent;
  }

  private holderOf(cred: CredentialRecord): string | undefined {
    const holder = (cred as { holder?: unknown }).holder;
    return typeof holder === 'string' && holder.length > 0 ? holder : undefined;
  }

  private addToIndex(cred: CredentialRecord): void {
    const holder = this.holderOf(cred);
    if (!holder) return;
    let ids = this.holderIndex.get(holder);
    if (!ids) {
      ids = new Set();
      this.holderIndex.set(holder, ids);
    }
    ids.add(cred.id);
  }

  private removeFromIndex(cred: CredentialRecord): void {
    const holder = this.holderOf(cred);
    if (!holder) return;
    const ids = this.holderIndex.get(holder);
    if (!ids) return;
    ids.delete(cred.id);
    if (ids.size === 0) {
      this.holderIndex.delete(holder);
    }
  }
}

export default SearchIndexStore;
