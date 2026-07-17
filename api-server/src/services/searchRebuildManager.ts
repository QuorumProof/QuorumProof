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
