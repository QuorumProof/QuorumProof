import { useState } from 'react';
import { credTypeLabel } from '../lib/credentialUtils';
import type { Credential } from '../lib/contracts/quorumProof';

interface BulkRevokeDialogProps {
  credentials: Credential[];
  onConfirm: (ids: bigint[]) => Promise<void>;
  onClose: () => void;
}

export function BulkRevokeDialog({ credentials, onConfirm, onClose }: BulkRevokeDialogProps) {
  const [revoking, setRevoking] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const revokable = credentials.filter((c) => !c.revoked);

  async function handleConfirm() {
    setRevoking(true);
    setError(null);
    try {
      await onConfirm(revokable.map((c) => c.id));
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke credentials.');
    } finally {
      setRevoking(false);
    }
  }

  if (done) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal-content" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h2 className="modal-title">Revocation Complete</h2>
            <button className="modal-close" onClick={onClose}>×</button>
          </div>
          <div className="modal-body" style={{ textAlign: 'center', padding: '32px 24px' }}>
            <div style={{ fontSize: '40px', marginBottom: '16px' }}>🚫</div>
            <p style={{ color: 'var(--text-secondary)' }}>
              {revokable.length} credential{revokable.length !== 1 ? 's' : ''} marked as revoked.
            </p>
          </div>
          <div className="modal-footer">
            <button className="btn btn--primary" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Revoke Credentials</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          {error && (
            <p role="alert" style={{ color: 'var(--red)', marginBottom: '16px' }}>
              {error}
            </p>
          )}
          <div
            style={{
              background: 'var(--red-subtle)',
              border: '1px solid rgba(239,68,68,0.3)',
              borderRadius: 'var(--radius-md)',
              padding: '12px 16px',
              marginBottom: '16px',
              fontSize: '13px',
              color: 'var(--red)',
            }}
          >
            ⚠️ Revoking credentials is irreversible. Revoked credentials can no longer be
            verified or attested.
          </div>

          <p style={{ color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '12px' }}>
            The following {revokable.length} credential{revokable.length !== 1 ? 's' : ''} will be
            revoked:
          </p>

          <ul className="bulk-revoke-list">
            {revokable.map((cred) => {
              const idStr = cred.id.toString();
              const truncId = idStr.length > 14 ? idStr.slice(0, 6) + '…' + idStr.slice(-4) : idStr;
              return (
                <li key={idStr} className="bulk-revoke-list__item">
                  <span className="mono" style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                    #{truncId}
                  </span>
                  <span style={{ color: 'var(--text-primary)', fontSize: '13px' }}>
                    {credTypeLabel(cred.credential_type)}
                  </span>
                </li>
              );
            })}
          </ul>

          {credentials.length > revokable.length && (
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '12px' }}>
              {credentials.length - revokable.length} credential{credentials.length - revokable.length !== 1 ? 's' : ''} already revoked — skipped.
            </p>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn--ghost" onClick={onClose} disabled={revoking}>
            Cancel
          </button>
          <button
            className="btn btn--danger"
            onClick={handleConfirm}
            disabled={revoking || revokable.length === 0}
          >
            {revoking ? 'Revoking…' : `Revoke ${revokable.length} Credential${revokable.length !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
