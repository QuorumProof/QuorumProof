import { createContext, useContext } from 'react';

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

export const DEFAULT_PREFERENCES: NotificationPreferences = {
  issued: true,
  revoked: true,
  verified: true,
  disputed: true,
};

/** Duration (ms) to wait before flushing batched notifications from the same issuer. */
export const BATCH_WINDOW_MS = 3_000;

export interface PendingBatch {
  events: Array<{ credentialId: string; eventType: CredentialEventType; title: string; type: Notification['type'] }>;
  timer: ReturnType<typeof setTimeout>;
}

export interface NotificationContextValue {
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

export const NotificationContext = createContext<NotificationContextValue | undefined>(undefined);

export function useNotification(): NotificationContextValue {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error('useNotification must be used within NotificationProvider');
  return ctx;
}
