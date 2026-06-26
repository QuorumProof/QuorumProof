import { ReactNode } from 'react';
import { useWallet } from '../hooks';
import { getAllWalletAdapters } from '../wallets/registry';
import type { WalletType } from '../wallets/types';

interface WalletGateProps {
  hasFreighter: boolean;
  connect: (type?: WalletType) => Promise<void>;
  availableWallets?: WalletType[];
}

/** Multi-wallet connection prompt */
export function WalletGate({ hasFreighter, connect, availableWallets: wallets }: WalletGateProps) {
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

interface WalletGuardProps {
  children: ReactNode;
}

/**
 * WalletGuard — wrap any page that requires a connected wallet.
 * Shows an onboarding prompt when no wallet is connected.
 */
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

  if (!address) {
    if (availableWallets.length === 0) {
      return (
        <div className="wallet-guard-card" role="region" aria-label="Wallet connection required">
          <div className="wallet-guard__icon">🔐</div>
          <h2 className="wallet-guard__title">Wallet Required</h2>
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
        </div>
      );
    }

    const adapters = getAllWalletAdapters();
    const available = adapters.filter((a) => availableWallets.includes(a.type));

    return (
      <div className="wallet-guard-card" role="region" aria-label="Wallet connection required">
        <div className="wallet-guard__icon">🔐</div>
        <h2 className="wallet-guard__title">Connect your Stellar wallet to continue</h2>
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
      </div>
    );
  }

  return <>{children}</>;
}
