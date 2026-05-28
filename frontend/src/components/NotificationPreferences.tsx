import { useNotification, type CredentialEventType } from '../context/NotificationContext';

const EVENT_LABELS: Record<CredentialEventType, string> = {
  issued: 'Credential Issued',
  revoked: 'Credential Revoked',
  verified: 'Credential Verified',
  disputed: 'Credential Disputed',
};

export function NotificationPreferences() {
  const { preferences, updatePreferences } = useNotification();

  return (
    <div className="notification-preferences" data-testid="notification-preferences">
      <h4 className="notification-preferences__title">Notification Preferences</h4>
      <p className="notification-preferences__desc">Choose which events you want to be notified about.</p>
      <ul className="notification-preferences__list">
        {(Object.keys(EVENT_LABELS) as CredentialEventType[]).map((event) => (
          <li key={event} className="notification-preferences__item">
            <label className="notification-preferences__label">
              <input
                type="checkbox"
                checked={preferences[event]}
                onChange={(e) => updatePreferences({ [event]: e.target.checked })}
                aria-label={`Enable ${EVENT_LABELS[event]} notifications`}
              />
              <span>{EVENT_LABELS[event]}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
