import { useState } from 'react';
import { useWallet } from '../context/WalletContextValue';
import type { WalletType } from '../wallets/types';
import { getAllWalletAdapters } from '../wallets/registry';

const WALLET_INFO: Record<WalletType, { name: string; icon: string }> = {
  freighter: { name: 'Freighter', icon: '🦊' },
  ledger: { name: 'Ledger', icon: '💻' },
  trezor: { name: 'Trezor', icon: '🔒' },
};

const HARDWARE_WALLETS: WalletType[] = ['ledger', 'trezor'];

/** Maximum account index exposed in the picker (0–9). */
const MAX_ACCOUNT_INDEX = 9;

export function WalletConnector() {
  const {
    address,
    walletType,
    accountIndex: activeAccountIndex,
    connect,
    disconnect,
    error,
    hasFreighter,
    availableWallets,
    isInitializing,
  } = useWallet();

  // Local state for the account-index picker shown when a hardware wallet is
  // selected but before the connection is initiated.
  const [pendingWalletType, setPendingWalletType] = useState<WalletType | null>(null);
  const [pickerAccountIndex, setPickerAccountIndex] = useState(0);

  if (isInitializing) {
    return (
      <div>
        <span>Checking wallet…</span>
      </div>
    );
  }

  if (address) {
    const info = walletType ? WALLET_INFO[walletType] : null;
    const showAccountIndex = walletType && HARDWARE_WALLETS.includes(walletType);
    return (
      <div>
        {info && <span>{info.icon}</span>}
        <code>{address}</code>
        {walletType && (
          <span>
            {info?.name}
            {showAccountIndex && ` (account ${activeAccountIndex})`}
          </span>
        )}
        <button onClick={disconnect}>Disconnect</button>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <span>{error}</span>
        <button onClick={() => connect()}>Retry</button>
      </div>
    );
  }

  // Account-index picker for hardware wallets
  if (pendingWalletType && HARDWARE_WALLETS.includes(pendingWalletType)) {
    const info = WALLET_INFO[pendingWalletType];
    return (
      <div>
        <span>
          {info.icon} {info.name} — select account index
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <label htmlFor="hw-account-index">Account index:</label>
          <select
            id="hw-account-index"
            value={pickerAccountIndex}
            onChange={(e) => setPickerAccountIndex(Number(e.target.value))}
            aria-label="Hardware wallet account index"
          >
            {Array.from({ length: MAX_ACCOUNT_INDEX + 1 }, (_, i) => (
              <option key={i} value={i}>
                {i} {i === 0 ? '(default)' : ''}
              </option>
            ))}
          </select>
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button
            onClick={() => {
              connect(pendingWalletType, pickerAccountIndex);
              setPendingWalletType(null);
            }}
          >
            Connect
          </button>
          <button
            onClick={() => {
              setPendingWalletType(null);
              setPickerAccountIndex(0);
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  const adapters = getAllWalletAdapters();
  const available = adapters.filter((a) => availableWallets.includes(a.type));

  const handleWalletClick = (type: WalletType) => {
    if (HARDWARE_WALLETS.includes(type)) {
      // Show the account-index picker before connecting
      setPendingWalletType(type);
      setPickerAccountIndex(0);
    } else {
      connect(type);
    }
  };

  return (
    <div>
      {available.length > 1 ? (
        <div>
          <span>Select wallet:</span>
          {available.map((adapter) => (
            <button key={adapter.type} onClick={() => handleWalletClick(adapter.type)}>
              {adapter.icon} {adapter.name}
            </button>
          ))}
        </div>
      ) : (
        <button onClick={() => connect()}>Connect Wallet</button>
      )}
      {!hasFreighter && availableWallets.length === 0 && (
        <div>
          <span>No wallet detected. </span>
          <a href="https://freighter.app" target="_blank" rel="noopener noreferrer">
            Install Freighter
          </a>
          <span> or connect a Ledger/Trezor hardware wallet.</span>
        </div>
      )}
    </div>
  );
}
