interface EmptyStateProps {
  address?: string | null;
}

export function EmptyState({ address }: EmptyStateProps) {
  if (!address) {
    return (
      <div className="empty-state empty-state--dashboard">
        <div className="empty-state__icon">🔐</div>
        <div className="empty-state__title">Connect your wallet</div>
        <p className="empty-state__body">
          Use <strong>Connect Wallet</strong> in the navigation bar to view your credentials and
          account balance.
        </p>
      </div>
    );
  }

  return (
    <div className="empty-state empty-state--dashboard">
      <div className="empty-state__icon">📭</div>
      <div className="empty-state__title">No credentials yet</div>
      <p className="empty-state__body">
        No credentials have been issued to this address. Request issuance from a trusted
        institution to get started.
      </p>
      <div className="empty-state__address">
        <span className="meta-label">Connected address</span>
        <span className="mono" style={{ fontSize: '12px', wordBreak: 'break-all' }}>
          {address}
        </span>
      </div>
      <div className="empty-state__actions">
        <button
          className="btn btn--primary"
          onClick={() =>
            alert(
              'Credential issuance request flow coming soon.\nContact your institution with your Stellar address.'
            )
          }
        >
          ✦ Request Credential Issuance
        </button>
      </div>
    </div>
  );
}
