import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useWallet } from '../hooks';
import { getAllWalletAdapters } from '../wallets/registry';

interface WalletGuardProps {
  children: ReactNode;
}

export function WalletGuard({ children }: WalletGuardProps) {
  const { t } = useTranslation();
  const { address, isInitializing, connect, availableWallets } = useWallet();

  if (isInitializing) {
    return (
      <div className="loading-state">
        <div className="spinner" />
        <p>{t('walletGuard.checkingWallet')}</p>
      </div>
    );
  }

  if (availableWallets.length === 0) {
    return (
      <div className="wallet-guard-card">
        <div className="wallet-guard__icon">🔐</div>
        <h2 className="wallet-guard__title">{t('walletGuard.noWalletTitle')}</h2>
        <p className="wallet-guard__sub">{t('walletGuard.noWalletMessage')}</p>
        <a
          href="https://freighter.app"
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn--primary"
        >
          {t('walletGuard.installFreighter')}
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
        <h2 className="wallet-guard__title">{t('walletGuard.title')}</h2>
        <p className="wallet-guard__sub">{t('walletGuard.selectPrompt')}</p>
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
