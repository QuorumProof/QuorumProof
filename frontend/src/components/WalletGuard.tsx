import { ReactNode } from 'react';
import { useWallet } from '../hooks';
import { getAllWalletAdapters } from '../wallets/registry';
import type { WalletType } from '../wallets/types';

interface WalletGuardProps {
  children: ReactNode;
}

export function WalletGuard({ children }: WalletGuardProps) {
  const { address, isInitializing, connect, availableWallets } = useWallet();

  if (isInitializing) {
    return (
      <div className="loading-state">
        <div className="spinner" />
        <p>Checking wallet…</p>
      </div>
    );
  }

  if (availableWallets.length === 0) {
    return (
      <div className="wallet-guard-card">
        <div className="wallet-guard__icon">🔐</div>
        <h2 className="wallet-guard__title">Wallet Required</h2>
        <p className="wallet-guard__sub">
          Install the Freighter browser extension or connect a Ledger/Trezor hardware wallet to use this feature.
        </p>
        <a
          href="https://freighter.app"
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn--primary"
        >
          Install Freighter
        </a>
      </div>
    );
  }

  if (!address) {
    const adapters = getAllWalletAdapters();
    const available = adapters.filter((a) => availableWallets.includes(a.type));

    return (
      <div className="wallet-guard-card">
        <div className="wallet-guard__icon">🔐</div>
        <h2 className="wallet-guard__title">Connect Your Stellar Wallet</h2>
        <p className="wallet-guard__sub">
          Select a wallet to connect:
        </p>
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
      </div>
    );
  }

  return <>{children}</>;
}
