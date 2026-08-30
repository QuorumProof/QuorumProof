import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useWallet } from '../hooks';
import { getAllWalletAdapters } from '../wallets/registry';
import type { WalletType } from '../wallets/types';

interface WalletGateProps {
  hasFreighter: boolean;
  connect: (type?: WalletType) => Promise<void>;
  availableWallets?: WalletType[];
}

/** Multi-wallet connection prompt */
export function WalletGate({ connect, availableWallets: wallets }: WalletGateProps) {
  const { t } = useTranslation();
  const adapters = getAllWalletAdapters();
  const available = wallets
    ? adapters.filter((a) => wallets.includes(a.type))
    : adapters;

  return (
    <div className="wallet-guard-card" role="region" aria-label={t('walletGate.title')}>
      <div className="wallet-guard__icon">🔐</div>
      <h2 className="wallet-guard__title">{t('walletGate.title')}</h2>

      {available.length > 0 ? (
        <>
          <p className="wallet-guard__sub">{t('walletGate.selectPrompt')}</p>
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
          <p className="wallet-guard__sub">{t('walletGate.noWalletMessage')}</p>
          <a
            href="https://freighter.app"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn--primary"
          >
            {t('walletGate.installFreighter')}
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

  if (!address) {
    if (availableWallets.length === 0) {
      return (
        <div className="wallet-guard-card" role="region" aria-label={t('walletGuard.noWalletTitle')}>
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

    const adapters = getAllWalletAdapters();
    const available = adapters.filter((a) => availableWallets.includes(a.type));

    return (
      <div className="wallet-guard-card" role="region" aria-label={t('walletGuard.title')}>
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
