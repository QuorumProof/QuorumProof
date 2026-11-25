interface EmptyStateProps {
  address: string;
}

export function EmptyState({ address }: EmptyStateProps) {
  return (
    <div className="empty-state empty-state--dashboard">
      <div className="empty-state__icon">📭</div>
      <div className="empty-state__title">No credentials yet</div>
      <p className="empty-state__body">
        No credentials have been issued to this address. Request issuance from a
        trusted institution to get started.
      </p>
      <div className="empty-state__address">
        <span className="meta-label">Connected address</span>
        <span className="mono" style={{ fontSize: '12px', wordBreak: 'break-all' }}>
          {address}
        </span>
      </div>
      <div className="empty-state__actions">
        <a
          className="btn btn--primary"
          href="/credential/issue"
        >
          ✦ Request Credential Issuance
        </a>
      </div>
    </div>
  );
}
