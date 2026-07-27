/**
 * Monitors QuorumProof contract events for security-relevant activity
 * (revocations, disputes, upgrades) and dispatches alerts (issue #3).
 *
 * Critical contract events previously weren't monitored at all — an
 * operator would only learn a credential had been revoked, a dispute
 * raised, or (most sensitively) the contract upgraded, by manually
 * querying state or noticing it in the analytics dashboard. This polls
 * Soroban RPC's `getEvents` for the contract, classifies each event's
 * first topic against the critical-event patterns below, and pushes a
 * real-time alert via `alertChannels.ts` the moment a match is seen —
 * independent of and faster than the Prometheus scrape-interval alerts in
 * `monitoring/prometheus/alerts.yml`.
 */
import path from 'path';
import { rpc as StellarRpc, scValToNative } from '@stellar/stellar-sdk';
import { DurableLog } from './durableLog.js';
import { dispatchAlert, type AlertSeverity } from './alertChannels.js';

export type CriticalEventCategory = 'revocation' | 'dispute' | 'upgrade';

/**
 * Topic-name patterns, matched case-insensitively against the decoded
 * first topic of every contract event. Substring/regex matching (rather
 * than an exact enum of topic strings) is deliberate: the contract emits
 * topics like "RevokeCredential", "DelegationRevoked", "RoleRevoked",
 * "UpgradeValidated", "MigrationProgress", "MetadataSchemaUpgraded" — an
 * exact list would silently miss new revocation/upgrade-shaped events
 * added to the contract later.
 */
const CRITICAL_TOPIC_PATTERNS: Record<CriticalEventCategory, RegExp> = {
  revocation: /revok|suspend/i,
  dispute: /disput/i,
  upgrade: /upgrad|migrat/i,
};

const CATEGORY_SEVERITY: Record<CriticalEventCategory, AlertSeverity> = {
  revocation: 'warning',
  dispute: 'critical',
  upgrade: 'critical',
};

export function classifyTopic(topic: string): CriticalEventCategory | null {
  for (const [category, pattern] of Object.entries(CRITICAL_TOPIC_PATTERNS) as [CriticalEventCategory, RegExp][]) {
    if (pattern.test(topic)) return category;
  }
  return null;
}

export interface CriticalContractEvent {
  id: string;
  category: CriticalEventCategory;
  topic: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  contractId?: string;
  decodedValue?: unknown;
}

interface ListenerRecord {
  cursor?: string;
}

export interface CriticalEventListenerMetrics {
  running: boolean;
  totalEventsScanned: number;
  totalCriticalEvents: number;
  byCategory: Record<CriticalEventCategory, number>;
  totalAlertsDispatched: number;
  totalAlertFailures: number;
  lastPollAt: string | null;
  lastCriticalEventAt: string | null;
  lastError: string | null;
}

export interface CriticalEventListenerOptions {
  dataDir?: string;
  contractId?: string;
  server?: StellarRpc.Server;
  pollIntervalMs?: number;
  /** How many recent critical events to keep in memory for GET /events/critical/recent. */
  recentEventsLimit?: number;
}

export class CriticalEventListener {
  private readonly log: DurableLog<ListenerRecord>;
  private readonly contractId: string;
  private readonly server?: StellarRpc.Server;
  private readonly pollIntervalMs: number;
  private readonly recentEventsLimit: number;
  private timer: NodeJS.Timeout | null = null;
  private recentEvents: CriticalContractEvent[] = [];

  private totalEventsScanned = 0;
  private totalCriticalEvents = 0;
  private byCategory: Record<CriticalEventCategory, number> = { revocation: 0, dispute: 0, upgrade: 0 };
  private totalAlertsDispatched = 0;
  private totalAlertFailures = 0;
  private lastPollAt: number | null = null;
  private lastCriticalEventAt: number | null = null;
  private lastError: string | null = null;

  constructor(options: CriticalEventListenerOptions = {}) {
    const dataDir = options.dataDir ?? process.env.EVENT_LISTENER_DATA_DIR ?? path.join(process.cwd(), '.data', 'events');
    this.log = new DurableLog<ListenerRecord>(path.join(dataDir, 'critical-event-cursor.jsonl'));
    this.contractId = options.contractId ?? process.env.CONTRACT_QUORUM_PROOF ?? '';
    this.server =
      options.server ??
      (this.contractId
        ? new StellarRpc.Server(process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org')
        : undefined);
    this.pollIntervalMs = options.pollIntervalMs ?? parseInt(process.env.EVENT_LISTENER_POLL_MS ?? '15000', 10);
    this.recentEventsLimit = options.recentEventsLimit ?? 200;
  }

  private getCursor(): string | undefined {
    return this.log.get('cursor')?.cursor;
  }

  private setCursor(cursor: string): void {
    this.log.set('cursor', { cursor });
  }

  getMetrics(): CriticalEventListenerMetrics {
    return {
      running: this.timer !== null,
      totalEventsScanned: this.totalEventsScanned,
      totalCriticalEvents: this.totalCriticalEvents,
      byCategory: { ...this.byCategory },
      totalAlertsDispatched: this.totalAlertsDispatched,
      totalAlertFailures: this.totalAlertFailures,
      lastPollAt: this.lastPollAt ? new Date(this.lastPollAt).toISOString() : null,
      lastCriticalEventAt: this.lastCriticalEventAt ? new Date(this.lastCriticalEventAt).toISOString() : null,
      lastError: this.lastError,
    };
  }

  getMetricsPrometheus(): string {
    const lines = [
      '# HELP quorumproof_critical_events_total Critical contract events observed, by category',
      '# TYPE quorumproof_critical_events_total counter',
      ...(Object.entries(this.byCategory) as [CriticalEventCategory, number][]).map(
        ([category, count]) => `quorumproof_critical_events_total{category="${category}"} ${count}`
      ),
      '# HELP quorumproof_critical_event_alerts_dispatched_total Alerts successfully dispatched to at least one channel',
      '# TYPE quorumproof_critical_event_alerts_dispatched_total counter',
      `quorumproof_critical_event_alerts_dispatched_total ${this.totalAlertsDispatched}`,
      '# HELP quorumproof_critical_event_alert_failures_total Alert dispatch attempts where every channel failed',
      '# TYPE quorumproof_critical_event_alert_failures_total counter',
      `quorumproof_critical_event_alert_failures_total ${this.totalAlertFailures}`,
    ];
    return lines.join('\n') + '\n';
  }

  getRecentEvents(): CriticalContractEvent[] {
    return [...this.recentEvents];
  }

  /** Process one already-fetched raw event. Exported at instance level for direct/unit testing without a live RPC round-trip. */
  async processEvent(raw: {
    id: string;
    topic: unknown[];
    value: unknown;
    ledger: number;
    ledgerClosedAt: string;
    txHash: string;
    contractId?: { toString(): string };
  }): Promise<CriticalContractEvent | null> {
    this.totalEventsScanned++;
    let topicStr: string;
    try {
      const decoded = scValToNative(raw.topic[0] as Parameters<typeof scValToNative>[0]);
      topicStr = String(decoded);
    } catch {
      return null;
    }

    const category = classifyTopic(topicStr);
    if (!category) return null;

    let decodedValue: unknown;
    try {
      decodedValue = scValToNative(raw.value as Parameters<typeof scValToNative>[0]);
    } catch {
      decodedValue = undefined;
    }

    const event: CriticalContractEvent = {
      id: raw.id,
      category,
      topic: topicStr,
      ledger: raw.ledger,
      ledgerClosedAt: raw.ledgerClosedAt,
      txHash: raw.txHash,
      contractId: raw.contractId?.toString(),
      decodedValue,
    };

    this.totalCriticalEvents++;
    this.byCategory[category]++;
    this.lastCriticalEventAt = Date.now();
    this.recentEvents.unshift(event);
    if (this.recentEvents.length > this.recentEventsLimit) this.recentEvents.length = this.recentEventsLimit;

    const results = await dispatchAlert({
      title: `${category.toUpperCase()}: ${topicStr}`,
      description: `Critical contract event "${topicStr}" (${category}) observed on ledger ${event.ledger}, tx ${event.txHash}.`,
      severity: CATEGORY_SEVERITY[category],
      dedupKey: event.id,
      metadata: { ledger: event.ledger, txHash: event.txHash, decodedValue },
    });
    if (results.some((r) => r.ok)) this.totalAlertsDispatched++;
    else this.totalAlertFailures++;

    return event;
  }

  /** One poll cycle against real RPC. No-ops if contractId/server aren't configured. */
  async poll(): Promise<void> {
    if (!this.contractId || !this.server) return;
    this.lastPollAt = Date.now();
    try {
      const cursor = this.getCursor();
      const response = await this.server.getEvents({
        filters: [{ type: 'contract', contractIds: [this.contractId] }],
        ...(cursor ? { cursor } : { startLedger: 0 }),
        limit: 100,
      });
      for (const evt of response.events) {
        await this.processEvent({
          id: evt.id,
          topic: evt.topic,
          value: evt.value,
          ledger: evt.ledger,
          ledgerClosedAt: evt.ledgerClosedAt,
          txHash: evt.txHash,
          contractId: evt.contractId,
        });
        this.setCursor(evt.pagingToken);
      }
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

let defaultListener: CriticalEventListener | undefined;

export function getDefaultCriticalEventListener(): CriticalEventListener {
  if (!defaultListener) defaultListener = new CriticalEventListener();
  return defaultListener;
}

export function _setDefaultCriticalEventListenerForTest(listener: CriticalEventListener | undefined): void {
  defaultListener = listener;
}
