import type { ReactNode } from 'react';
import { useWallet } from '../hooks';

interface WalletGuardProps {
  children: ReactNode;
  /** When true, page content is hidden until a wallet is connected. */
  requireConnection?: boolean;
}

export function WalletGuard({ children, requireConnection = false }: WalletGuardProps) {
  const { address, isInitializing } = useWallet();

  if (isInitializing) {
    return (
      <div className="loading-state">
        <div className="spinner" />
        <p>Loading…</p>
      </div>
    );
  }

  if (requireConnection && !address) {
    return (
      <div className="wallet-guard-card" role="region" aria-label="Wallet connection required">
        <div className="wallet-guard__icon">🔐</div>
        <h2 className="wallet-guard__title">Connect your wallet</h2>
        <p className="wallet-guard__sub">
          Use <strong>Connect Wallet</strong> in the navigation bar to access this page.
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
