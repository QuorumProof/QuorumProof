/**
 * Sliding-window per-minute metrics for the real-time credential issuance dashboard.
 *
 * Each instance's buckets are local. To keep the dashboard consistent across
 * replicas, record*() calls notify an optional delta publisher (wired by
 * ws/dashboardSync.ts to the pub/sub backbone in api-server/src/ws/pubsub.ts);
 * other instances receive the delta and apply it via applyRemoteDelta(),
 * which does NOT re-publish, so deltas don't loop.
 */

const WINDOW_MINUTES = 60;

export type DashboardDeltaKind = 'issuance' | 'attestation' | 'api_error';

export interface DashboardDelta {
  kind: DashboardDeltaKind;
  /** Only meaningful for kind 'attestation'. */
  success?: boolean;
}

type DeltaPublisher = (delta: DashboardDelta) => void;

interface MinuteBucket {
  minute: number;
  issued: number;
  attested: number;
  attestation_errors: number;
  api_errors: number;
}

export interface LiveDashboardStats {
  /** 60-element array of issuance counts, index 0 = oldest minute, index 59 = current minute. */
  issuances_per_minute: number[];
  /** Attestation success rate over the last 5 minutes, null when no data. */
  attestation_success_rate: number | null;
  /** Total errors (API + attestation) recorded in the current minute. */
  errors_last_minute: number;
  timestamp: string;
}

class LiveDashboardStore {
  private readonly buckets = new Map<number, MinuteBucket>();
  private deltaPublisher: DeltaPublisher | null = null;

  /** Wired once at startup by ws/dashboardSync.ts; a no-op in single-instance mode. */
  setDeltaPublisher(fn: DeltaPublisher | null): void {
    this.deltaPublisher = fn;
  }

  private nowMinute(): number {
    return Math.floor(Date.now() / 60_000);
  }

  private getBucket(minute: number): MinuteBucket {
    if (!this.buckets.has(minute)) {
      this.buckets.set(minute, { minute, issued: 0, attested: 0, attestation_errors: 0, api_errors: 0 });
      this.evict(minute);
    }
    return this.buckets.get(minute)!;
  }

  private evict(now: number): void {
    const cutoff = now - WINDOW_MINUTES;
    for (const k of this.buckets.keys()) {
      if (k < cutoff) this.buckets.delete(k);
    }
  }

  recordIssuance(): void {
    this.getBucket(this.nowMinute()).issued++;
    this.deltaPublisher?.({ kind: 'issuance' });
  }

  recordAttestation(success: boolean): void {
    const b = this.getBucket(this.nowMinute());
    if (success) b.attested++;
    else b.attestation_errors++;
    this.deltaPublisher?.({ kind: 'attestation', success });
  }

  recordApiError(): void {
    this.getBucket(this.nowMinute()).api_errors++;
    this.deltaPublisher?.({ kind: 'api_error' });
  }

  /** Applies a delta received from another instance. Never re-publishes. */
  applyRemoteDelta(delta: DashboardDelta): void {
    const b = this.getBucket(this.nowMinute());
    switch (delta.kind) {
      case 'issuance':
        b.issued++;
        break;
      case 'attestation':
        if (delta.success) b.attested++;
        else b.attestation_errors++;
        break;
      case 'api_error':
        b.api_errors++;
        break;
    }
  }

  getStats(): LiveDashboardStats {
    const now = this.nowMinute();

    const issuances_per_minute: number[] = [];
    for (let i = WINDOW_MINUTES - 1; i >= 0; i--) {
      issuances_per_minute.push(this.buckets.get(now - i)?.issued ?? 0);
    }

    let totalAttested = 0;
    let totalAttestErrors = 0;
    for (let i = 4; i >= 0; i--) {
      const b = this.buckets.get(now - i);
      if (b) {
        totalAttested += b.attested;
        totalAttestErrors += b.attestation_errors;
      }
    }
    const attestationTotal = totalAttested + totalAttestErrors;
    const attestation_success_rate = attestationTotal > 0 ? totalAttested / attestationTotal : null;

    const cur = this.buckets.get(now);
    const errors_last_minute = (cur?.api_errors ?? 0) + (cur?.attestation_errors ?? 0);

    return {
      issuances_per_minute,
      attestation_success_rate,
      errors_last_minute,
      timestamp: new Date().toISOString(),
    };
  }

  reset(): void {
    this.buckets.clear();
  }
}

export const liveDashboard = new LiveDashboardStore();
