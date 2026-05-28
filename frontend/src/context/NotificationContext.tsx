import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';

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
}

export type NotificationPreferences = Record<CredentialEventType, boolean>;

const DEFAULT_PREFERENCES: NotificationPreferences = {
  issued: true,
  revoked: true,
  verified: true,
  disputed: true,
};

interface NotificationContextValue {
  notifications: Notification[];
  preferences: NotificationPreferences;
  addNotification: (notification: Omit<Notification, 'id' | 'timestamp' | 'read'>) => string;
  notifyCredentialIssued: (credentialId: string, credentialType?: string) => void;
  notifyCredentialRevoked: (credentialId: string) => void;
  notifyCredentialVerified: (credentialId: string) => void;
  notifyCredentialDisputed: (credentialId: string) => void;
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

  const addNotification = useCallback((notification: Omit<Notification, 'id' | 'timestamp' | 'read'>): string => {
    const id = crypto.randomUUID();
    const newNotification: Notification = {
      ...notification,
      id,
      timestamp: new Date(),
      read: false,
    };
    setNotifications((prev) => [newNotification, ...prev]);
    return id;
  }, []);

  const notifyCredentialIssued = useCallback((credentialId: string, credentialType?: string) => {
    if (!preferences.issued) return;
    addNotification({
      title: 'Credential Issued',
      message: credentialType
        ? `Your ${credentialType} credential has been issued.`
        : `Credential #${credentialId} has been issued.`,
      type: 'success',
      credentialId,
      eventType: 'issued',
    });
  }, [preferences.issued, addNotification]);

  const notifyCredentialRevoked = useCallback((credentialId: string) => {
    if (!preferences.revoked) return;
    addNotification({
      title: 'Credential Revoked',
      message: `Credential #${credentialId} has been revoked.`,
      type: 'error',
      credentialId,
      eventType: 'revoked',
    });
  }, [preferences.revoked, addNotification]);

  const notifyCredentialVerified = useCallback((credentialId: string) => {
    if (!preferences.verified) return;
    addNotification({
      title: 'Credential Verified',
      message: `Credential #${credentialId} has been successfully verified.`,
      type: 'success',
      credentialId,
      eventType: 'verified',
    });
  }, [preferences.verified, addNotification]);

  const notifyCredentialDisputed = useCallback((credentialId: string) => {
    if (!preferences.disputed) return;
    addNotification({
      title: 'Credential Disputed',
      message: `Credential #${credentialId} has been disputed and is under review.`,
      type: 'warning',
      credentialId,
      eventType: 'disputed',
    });
  }, [preferences.disputed, addNotification]);

  const markAsRead = useCallback((id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n))
    );
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
