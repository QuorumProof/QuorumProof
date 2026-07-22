import type { Credential } from '../lib/contracts/quorumProof';
import { buildAuditEvents, EVENT_CONFIG } from './AuditTrail.utils';

// ── Component ─────────────────────────────────────────────────────────────────

interface AuditTrailProps {
  credential: Credential;
  attestors: string[];
  expired: boolean;
}

export function AuditTrail({ credential, attestors, expired }: AuditTrailProps) {
  const events = buildAuditEvents(credential, attestors, expired);

  return (
    <div className="audit-trail" aria-label="Credential audit trail">
      <ol className="audit-timeline" aria-label="Audit timeline">
        {events.map((event, idx) => {
          const { colorClass } = EVENT_CONFIG[event.type];
          const isLast = idx === events.length - 1;
          return (
            <li
              key={`${event.type}-${idx}`}
              className="audit-event"
              data-testid={`audit-event-${event.type}-${idx}`}
            >
              {/* Connector line */}
              {!isLast && <div className="audit-line" aria-hidden="true" />}

              {/* Dot */}
              <div className={`audit-dot ${colorClass}`} aria-hidden="true">
                {event.icon}
              </div>

              {/* Content */}
              <div className="audit-content">
                <div className="audit-event__label">{event.label}</div>
                <div className="audit-event__detail">{event.detail}</div>
                <div className="audit-event__timestamp">{event.timestamp}</div>
              </div>
            </li>
          );
        })}
      </ol>

      {events.length === 0 && (
        <p className="audit-empty">No audit events available.</p>
      )}
    </div>
  );
}
