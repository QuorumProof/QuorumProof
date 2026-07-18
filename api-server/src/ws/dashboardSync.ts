/**
 * Cross-instance replication for the live dashboard (liveDashboard.ts).
 *
 * Every instance keeps its own local sliding-window buckets. When this
 * instance records an issuance/attestation/error, the delta is also
 * published on DASHBOARD_DELTA_CHANNEL; every instance (including this one's
 * own subscription, which is skipped via instanceId) applies remote deltas
 * to its local store. Dashboard subscribers therefore see an eventually
 * consistent, cluster-wide view regardless of which instance they're
 * connected to — the same filter/subscription model as ws/subscriptions.ts,
 * just applied to aggregate stats instead of per-connection events.
 */
import type { PubSubBackend } from './pubsub.js';
import { liveDashboard, type DashboardDelta } from '../services/liveDashboard.js';
import { instanceId } from './instanceId.js';
import { recordCrossInstanceMessageReceived, recordCrossInstanceMessagePublished } from './metrics.js';

export const DASHBOARD_DELTA_CHANNEL = 'ws:dashboard-delta';

interface DashboardDeltaEnvelope {
  publishedBy: string;
  delta: DashboardDelta;
}

let wired = false;

export function initDashboardSync(backend: PubSubBackend): void {
  if (wired) return;
  wired = true;

  liveDashboard.setDeltaPublisher((delta) => {
    const envelope: DashboardDeltaEnvelope = { publishedBy: instanceId, delta };
    backend.publish(DASHBOARD_DELTA_CHANNEL, JSON.stringify(envelope));
    recordCrossInstanceMessagePublished();
  });

  backend.subscribe(DASHBOARD_DELTA_CHANNEL, (raw) => {
    let envelope: DashboardDeltaEnvelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      return;
    }
    if (envelope.publishedBy === instanceId) return; // already applied locally by recordX()
    liveDashboard.applyRemoteDelta(envelope.delta);
    recordCrossInstanceMessageReceived();
  });
}

/** Test-only: undo initDashboardSync() wiring. */
export function _resetDashboardSyncForTest(): void {
  wired = false;
  liveDashboard.setDeltaPublisher(null);
}
