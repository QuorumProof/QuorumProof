import { useEffect } from 'react';
import { useWallet } from '../hooks';

export function WalletConnectModal() {
  const {
    showConnectModal,
    closeConnectModal,
    connect,
    isConnecting,
    error,
    availableWallets,
    walletsLoading,
  } = useWallet();

  useEffect(() => {
    if (!showConnectModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isConnecting) closeConnectModal();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showConnectModal, isConnecting, closeConnectModal]);

  if (!showConnectModal) return null;

  return (
    <div
      className="wallet-modal-backdrop"
      role="presentation"
      onClick={() => {
        if (!isConnecting) closeConnectModal();
      }}
    >
      <div
        className="wallet-modal wallet-modal--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wallet-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="wallet-modal-title" className="wallet-modal__title">
          Connect a Wallet
        </h2>
        <p className="wallet-modal__sub">
          Choose a Stellar wallet to connect. Your keys stay in the wallet — we never see them.
        </p>

        {walletsLoading ? (
          <p className="wallet-modal__hint">Loading available wallets…</p>
        ) : availableWallets.length === 0 ? (
          <p className="wallet-modal__hint">
            No supported wallets detected. Install Freighter, Albedo, or xBull and try again.
          </p>
        ) : (
          <ul className="wallet-modal__list" role="list">
            {availableWallets.map((wallet) => (
              <li key={wallet.id} className="wallet-modal__row">
                <button
                  type="button"
                  className="wallet-modal__option"
                  disabled={isConnecting || !wallet.isAvailable}
                  onClick={() => void connect(wallet.id)}
                >
                  {wallet.icon ? (
                    <img
                      src={wallet.icon}
                      alt=""
                      className="wallet-modal__option-icon"
                      width={32}
                      height={32}
                    />
                  ) : (
                    <span className="wallet-modal__option-icon wallet-modal__option-icon--fallback">
                      ◈
                    </span>
                  )}
                  <span className="wallet-modal__option-body">
                    <span className="wallet-modal__option-name">{wallet.name}</span>
                    <span className="wallet-modal__option-meta">
                      {wallet.isAvailable ? 'Available' : 'Not installed'}
                    </span>
                  </span>
                </button>
                {!wallet.isAvailable && wallet.url ? (
                  <a
                    href={wallet.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="wallet-modal__install"
                  >
                    Install
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {error ? <p className="wallet-modal__error">{error}</p> : null}

        <button
          type="button"
          className="btn btn--ghost wallet-modal__cancel"
          onClick={closeConnectModal}
          disabled={isConnecting}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
