import { useState } from 'react';
import { credTypeLabel } from '../lib/credentialUtils';
import type { Credential } from '../lib/contracts/quorumProof';

interface BulkShareDialogProps {
  credentials: Credential[];
  onClose: () => void;
}

export function BulkShareDialog({ credentials, onClose }: BulkShareDialogProps) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [allCopied, setAllCopied] = useState(false);

  function getVerifyUrl(id: bigint) {
    return `${window.location.origin}/verify?id=${id}`;
  }

  function handleCopyOne(id: bigint) {
    const idStr = id.toString();
    navigator.clipboard.writeText(getVerifyUrl(id)).then(() => {
      setCopiedId(idStr);
      setTimeout(() => setCopiedId(null), 2000);
    });
  }

  function handleCopyAll() {
    const allLinks = credentials.map((c) => getVerifyUrl(c.id)).join('\n');
    navigator.clipboard.writeText(allLinks).then(() => {
      setAllCopied(true);
      setTimeout(() => setAllCopied(false), 2000);
    });
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        style={{ maxWidth: '560px' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 className="modal-title">Share Credentials</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          <p style={{ color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '16px' }}>
            Public verification links for {credentials.length} selected credential
            {credentials.length !== 1 ? 's' : ''}. Anyone with these links can verify the
            credential on-chain.
          </p>

          <ul className="bulk-share-list">
            {credentials.map((cred) => {
              const idStr = cred.id.toString();
              const truncId = idStr.length > 14 ? idStr.slice(0, 6) + '…' + idStr.slice(-4) : idStr;
              const url = getVerifyUrl(cred.id);
              const isCopied = copiedId === idStr;

              return (
                <li key={idStr} className="bulk-share-list__item">
                  <div className="bulk-share-list__meta">
                    <span style={{ color: 'var(--text-primary)', fontSize: '13px', fontWeight: 500 }}>
                      {credTypeLabel(cred.credential_type)}
                    </span>
                    <span className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                      #{truncId}
                    </span>
                  </div>
                  <div className="bulk-share-list__link">
                    <span
                      className="bulk-share-list__url"
                      title={url}
                    >
                      {url}
                    </span>
                    <button
                      className="btn btn--ghost btn--sm"
                      style={{ flexShrink: 0 }}
                      onClick={() => handleCopyOne(cred.id)}
                    >
                      {isCopied ? '✅' : '📋'}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="modal-footer">
          <button className="btn btn--ghost" onClick={onClose}>Close</button>
          <button className="btn btn--primary" onClick={handleCopyAll}>
            {allCopied ? '✅ Copied All' : `📋 Copy All ${credentials.length} Links`}
          </button>
        </div>
      </div>
    </div>
  );
}
