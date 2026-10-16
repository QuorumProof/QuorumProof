import { randomUUID } from 'crypto';

export type RebuildStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface RebuildProgress {
  credentials_processed: number;
  total_credentials: number;
}

export interface RebuildJob {
  rebuild_id: string;
  status: RebuildStatus;
  started_at: string;
  estimated_duration_ms: number;
  progress?: RebuildProgress;
  completed_at?: string;
  duration_ms?: number;
  credentials_indexed?: number;
  error?: string;
}

/**
 * Reverse index mapping a holder id to the set of SBT ids it owns, so SBTs can
 * be looked up directly by holder instead of scanning every SBT. The index is
 * kept in sync as SBTs are added/removed and can be rebuilt from the primary
 * store (migration / drift reconciliation).
 */
export class SbtReverseIndex {
  private holderToSbts = new Map<string, Set<string>>();
  private sbtToHolder = new Map<string, string>();

  /** Direct lookup: all SBT ids held by `holderId` (empty array if none). */
  getSbtIds(holderId: string): string[] {
    const set = this.holderToSbts.get(holderId);
    return set ? Array.from(set) : [];
  }

  /** Index maintenance: record that `sbtId` is held by `holderId`. */
  add(holderId: string, sbtId: string): void {
    const previous = this.sbtToHolder.get(sbtId);
    if (previous === holderId) return;
    if (previous !== undefined) this.remove(previous, sbtId);

    let set = this.holderToSbts.get(holderId);
    if (!set) {
      set = new Set<string>();
      this.holderToSbts.set(holderId, set);
    }
    set.add(sbtId);
    this.sbtToHolder.set(sbtId, holderId);
  }

  /** Index maintenance: drop `sbtId` from `holderId`'s entry. */
  remove(holderId: string, sbtId: string): void {
    const set = this.holderToSbts.get(holderId);
    if (set) {
      set.delete(sbtId);
      if (set.size === 0) this.holderToSbts.delete(holderId);
    }
    if (this.sbtToHolder.get(sbtId) === holderId) this.sbtToHolder.delete(sbtId);
  }

  /**
   * Consistency check: compare the reverse index against the authoritative
   * SBT store and report any drift (missing, stale, or mis-assigned entries).
   */
  checkConsistency(sbts: Array<{ sbt_id: string; holder_id: string }>): {
    consistent: boolean;
    missing: Array<{ sbt_id: string; holder_id: string }>;
    stale: Array<{ sbt_id: string; holder_id: string }>;
  } {
    const expected = new Map<string, string>();
    for (const sbt of sbts) expected.set(sbt.sbt_id, sbt.holder_id);

    const missing: Array<{ sbt_id: string; holder_id: string }> = [];
    for (const sbt of sbts) {
      if (this.sbtToHolder.get(sbt.sbt_id) !== sbt.holder_id) {
        missing.push({ sbt_id: sbt.sbt_id, holder_id: sbt.holder_id });
      }
    }

    const stale: Array<{ sbt_id: string; holder_id: string }> = [];
    for (const [sbtId, holderId] of this.sbtToHolder) {
      if (expected.get(sbtId) !== holderId) {
        stale.push({ sbt_id: sbtId, holder_id: holderId });
      }
    }

    return { consistent: missing.length === 0 && stale.length === 0, missing, stale };
  }

  /**
   * Migration / reconciliation: rebuild the reverse index from the primary SBT
   * store, discarding any prior state. Returns the number of SBTs indexed.
   */
  rebuild(sbts: Array<{ sbt_id: string; holder_id: string }>): number {
    this.holderToSbts.clear();
    this.sbtToHolder.clear();
    for (const sbt of sbts) this.add(sbt.holder_id, sbt.sbt_id);
    return this.sbtToHolder.size;
  }
}

const MAX_HISTORY = 20;

/**
 * Tracks background index-rebuild jobs so a rebuild can run without blocking
 * request handling. `start()` returns synchronously with status 'queued' —
 * the caller-supplied `run` function only begins executing after the current
 * synchronous call stack (i.e. the HTTP handler that queued it) completes,
 * so the 202 response always observes 'queued', never a later status.
 *
 * The old index stays live and queryable for the whole run: `run` is
 * responsible for building a new index off to the side and only swapping it
 * in once fully built (mirrors the atomic-swap pattern
 * ShardedCredentialStore.resize() already uses for zero-downtime cutover).
 */
export class SearchRebuildManager {
  private jobs = new Map<string, RebuildJob>();
  private history: string[] = [];
  private activeId: string | null = null;

  isActive(): boolean {
    if (!this.activeId) return false;
    const job = this.jobs.get(this.activeId);
    return !!job && (job.status === 'queued' || job.status === 'processing');
  }

  start(
    estimatedDurationMs: number,
    run: (onProgress: (processed: number, total: number) => void) => Promise<number>,
  ): RebuildJob | null {
    if (this.isActive()) return null;

    const rebuild_id = randomUUID();
    const job: RebuildJob = {
      rebuild_id,
      status: 'queued',
      started_at: new Date().toISOString(),
      estimated_duration_ms: estimatedDurationMs,
    };
    this.jobs.set(rebuild_id, job);
    this.activeId = rebuild_id;
    this.history.unshift(rebuild_id);
    if (this.history.length > MAX_HISTORY) this.history.pop();

    const startedAt = Date.now();
    void (async () => {
      await Promise.resolve(); // yield so the 202 response reads status:'queued' first
      job.status = 'processing';
      job.progress = { credentials_processed: 0, total_credentials: 0 };
      try {
        const count = await run((processed, total) => {
          job.progress = { credentials_processed: processed, total_credentials: total };
        });
        job.status = 'completed';
        job.completed_at = new Date().toISOString();
        job.duration_ms = Date.now() - startedAt;
        job.credentials_indexed = count;
      } catch (err) {
        job.status = 'failed';
        job.error = err instanceof Error ? err.message : String(err);
        job.completed_at = new Date().toISOString();
        job.duration_ms = Date.now() - startedAt;
      } finally {
        if (this.activeId === rebuild_id) this.activeId = null;
      }
    })();

    return job;
  }

  getStatus(id: string): RebuildJob | undefined {
    return this.jobs.get(id);
  }

  getHistory(): RebuildJob[] {
    return this.history.map(id => this.jobs.get(id)).filter((j): j is RebuildJob => !!j);
  }
}

export default SearchRebuildManager;
