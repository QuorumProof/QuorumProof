/**
 * Durable storage for webhook registrations and deliveries — Issue #926.
 *
 * Backed by the same append-only JSONL WAL (DurableLog) used by
 * GdprRequestStore: every write is fsync'd before being considered durable,
 * so registrations and in-flight (pending) deliveries survive a process
 * restart or crash. A delivery record's key is its idempotency key, so
 * replaying the log after a restart reconstructs exactly the last known
 * attempt/status for every delivery that hadn't reached a terminal state.
 */
import path from 'path';
import { DurableLog } from './durableLog.js';

export type WebhookEvent = 'credential_issued' | 'credential_attested' | 'credential_revoked';

export interface WebhookRegistration {
  id: string;
  url: string;
  events: WebhookEvent[];
  secret?: string;
  createdAt: string;
}

export interface WebhookPayload {
  event: string;
  credential_id: number;
  issuer?: string;
  holder?: string;
  attestor?: string;
  timestamp: string;
}

export type DeliveryStatus = 'pending' | 'success' | 'dead_letter';

export interface DeliveryRecord {
  /** Stable idempotency key, sent as X-QuorumProof-Delivery-Id on every attempt for this delivery. */
  id: string;
  webhookId: string;
  credentialId: number;
  event: string;
  payload: WebhookPayload;
  /** Ordering partition: deliveries sharing an orderKey are delivered strictly in `sequence` order. */
  orderKey: string;
  sequence: number;
  status: DeliveryStatus;
  attempts: number;
  lastAttemptAt?: string;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

export function orderKeyFor(webhookId: string, credentialId: number): string {
  return `${webhookId}:${credentialId}`;
}

export interface WebhookStoreOptions {
  dataDir?: string;
}

const REG_ID_PATTERN = /^wh_(\d+)$/;
const DELIVERY_ID_PATTERN = /^dlv_(\d+)$/;

export class WebhookStore {
  readonly dataDir: string;
  private readonly registrations: DurableLog<WebhookRegistration>;
  private readonly deliveries: DurableLog<DeliveryRecord>;
  private regCounter: number;
  private deliveryCounter: number;
  private readonly sequenceCounters = new Map<string, number>();

  constructor(options: WebhookStoreOptions = {}) {
    const dataDir = options.dataDir ?? process.env.WEBHOOK_STORE_DATA_DIR ?? path.join(process.cwd(), '.data', 'webhooks');
    this.dataDir = dataDir;
    this.registrations = new DurableLog<WebhookRegistration>(path.join(dataDir, 'registrations.jsonl'));
    this.deliveries = new DurableLog<DeliveryRecord>(path.join(dataDir, 'deliveries.jsonl'));
    this.regCounter = this.recoverCounter(this.registrations.keys(), REG_ID_PATTERN);
    this.deliveryCounter = this.recoverCounter(this.deliveries.keys(), DELIVERY_ID_PATTERN);
    for (const rec of this.deliveries.values()) {
      const cur = this.sequenceCounters.get(rec.orderKey) ?? 0;
      if (rec.sequence > cur) this.sequenceCounters.set(rec.orderKey, rec.sequence);
    }
  }

  private recoverCounter(keys: string[], pattern: RegExp): number {
    let max = 0;
    for (const key of keys) {
      const match = pattern.exec(key);
      if (match) max = Math.max(max, parseInt(match[1], 10));
    }
    return max;
  }

  // ── Registrations ────────────────────────────────────────────────────────

  registerWebhook(url: string, events: WebhookEvent[], secret?: string): WebhookRegistration {
    this.regCounter += 1;
    const reg: WebhookRegistration = {
      id: `wh_${this.regCounter}`,
      url,
      events,
      secret,
      createdAt: new Date().toISOString(),
    };
    this.registrations.set(reg.id, reg);
    return reg;
  }

  listWebhooks(): WebhookRegistration[] {
    return this.registrations.values();
  }

  getWebhook(id: string): WebhookRegistration | undefined {
    return this.registrations.get(id);
  }

  deleteWebhook(id: string): boolean {
    if (!this.registrations.has(id)) return false;
    this.registrations.delete(id);
    return true;
  }

  // ── Deliveries ───────────────────────────────────────────────────────────

  /** Allocate a new delivery in strict order for its (webhookId, credentialId) partition. */
  createDelivery(webhookId: string, credentialId: number, event: string, payload: WebhookPayload): DeliveryRecord {
    this.deliveryCounter += 1;
    const orderKey = orderKeyFor(webhookId, credentialId);
    const sequence = (this.sequenceCounters.get(orderKey) ?? 0) + 1;
    this.sequenceCounters.set(orderKey, sequence);

    const record: DeliveryRecord = {
      id: `dlv_${this.deliveryCounter}`,
      webhookId,
      credentialId,
      event,
      payload,
      orderKey,
      sequence,
      status: 'pending',
      attempts: 0,
      createdAt: new Date().toISOString(),
    };
    this.deliveries.set(record.id, record);
    return record;
  }

  saveDelivery(record: DeliveryRecord): void {
    this.deliveries.set(record.id, record);
  }

  getDelivery(id: string): DeliveryRecord | undefined {
    return this.deliveries.get(id);
  }

  listDeliveries(): DeliveryRecord[] {
    return this.deliveries.values();
  }

  /** Pending deliveries, grouped and sorted by (orderKey, sequence) — the order they must be retried in. */
  listPendingByOrderKey(): Map<string, DeliveryRecord[]> {
    const byKey = new Map<string, DeliveryRecord[]>();
    for (const rec of this.deliveries.values()) {
      if (rec.status !== 'pending') continue;
      const list = byKey.get(rec.orderKey) ?? [];
      list.push(rec);
      byKey.set(rec.orderKey, list);
    }
    for (const list of byKey.values()) list.sort((a, b) => a.sequence - b.sequence);
    return byKey;
  }

  listDeadLetters(): DeliveryRecord[] {
    return this.deliveries.values().filter(rec => rec.status === 'dead_letter');
  }

  /** Reset state — for testing only. */
  _resetForTest(): void {
    for (const key of this.registrations.keys()) this.registrations.delete(key);
    for (const key of this.deliveries.keys()) this.deliveries.delete(key);
    this.regCounter = 0;
    this.deliveryCounter = 0;
    this.sequenceCounters.clear();
  }
}

let defaultStore: WebhookStore | undefined;

export function getDefaultWebhookStore(): WebhookStore {
  if (!defaultStore) defaultStore = new WebhookStore();
  return defaultStore;
}

/** Test-only: force the module to construct a fresh default store (e.g. pointed at a new dataDir). */
export function _setDefaultWebhookStoreForTest(store: WebhookStore | undefined): void {
  defaultStore = store;
}
