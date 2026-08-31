import { getAllWalletAdapters } from '../wallets/registry';
import type { WalletType } from '../wallets/types';

export interface WalletGateProps {
  hasFreighter?: boolean;
  connect: (type?: WalletType) => Promise<void>;
  availableWallets?: WalletType[];
}

/** Multi-wallet connection prompt UI */
export function WalletGate({ connect, availableWallets: wallets }: WalletGateProps) {
  const adapters = getAllWalletAdapters();
  const available = wallets
    ? adapters.filter((a) => wallets.includes(a.type))
    : adapters;

  return (
    <div className="wallet-guard-card" role="region" aria-label="Wallet connection required">
      <div className="wallet-guard__icon">🔐</div>
      <h2 className="wallet-guard__title">Connect your Stellar wallet to continue</h2>

      {available.length > 0 ? (
        <>
          <p className="wallet-guard__sub">Select a wallet to connect:</p>
          <div className="wallet-options">
            {available.map((adapter) => (
              <button
                key={adapter.type}
                className="btn btn--primary"
                onClick={() => connect(adapter.type)}
              >
                {adapter.icon} {adapter.name}
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <p className="wallet-guard__sub">
            No wallet detected. Install Freighter or connect a Ledger/Trezor hardware wallet.
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
