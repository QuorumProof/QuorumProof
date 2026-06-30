/**
 * Webhook Service — Issue #926
 * Registers, stores, and delivers webhook events with retry logic.
 *
 * Supported events: credential_issued, credential_attested, credential_revoked
 */

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

export interface WebhookDeliveryRecord {
  webhookId: string;
  event: string;
  status: 'success' | 'failed';
  attempts: number;
  lastAttemptAt: string;
  error?: string;
}

const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1_000, 5_000, 15_000];

const webhooks = new Map<string, WebhookRegistration>();
const deliveryLog: WebhookDeliveryRecord[] = [];

let idCounter = 0;
function nextId(): string {
  return `wh_${++idCounter}`;
}

export function registerWebhook(url: string, events: WebhookEvent[], secret?: string): WebhookRegistration {
  const reg: WebhookRegistration = {
    id: nextId(),
    url,
    events,
    secret,
    createdAt: new Date().toISOString(),
  };
  webhooks.set(reg.id, reg);
  return reg;
}

export function listWebhooks(): WebhookRegistration[] {
  return Array.from(webhooks.values());
}

export function getWebhook(id: string): WebhookRegistration | undefined {
  return webhooks.get(id);
}

export function deleteWebhook(id: string): boolean {
  return webhooks.delete(id);
}

export function getDeliveryLog(): WebhookDeliveryRecord[] {
  return deliveryLog;
}

/** Deliver payload to a single webhook with exponential-ish retry. */
async function deliverWithRetry(reg: WebhookRegistration, payload: WebhookPayload): Promise<void> {
  const record: WebhookDeliveryRecord = {
    webhookId: reg.id,
    event: payload.event,
    status: 'failed',
    attempts: 0,
    lastAttemptAt: new Date().toISOString(),
  };
  deliveryLog.push(record);

  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (reg.secret) {
    // simple HMAC-style signature header using Web Crypto (Node 18+)
    const { createHmac } = await import('crypto');
    headers['X-QuorumProof-Signature'] = `sha256=${createHmac('sha256', reg.secret).update(body).digest('hex')}`;
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));
    }
    record.attempts = attempt + 1;
    record.lastAttemptAt = new Date().toISOString();

    try {
      const res = await fetch(reg.url, { method: 'POST', headers, body });
      if (res.ok) {
        record.status = 'success';
        return;
      }
      record.error = `HTTP ${res.status}`;
    } catch (err: unknown) {
      record.error = err instanceof Error ? err.message : String(err);
    }
  }
  // status remains 'failed'
}

/** Called after broadcastEvent — fires webhooks subscribed to the event. */
export function dispatchWebhookEvent(payload: WebhookPayload): void {
  const event = payload.event as WebhookEvent;
  for (const reg of webhooks.values()) {
    if (reg.events.includes(event)) {
      // fire-and-forget; errors are captured in deliveryLog
      deliverWithRetry(reg, payload).catch(() => {/* already recorded */});
    }
  }
}

/** Reset state — for testing only. */
export function _resetForTest(): void {
  webhooks.clear();
  deliveryLog.length = 0;
  idCounter = 0;
}
