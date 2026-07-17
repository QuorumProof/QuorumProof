import React, { createContext, useContext, useState, useCallback, useRef, ReactNode } from 'react';

export type CredentialEventType = 'issued' | 'revoked' | 'verified' | 'disputed';

export interface Notification {
  id: string;
  title: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
  timestamp: Date;
  read: boolean;
  credentialId?: string;
  eventType?: CredentialEventType;
  /** When multiple events were batched, all credential IDs are listed here. */
  batchedCredentialIds?: string[];
  issuer?: string;
}

export type NotificationPreferences = Record<CredentialEventType, boolean>;

const DEFAULT_PREFERENCES: NotificationPreferences = {
  issued: true,
  revoked: true,
  verified: true,
  disputed: true,
};

/** Duration (ms) to wait before flushing batched notifications from the same issuer. */
export const BATCH_WINDOW_MS = 3_000;

interface PendingBatch {
  events: Array<{ credentialId: string; eventType: CredentialEventType; title: string; type: Notification['type'] }>;
  timer: ReturnType<typeof setTimeout>;
}

interface NotificationContextValue {
  notifications: Notification[];
  preferences: NotificationPreferences;
  addNotification: (notification: Omit<Notification, 'id' | 'timestamp' | 'read'>) => string;
  notifyCredentialIssued: (credentialId: string, credentialType?: string, issuer?: string) => void;
  notifyCredentialRevoked: (credentialId: string, issuer?: string) => void;
  notifyCredentialVerified: (credentialId: string, issuer?: string) => void;
  notifyCredentialDisputed: (credentialId: string, issuer?: string) => void;
  markAsRead: (id: string) => void;
  markAllAsRead: () => void;
  removeNotification: (id: string) => void;
  clearAll: () => void;
  updatePreferences: (prefs: Partial<NotificationPreferences>) => void;
  unreadCount: number;
}

const NotificationContext = createContext<NotificationContextValue | undefined>(undefined);

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [preferences, setPreferences] = useState<NotificationPreferences>(DEFAULT_PREFERENCES);
  const batchRef = useRef<Map<string, PendingBatch>>(new Map());

  const addNotification = useCallback((notification: Omit<Notification, 'id' | 'timestamp' | 'read'>): string => {
    const id = crypto.randomUUID();
    setNotifications((prev) => [{ ...notification, id, timestamp: new Date(), read: false }, ...prev]);
    return id;
  }, []);

  /** Queue an event for the given issuer. Flushes after BATCH_WINDOW_MS with no new events. */
  const queueBatchedNotification = useCallback((
    issuer: string,
    credentialId: string,
    eventType: CredentialEventType,
    title: string,
    type: Notification['type'],
  ) => {
    const batches = batchRef.current;
    const existing = batches.get(issuer);

    if (existing) {
      existing.events.push({ credentialId, eventType, title, type });
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => {
        const batch = batches.get(issuer);
        if (!batch) return;
        batches.delete(issuer);

        if (batch.events.length === 1) {
          const ev = batch.events[0];
          setNotifications((prev) => [{
            id: crypto.randomUUID(),
            title: ev.title,
            message: `Credential #${ev.credentialId} update from ${issuer}.`,
            type: ev.type,
            timestamp: new Date(),
            read: false,
            credentialId: ev.credentialId,
            eventType: ev.eventType,
            issuer,
          }, ...prev]);
        } else {
          const ids = batch.events.map((e) => e.credentialId);
          setNotifications((prev) => [{
            id: crypto.randomUUID(),
            title: `${batch.events.length} updates from ${issuer}`,
            message: `Credentials ${ids.map((id) => `#${id}`).join(', ')} were updated by ${issuer}.`,
            type: batch.events.some((e) => e.type === 'error') ? 'error'
              : batch.events.some((e) => e.type === 'warning') ? 'warning' : 'info',
            timestamp: new Date(),
            read: false,
            credentialId: ids[0],
            batchedCredentialIds: ids,
            issuer,
          }, ...prev]);
        }
      }, BATCH_WINDOW_MS);
    } else {
      const timer = setTimeout(() => {
        const batch = batches.get(issuer);
        if (!batch) return;
        batches.delete(issuer);

        if (batch.events.length === 1) {
          const ev = batch.events[0];
          setNotifications((prev) => [{
            id: crypto.randomUUID(),
            title: ev.title,
            message: `Credential #${ev.credentialId} update from ${issuer}.`,
            type: ev.type,
            timestamp: new Date(),
            read: false,
            credentialId: ev.credentialId,
            eventType: ev.eventType,
            issuer,
          }, ...prev]);
        } else {
          const ids = batch.events.map((e) => e.credentialId);
          setNotifications((prev) => [{
            id: crypto.randomUUID(),
            title: `${batch.events.length} updates from ${issuer}`,
            message: `Credentials ${ids.map((id) => `#${id}`).join(', ')} were updated by ${issuer}.`,
            type: batch.events.some((e) => e.type === 'error') ? 'error'
              : batch.events.some((e) => e.type === 'warning') ? 'warning' : 'info',
            timestamp: new Date(),
            read: false,
            credentialId: ids[0],
            batchedCredentialIds: ids,
            issuer,
          }, ...prev]);
        }
      }, BATCH_WINDOW_MS);
      batches.set(issuer, { events: [{ credentialId, eventType, title, type }], timer });
    }
  }, []);

  const notifyCredentialIssued = useCallback((credentialId: string, credentialType?: string, issuer?: string) => {
    if (!preferences.issued) return;
    const title = 'Credential Issued';
    const message = credentialType
      ? `Your ${credentialType} credential has been issued.`
      : `Credential #${credentialId} has been issued.`;

    if (issuer) {
      queueBatchedNotification(issuer, credentialId, 'issued', title, 'success');
    } else {
      addNotification({ title, message, type: 'success', credentialId, eventType: 'issued' });
    }
  }, [preferences.issued, addNotification, queueBatchedNotification]);

  const notifyCredentialRevoked = useCallback((credentialId: string, issuer?: string) => {
    if (!preferences.revoked) return;
    const title = 'Credential Revoked';

    if (issuer) {
      queueBatchedNotification(issuer, credentialId, 'revoked', title, 'error');
    } else {
      addNotification({ title, message: `Credential #${credentialId} has been revoked.`, type: 'error', credentialId, eventType: 'revoked' });
    }
  }, [preferences.revoked, addNotification, queueBatchedNotification]);

  const notifyCredentialVerified = useCallback((credentialId: string, issuer?: string) => {
    if (!preferences.verified) return;
    const title = 'Credential Verified';

    if (issuer) {
      queueBatchedNotification(issuer, credentialId, 'verified', title, 'success');
    } else {
      addNotification({ title, message: `Credential #${credentialId} has been successfully verified.`, type: 'success', credentialId, eventType: 'verified' });
    }
  }, [preferences.verified, addNotification, queueBatchedNotification]);

  const notifyCredentialDisputed = useCallback((credentialId: string, issuer?: string) => {
    if (!preferences.disputed) return;
    const title = 'Credential Disputed';

    if (issuer) {
      queueBatchedNotification(issuer, credentialId, 'disputed', title, 'warning');
    } else {
      addNotification({ title, message: `Credential #${credentialId} has been disputed and is under review.`, type: 'warning', credentialId, eventType: 'disputed' });
    }
  }, [preferences.disputed, addNotification, queueBatchedNotification]);

  const markAsRead = useCallback((id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
  }, []);

  const markAllAsRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }, []);

  const removeNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const clearAll = useCallback(() => {
    setNotifications([]);
  }, []);

  const updatePreferences = useCallback((prefs: Partial<NotificationPreferences>) => {
    setPreferences((prev) => ({ ...prev, ...prefs }));
  }, []);

  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <NotificationContext.Provider
      value={{
        notifications,
        preferences,
        addNotification,
        notifyCredentialIssued,
        notifyCredentialRevoked,
        notifyCredentialVerified,
        notifyCredentialDisputed,
        markAsRead,
        markAllAsRead,
        removeNotification,
        clearAll,
        updatePreferences,
        unreadCount,
      }}
    >
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotification(): NotificationContextValue {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error('useNotification must be used within NotificationProvider');
  return ctx;
}
