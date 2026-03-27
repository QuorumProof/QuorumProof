import { Link } from 'react-router-dom';
import {
  type CredCardData,
  deriveStatus,
  formatAddress,
  attestorRole,
  credTypeLabel,
  formatTimestamp,
} from '../lib/credentialUtils';
import { decodeMetadataHash } from '../stellar';

interface CredentialCardProps {
  data: CredCardData;
  sliceId: bigint | null;
}

const STATUS_CONFIG = {
  attested: { label: 'Attested', icon: '✅', badgeClass: 'badge--green' },
  pending:  { label: 'Pending',  icon: '⏳', badgeClass: 'badge--blue'  },
  revoked:  { label: 'Revoked',  icon: '🚫', badgeClass: 'badge--red'   },
  expired:  { label: 'Expired',  icon: '⏰', badgeClass: 'badge--gray'  },
};

export function CredentialCard({ data, sliceId }: CredentialCardProps) {
  const { credential, attested, slice, expired, sliceError, credError } = data;

  const status = deriveStatus(credential.revoked, expired, attested);
  const { label, icon, badgeClass } = STATUS_CONFIG[status];
  const metaStr = decodeMetadataHash(credential.metadata_hash);
  const idStr = credential.id.toString();

  return (
    <div className="cred-card">
      {/* Header */}
      <div className={`cred-card__header cred-card__header--${status}`}>
        <div className="cred-card__type">{credTypeLabel(credential.credential_type)}</div>
        <div
          className={`badge ${badgeClass}`}
          aria-label={`Attestation status: ${label}`}
        >
          {icon} {label}
        </div>
      </div>

      {/* Body */}
      {credError ? (
        <div className="cred-card__body cred-card__body--error">
          <div style={{ fontSize: '24px', marginBottom: '8px' }}>⚠️</div>
          <div style={{ color: 'var(--red)', fontSize: '13px' }}>Failed to load</div>
          <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: '4px' }}>
            {credError}
          </div>
        </div>
      ) : (
        <div className="cred-card__body">
          <h3 className="cred-card__id">
            Credential #{idStr.length > 14 ? idStr.slice(0, 8) + '…' + idStr.slice(-6) : idStr}
          </h3>

          <div className="cred-card__meta">
            <div className="meta-row">
              <span className="meta-label">Issuer</span>
              <span className="meta-value mono" title={credential.issuer}>
                {formatAddress(credential.issuer)}
              </span>
            </div>
            <div className="meta-row">
              <span className="meta-label">Metadata</span>
              <span className="meta-value mono">{metaStr || '—'}</span>
            </div>
            {credential.expires_at && (
              <div className="meta-row">
                <span className="meta-label">Expires</span>
                <span className="meta-value">{formatTimestamp(credential.expires_at)}</span>
              </div>
            )}
            {sliceId && (
              <div className="meta-row">
                <span className="meta-label">Slice</span>
                <span className="meta-value mono">#{sliceId.toString()}</span>
              </div>
            )}
          </div>

          {/* Quorum Slice Section */}
          <div className="cred-card__attestors">
            <div className="attestors-header">
              <span className="meta-label">Quorum Slice</span>
              {slice && (
                <span className="badge badge--gray" style={{ fontSize: '10px' }}>
                  {slice.attestors.length}/{slice.threshold} threshold
                </span>
              )}
            </div>

            {sliceError ? (
              <div className="attestors-empty">Slice unavailable</div>
            ) : !slice ? (
              <div className="attestors-empty">No slice data available</div>
            ) : slice.attestors.length === 0 ? (
              <div className="attestors-empty">No attestors assigned</div>
            ) : (
              <div className="attestor-mini-list">
                {slice.attestors.map((addr, i) => (
                  <div key={addr} className="attestor-mini-item">
                    <span className="attestor-mini-item__avatar">{i + 1}</span>
                    <div className="attestor-mini-item__info">
                      <span className="mono" title={addr}>
                        {formatAddress(addr)}
                      </span>
                      <span className="attestor-mini-item__role">
                        {attestorRole(i)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="cred-card__footer">
        <Link
          to={`/verify?credentialId=${credential.id}`}
          className="btn btn--sm btn--ghost"
          style={{ width: '100%', textAlign: 'center' }}
        >
          View Public Page →
        </Link>
      </div>
    </div>
  );
}
