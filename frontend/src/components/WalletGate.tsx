interface WalletGateProps {
  hasFreighter: boolean;
  connect: () => Promise<void>;
}

export function WalletGate({ hasFreighter, connect }: WalletGateProps) {
  return (
    <div className="wallet-guard-card">
      <div className="wallet-guard__icon">🔐</div>
      <h2 className="wallet-guard__title">Connect Your Wallet</h2>

      {hasFreighter ? (
        <>
          <p className="wallet-guard__sub">
            Connect your Freighter wallet to view your credentials.
          </p>
          <button className="btn btn--primary" onClick={connect}>
            Connect Wallet
          </button>
        </>
      ) : (
        <>
          <p className="wallet-guard__sub">
            Freighter wallet extension is required to use this dashboard.
          </p>
          <a
            href="https://freighter.app"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn--primary"
          >
            Install Freighter
          </a>
        </>
      )}
    </div>
  );
}
