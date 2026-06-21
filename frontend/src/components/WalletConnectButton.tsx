import { useEffect, useId, useRef, useState } from 'react';
import { useWallet } from '../hooks';
import { compactXlmLabel } from '../lib/wallet/balance';
import { formatNetworkLabel, truncateAddress } from '../lib/wallet/display';

interface WalletConnectButtonProps {
  className?: string;
}

export function WalletConnectButton({ className = '' }: WalletConnectButtonProps) {
  const {
    address,
    isConnecting,
    isInitializing,
    balanceXlm,
    balanceUsd,
    balanceLoading,
    network,
    openConnectModal,
    disconnect,
  } = useWallet();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (isInitializing) {
    return (
      <span className={`navbar__badge ${className}`.trim()} style={{ opacity: 0.6 }}>
        …
      </span>
    );
  }

  if (!address) {
    return (
      <button
        type="button"
        className={`btn btn--primary ${className}`.trim()}
        onClick={openConnectModal}
        disabled={isConnecting}
      >
        {isConnecting ? 'Connecting…' : 'Connect Wallet'}
      </button>
    );
  }

  const compactBalance = balanceLoading ? '…' : compactXlmLabel(balanceXlm);

  async function copyAddress() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div
      className={`wallet-connect${open ? ' wallet-connect--open' : ''} ${className}`.trim()}
      ref={rootRef}
    >
      <div className="wallet-connect__menu-wrap">
        <button
          type="button"
          className="wallet-connect__connected"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-controls={menuId}
          title={address}
        >
          <span className="wallet-connect__dot" aria-hidden />
          <span className="wallet-connect__summary">
            <span className="wallet-connect__balance">{compactBalance}</span>
            <span className="wallet-connect__addr">{truncateAddress(address)}</span>
          </span>
          <span className="wallet-connect__chevron" aria-hidden>
            ▾
          </span>
        </button>

        {open ? (
          <div id={menuId} className="wallet-connect__menu" role="menu">
            <div className="wallet-connect__menu-section">
              <span className="wallet-connect__menu-label">Balance</span>
              <span className="wallet-connect__menu-value">
                {balanceLoading ? 'Loading…' : balanceXlm ?? '0 XLM'}
              </span>
              {!balanceLoading && balanceUsd ? (
                <span className="wallet-connect__menu-sub">{balanceUsd}</span>
              ) : null}
            </div>

            <div className="wallet-connect__menu-section">
              <span className="wallet-connect__menu-label">Address</span>
              <span className="wallet-connect__menu-addr" title={address}>
                {address}
              </span>
              <button type="button" className="wallet-connect__menu-copy" onClick={() => void copyAddress()}>
                {copied ? 'Copied' : 'Copy address'}
              </button>
            </div>

            <div className="wallet-connect__menu-section wallet-connect__menu-section--inline">
              <span className="wallet-connect__menu-label">Network</span>
              <span className="navbar__badge navbar__badge--network">{formatNetworkLabel(network)}</span>
            </div>

            <button
              type="button"
              className="wallet-connect__menu-item wallet-connect__menu-item--danger"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                disconnect();
              }}
            >
              Disconnect
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
