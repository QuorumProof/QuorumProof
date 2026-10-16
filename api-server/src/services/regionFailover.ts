/**
 * #1650 Multi-region failover detection.
 *
 * Each regional api-server deployment knows its own role (REGION_ROLE =
 * primary | secondary) and polls the peer region's /health/ready endpoint
 * (PEER_REGION_HEALTH_URL). DNS failover itself is performed by Route 53
 * health checks (infra/terraform/modules/failover); this detector gives each
 * region an independent, application-level view of the same event so that:
 *
 *   * the secondary knows when it has become the de-facto active region
 *     (surfaced at GET /health/region and as Prometheus metrics), and
 *   * operators get an alert from inside the application even if the
 *     CloudWatch → SNS path is itself affected by the outage.
 *
 * Peer state machine (hysteresis avoids flapping on a single slow probe):
 *
 *   unknown  --first probe-->                                   healthy | unhealthy
 *   healthy  --failureThreshold consecutive failures-->          unhealthy
 *   unhealthy --recoveryThreshold consecutive successes-->       healthy
 *
 * A secondary region whose peer (the primary) is `unhealthy` reports
 * `failoverActive: true`. Promotion of the database is NOT automatic — it is
 * an operator decision made with scripts/region_failover.sh, because an
 * automatic promotion during a network partition could cause split-brain.
 */

import { logger } from './logger.js';

export type RegionRole = 'primary' | 'secondary';
export type PeerState = 'unknown' | 'healthy' | 'unhealthy';

export interface RegionFailoverConfig {
  regionName: string;
  role: RegionRole;
  /** Peer region readiness URL. When empty the detector is disabled. */
  peerHealthUrl: string;
  intervalMs: number;
  timeoutMs: number;
  failureThreshold: number;
  recoveryThreshold: number;
  /** Optional webhook (Slack-compatible `{text}` payload) notified on transitions. */
  alertWebhookUrl?: string;
}

export interface RegionFailoverStatus {
  region: string;
  role: RegionRole;
  peer: {
    url: string;
    state: PeerState;
    consecutiveFailures: number;
    consecutiveSuccesses: number;
    lastCheckedAt: string | null;
    lastLatencyMs: number | null;
    lastError: string | null;
    lastTransitionAt: string | null;
  };
  /** True when this region is secondary and its primary peer is down. */
  failoverActive: boolean;
  totalFailovers: number;
}

export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

export type FailoverListener = (status: RegionFailoverStatus, previous: PeerState) => void;

function parseRole(raw: string | undefined): RegionRole {
  return raw === 'secondary' ? 'secondary' : 'primary';
}

function intFromEnv(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadRegionFailoverConfig(env: NodeJS.ProcessEnv = process.env): RegionFailoverConfig {
  return {
    regionName: env.REGION_NAME ?? 'local',
    role: parseRole(env.REGION_ROLE),
    peerHealthUrl: env.PEER_REGION_HEALTH_URL ?? '',
    intervalMs: intFromEnv(env.FAILOVER_CHECK_INTERVAL_MS, 10_000),
    timeoutMs: intFromEnv(env.FAILOVER_CHECK_TIMEOUT_MS, 3_000),
    failureThreshold: intFromEnv(env.FAILOVER_FAILURE_THRESHOLD, 3),
    recoveryThreshold: intFromEnv(env.FAILOVER_RECOVERY_THRESHOLD, 3),
    alertWebhookUrl: env.FAILOVER_ALERT_WEBHOOK_URL || undefined,
  };
}

export class RegionFailoverDetector {
  private readonly config: RegionFailoverConfig;
  private readonly fetchFn: FetchLike;
  private readonly listeners: FailoverListener[] = [];
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  private peerState: PeerState = 'unknown';
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private lastCheckedAt: Date | null = null;
  private lastLatencyMs: number | null = null;
  private lastError: string | null = null;
  private lastTransitionAt: Date | null = null;
  private totalFailovers = 0;

  constructor(config: RegionFailoverConfig, fetchFn: FetchLike = fetch as unknown as FetchLike) {
    this.config = config;
    this.fetchFn = fetchFn;
  }

  get enabled(): boolean {
    return this.config.peerHealthUrl !== '';
  }

  onTransition(listener: FailoverListener): void {
    this.listeners.push(listener);
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    logger.info('Region failover detector started', 'region-failover', {
      region: this.config.regionName,
      role: this.config.role,
      peer: this.config.peerHealthUrl,
      intervalMs: this.config.intervalMs,
    });
    void this.probe();
    this.timer = setInterval(() => void this.probe(), this.config.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Probe the peer once. Exposed for on-demand checks and tests. */
  async probe(): Promise<void> {
    if (!this.enabled || this.inFlight) return;
    this.inFlight = true;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const started = Date.now();

    try {
      const res = await this.fetchFn(this.config.peerHealthUrl, { signal: controller.signal });
      this.lastLatencyMs = Date.now() - started;
      if (res.ok) {
        this.recordSuccess();
      } else {
        this.recordFailure(`HTTP ${res.status}`);
      }
    } catch (err) {
      this.lastLatencyMs = Date.now() - started;
      this.recordFailure(controller.signal.aborted ? `timeout after ${this.config.timeoutMs}ms` : String(err));
    } finally {
      clearTimeout(timeout);
      this.lastCheckedAt = new Date();
      this.inFlight = false;
    }
  }

  private recordSuccess(): void {
    this.consecutiveSuccesses += 1;
    this.consecutiveFailures = 0;
    this.lastError = null;

    if (
      this.peerState === 'unknown' ||
      (this.peerState === 'unhealthy' && this.consecutiveSuccesses >= this.config.recoveryThreshold)
    ) {
      this.transition('healthy');
    }
  }

  private recordFailure(error: string): void {
    this.consecutiveFailures += 1;
    this.consecutiveSuccesses = 0;
    this.lastError = error;

    if (
      (this.peerState === 'unknown' || this.peerState === 'healthy') &&
      this.consecutiveFailures >= this.config.failureThreshold
    ) {
      this.transition('unhealthy');
    }
  }

  private transition(next: PeerState): void {
    const previous = this.peerState;
    if (previous === next) return;

    this.peerState = next;
    this.lastTransitionAt = new Date();

    const status = this.getStatus();
    if (status.failoverActive) this.totalFailovers += 1;

    const meta = { region: this.config.regionName, role: this.config.role, from: previous, to: next, lastError: this.lastError };
    if (next === 'unhealthy') {
      logger.error('Peer region unhealthy', 'region-failover', meta);
    } else if (previous !== 'unknown') {
      logger.warn('Peer region recovered', 'region-failover', meta);
    } else {
      logger.info('Peer region reachable', 'region-failover', meta);
    }

    for (const listener of this.listeners) {
      try {
        listener(this.getStatus(), previous);
      } catch (err) {
        logger.error('Region failover listener threw', 'region-failover', { error: String(err) });
      }
    }

    if (previous !== 'unknown' || next === 'unhealthy') void this.sendAlert(previous, next);
  }

  private async sendAlert(previous: PeerState, next: PeerState): Promise<void> {
    const url = this.config.alertWebhookUrl;
    if (!url) return;

    const { regionName, role } = this.config;
    const text =
      next === 'unhealthy'
        ? role === 'secondary'
          ? `:rotating_light: [${regionName}] Primary region is UNHEALTHY — DNS failover to this (secondary) region is expected. Last error: ${this.lastError}. Runbook: docs/multi-region-failover.md`
          : `:warning: [${regionName}] Secondary (standby) region is UNHEALTHY — failover capacity is lost. Last error: ${this.lastError}`
        : `:white_check_mark: [${regionName}] Peer region recovered (${previous} → ${next}).`;

    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
    } catch (err) {
      logger.error('Failed to send region failover alert', 'region-failover', { error: String(err) });
    }
  }

  getStatus(): RegionFailoverStatus {
    return {
      region: this.config.regionName,
      role: this.config.role,
      peer: {
        url: this.config.peerHealthUrl,
        state: this.peerState,
        consecutiveFailures: this.consecutiveFailures,
        consecutiveSuccesses: this.consecutiveSuccesses,
        lastCheckedAt: this.lastCheckedAt?.toISOString() ?? null,
        lastLatencyMs: this.lastLatencyMs,
        lastError: this.lastError,
        lastTransitionAt: this.lastTransitionAt?.toISOString() ?? null,
      },
      failoverActive: this.config.role === 'secondary' && this.peerState === 'unhealthy',
      totalFailovers: this.totalFailovers,
    };
  }

  /** Prometheus exposition for GET /health/region/metrics. */
  getPrometheusMetrics(): string {
    const s = this.getStatus();
    const labels = `region="${s.region}",role="${s.role}"`;
    const peerUp = s.peer.state === 'healthy' ? 1 : s.peer.state === 'unhealthy' ? 0 : -1;
    return [
      '# HELP quorumproof_region_peer_up Peer region readiness as seen from this region (1 up, 0 down, -1 unknown).',
      '# TYPE quorumproof_region_peer_up gauge',
      `quorumproof_region_peer_up{${labels}} ${peerUp}`,
      '# HELP quorumproof_region_failover_active 1 when this secondary region is serving because the primary is down.',
      '# TYPE quorumproof_region_failover_active gauge',
      `quorumproof_region_failover_active{${labels}} ${s.failoverActive ? 1 : 0}`,
      '# HELP quorumproof_region_peer_probe_latency_ms Latency of the last peer health probe.',
      '# TYPE quorumproof_region_peer_probe_latency_ms gauge',
      `quorumproof_region_peer_probe_latency_ms{${labels}} ${s.peer.lastLatencyMs ?? 0}`,
      '# HELP quorumproof_region_failovers_total Failover activations observed by this process.',
      '# TYPE quorumproof_region_failovers_total counter',
      `quorumproof_region_failovers_total{${labels}} ${s.totalFailovers}`,
      '',
    ].join('\n');
  }
}

let defaultDetector: RegionFailoverDetector | null = null;

export function getDefaultRegionFailoverDetector(): RegionFailoverDetector {
  if (!defaultDetector) defaultDetector = new RegionFailoverDetector(loadRegionFailoverConfig());
  return defaultDetector;
}
