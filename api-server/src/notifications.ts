/**
 * Credential Notification System (#550)
 *
 * Provides email/SMS notification dispatch, configurable preferences per address,
 * and an in-memory notification history store.
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
  message: string;
  sent_at: string;
  success: boolean;
  error?: string;
}

// In-memory stores (replace with a DB in production)
const preferencesStore = new Map<string, NotificationPreferences>();
const historyStore: NotificationRecord[] = [];
let notificationCounter = 0;

/** Build a human-readable message for a credential event. */
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

/**
 * Simulate sending an email notification.
 * Replace with a real provider (e.g. SendGrid, SES) in production.
 */
async function sendEmail(to: string, message: string): Promise<void> {
  // Stub: log to console; wire up a real email provider here.
  console.log(`[EMAIL] To: ${to} | ${message}`);
}

/**
 * Simulate sending an SMS notification.
 * Replace with a real provider (e.g. Twilio) in production.
 */
async function sendSms(phone: string, message: string): Promise<void> {
  // Stub: log to console; wire up a real SMS provider here.
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
  if (!prefs || !prefs.enabled || !prefs.events.includes(event)) return;

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
      event,
      channel,
      credential_id: credentialId,
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
