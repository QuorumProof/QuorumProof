import { useState, useRef, useEffect } from 'react';
import { useNotification } from '../context/NotificationContextValue';

const TYPE_ICON: Record<string, { symbol: string; label: string }> = {
  success: { symbol: '✓', label: 'Success' },
  error:   { symbol: '✕', label: 'Error' },
  warning: { symbol: '⚠', label: 'Warning' },
  info:    { symbol: 'ℹ', label: 'Info' },
};

function getTypeIcon(type: string) {
  return TYPE_ICON[type] ?? TYPE_ICON.info;
}

const TYPE_COLOR: Record<string, string> = {
  success: '#10b981',
  error:   '#ef4444',
  warning: '#f59e0b',
  info:    '#3b82f6',
};

function getTypeColor(type: string): string {
  return TYPE_COLOR[type] ?? TYPE_COLOR.info;
}

function formatTime(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours   = Math.floor(diff / 3600000);
  const days    = Math.floor(diff / 86400000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

export function NotificationCenter() {
  const {
    notifications,
    markAsRead,
    markAllAsRead,
    removeNotification,
    clearAll,
    unreadCount,
  } = useNotification();

  const [isOpen, setIsOpen] = useState(false);

  // Track the most-recently added notification ID so we can
  // announce only new arrivals via the live region.
  const prevTopIdRef = useRef<string | undefined>(undefined);
  const [liveMessage, setLiveMessage] = useState('');

  useEffect(() => {
    const topNotif = notifications[0];
    if (!topNotif) return;
    if (topNotif.id !== prevTopIdRef.current) {
      prevTopIdRef.current = topNotif.id;
      // Only announce when the panel is closed; if it's open the user can
      // see the list update directly.
      if (!isOpen) {
        setLiveMessage(`${topNotif.title}: ${topNotif.message}`);
        // Clear after announcement so the same text can be re-announced
        // if the identical message arrives again.
        const t = setTimeout(() => setLiveMessage(''), 5000);
        return () => clearTimeout(t);
      }
    }
  }, [notifications, isOpen]);

  const bellLabel = unreadCount > 0
    ? `Notifications, ${unreadCount} unread`
    : 'Notifications';

  return (
    <div className="notification-center">
      {/* Visually hidden live region — announces new notifications to screen readers */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: 'hidden',
          clip: 'rect(0,0,0,0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      >
        {liveMessage}
      </div>

      <button
        className="notification-bell"
        onClick={() => setIsOpen(!isOpen)}
        aria-label={bellLabel}
        aria-expanded={isOpen}
        aria-haspopup="true"
      >
        <span aria-hidden="true">🔔</span>
        {unreadCount > 0 && (
          <span
            className="notification-badge"
            aria-label={`${unreadCount} unread notification${unreadCount === 1 ? '' : 's'}`}
          >
            {unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div
          className="notification-panel"
          role="region"
          aria-label="Notifications panel"
        >
          <div className="notification-header">
            <h3 id="notification-panel-title">Notifications</h3>
            <div className="notification-actions">
              {unreadCount > 0 && (
                <button
                  className="btn btn--ghost btn--xs"
                  onClick={markAllAsRead}
                  aria-label="Mark all notifications as read"
                >
                  Mark all read
                </button>
              )}
              {notifications.length > 0 && (
                <button
                  className="btn btn--ghost btn--xs"
                  onClick={clearAll}
                  aria-label="Clear all notifications"
                >
                  Clear all
                </button>
              )}
            </div>
          </div>

          {/* Alert live region inside the panel — announces items while the panel is open */}
          <div
            role="alert"
            aria-live="polite"
            aria-atomic="true"
            className="notification-list"
          >
            {notifications.length === 0 ? (
              <div className="notification-empty">
                <p>No notifications</p>
              </div>
            ) : (
              notifications.map((notif) => {
                const icon = getTypeIcon(notif.type);
                return (
                  <div
                    key={notif.id}
                    className={`notification-item ${notif.read ? 'read' : 'unread'}`}
                    onClick={() => markAsRead(notif.id)}
                  >
                    <div
                      className="notification-icon"
                      style={{ color: getTypeColor(notif.type) }}
                      aria-label={icon.label}
                      role="img"
                    >
                      {icon.symbol}
                    </div>
                    <div className="notification-content">
                      <div className="notification-title">{notif.title}</div>
                      <div className="notification-message">{notif.message}</div>
                      <div className="notification-time">{formatTime(notif.timestamp)}</div>
                    </div>
                    <button
                      className="notification-close"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeNotification(notif.id);
                      }}
                      aria-label={`Dismiss notification: ${notif.title}`}
                    >
                      ×
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
