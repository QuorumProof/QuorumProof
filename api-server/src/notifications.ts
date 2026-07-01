/**
 * Credential Notification System (#550)
 *
 * Provides email/SMS notification dispatch, configurable preferences per address,
 * an in-memory notification history store, and batching of events from the same
 * issuer within a configurable time window.
 */

export type NotificationChannel = 'email' | 'sms';

export type NotificationEvent =
  | 'credential_issued'
  | 'credential_revoked'
  | 'credential_suspended'
  | 'credential_attested'
  | 'credential_expiring';

export interface NotificationPreferences {
  address: string;
  email?: string;
  phone?: string;
  channels: NotificationChannel[];
  events: NotificationEvent[];
  /** Optional allowlist of credential types (e.g. 1=Degree, 2=License, 3=Employment).
   *  When set, notifications are only dispatched for credentials whose type is in this list.
   *  When absent or empty, all credential types are notified. */
  credential_type_filters?: number[];
  enabled: boolean;
}

export interface NotificationRecord {
  id: string;
  address: string;
  event: NotificationEvent;
  channel: NotificationChannel;
  credential_id: number;
  /** When batched, contains all credential IDs in the batch (undefined for single notifications). */
  batched_credential_ids?: number[];
  issuer?: string;
  message: string;
  sent_at: string;
  success: boolean;
  error?: string;
}

interface BatchEntry {
  events: Array<{ event: NotificationEvent; credentialId: number }>;
  timer: ReturnType<typeof setTimeout>;
}

// In-memory stores (replace with a DB in production)
const preferencesStore = new Map<string, NotificationPreferences>();
const historyStore: NotificationRecord[] = [];
let notificationCounter = 0;

/** Batch key: "<address>:<issuer>" */
const batchStore = new Map<string, BatchEntry>();

/** Time window (ms) during which events from the same issuer are grouped. */
export const BATCH_WINDOW_MS = 5_000;

/** Build a human-readable message for a single credential event. */
function buildMessage(event: NotificationEvent, credentialId: number): string {
  switch (event) {
    case 'credential_issued':
      return `Your credential #${credentialId} has been issued.`;
    case 'credential_revoked':
      return `Your credential #${credentialId} has been revoked.`;
    case 'credential_suspended':
      return `Your credential #${credentialId} has been suspended.`;
    case 'credential_attested':
      return `Your credential #${credentialId} received a new attestation.`;
    case 'credential_expiring':
      return `Your credential #${credentialId} is expiring soon. Please renew.`;
  }
}

/** Build a human-readable message summarising a batch of credential events. */
function buildBatchMessage(
  events: Array<{ event: NotificationEvent; credentialId: number }>,
  issuer?: string
): string {
  const ids = events.map((e) => `#${e.credentialId}`).join(', ');
  const prefix = issuer ? `From ${issuer}: ` : '';
  return `${prefix}${events.length} credential updates for credentials ${ids}.`;
}

/**
 * Simulate sending an email notification.
 * Replace with a real provider (e.g. SendGrid, SES) in production.
 */
async function sendEmail(to: string, message: string): Promise<void> {
  console.log(`[EMAIL] To: ${to} | ${message}`);
}

/**
 * Simulate sending an SMS notification.
 * Replace with a real provider (e.g. Twilio) in production.
 */
async function sendSms(phone: string, message: string): Promise<void> {
  console.log(`[SMS] To: ${phone} | ${message}`);
}

/**
 * Dispatch notifications for a credential event to all subscribers whose
 * preferences include the given address and event type.
 * @param credentialType optional credential type number; used to filter against
 *   per-preference `credential_type_filters` (issue #928).
 */
export async function dispatchNotification(
  address: string,
  event: NotificationEvent,
  credentialId: number,
  credentialType?: number
): Promise<void> {
  const prefs = preferencesStore.get(address);
  if (!prefs || !prefs.enabled) return;

  // Only include events the user cares about
  const relevant = entry.events.filter((e) => prefs.events.includes(e.event));
  if (relevant.length === 0) return;

  // #928: skip if user has type filters and this credential type isn't in them
  if (
    credentialType !== undefined &&
    prefs.credential_type_filters &&
    prefs.credential_type_filters.length > 0 &&
    !prefs.credential_type_filters.includes(credentialType)
  ) return;

  const message = buildMessage(event, credentialId);

  for (const channel of prefs.channels) {
    const record: NotificationRecord = {
      id: String(++notificationCounter),
      address,
      event: relevant[0].event,
      channel,
      credential_id: relevant[0].credentialId,
      batched_credential_ids: relevant.length > 1 ? relevant.map((e) => e.credentialId) : undefined,
      issuer,
      message,
      sent_at: new Date().toISOString(),
      success: false,
    };

    try {
      if (channel === 'email' && prefs.email) {
        await sendEmail(prefs.email, message);
        record.success = true;
      } else if (channel === 'sms' && prefs.phone) {
        await sendSms(prefs.phone, message);
        record.success = true;
      }
    } catch (err) {
      record.error = err instanceof Error ? err.message : String(err);
    }

    historyStore.push(record);
  }
}

/**
 * Dispatch a notification for a credential event.  Events from the same issuer
 * arriving within BATCH_WINDOW_MS are grouped into a single notification.
 *
 * @param address      Stellar address of the credential holder.
 * @param event        The credential lifecycle event.
 * @param credentialId The credential being affected.
 * @param issuer       Optional issuer identity used as the batch grouping key.
 */
export async function dispatchNotification(
  address: string,
  event: NotificationEvent,
  credentialId: number,
  issuer?: string
): Promise<void> {
  const prefs = preferencesStore.get(address);
  if (!prefs || !prefs.enabled || !prefs.events.includes(event)) return;

  const batchKey = `${address}:${issuer ?? ''}`;
  const existing = batchStore.get(batchKey);

  if (existing) {
    // Extend the batch with the new event and reset the window timer
    existing.events.push({ event, credentialId });
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => flushBatch(address, issuer, batchKey), BATCH_WINDOW_MS);
  } else {
    // Start a new batch window
    const timer = setTimeout(() => flushBatch(address, issuer, batchKey), BATCH_WINDOW_MS);
    batchStore.set(batchKey, { events: [{ event, credentialId }], timer });
  }
}

/**
 * Immediately flush any pending batch for the given address/issuer pair.
 * Useful in tests or when an explicit "send now" is needed.
 */
export async function flushPendingBatch(address: string, issuer?: string): Promise<void> {
  const batchKey = `${address}:${issuer ?? ''}`;
  await flushBatch(address, issuer, batchKey);
}

/** Upsert notification preferences for an address. */
export function setPreferences(prefs: NotificationPreferences): void {
  preferencesStore.set(prefs.address, {
    ...prefs,
    credential_type_filters: prefs.credential_type_filters ?? [],
  });
}

/** Retrieve notification preferences for an address. */
export function getPreferences(address: string): NotificationPreferences | undefined {
  return preferencesStore.get(address);
}

/** Retrieve notification history, optionally filtered by address. */
export function getHistory(address?: string): NotificationRecord[] {
  if (address) return historyStore.filter((r) => r.address === address);
  return [...historyStore];
}

/** Clear all in-memory state (useful for test isolation). */
export function _resetStores(): void {
  preferencesStore.clear();
  historyStore.length = 0;
  notificationCounter = 0;
  for (const entry of batchStore.values()) clearTimeout(entry.timer);
  batchStore.clear();
}
