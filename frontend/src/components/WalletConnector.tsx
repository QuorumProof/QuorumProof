import { useWallet } from '../context/WalletContext';
import type { WalletType } from '../wallets/types';
import { getAllWalletAdapters } from '../wallets/registry';

const WALLET_INFO: Record<WalletType, { name: string; icon: string }> = {
  freighter: { name: 'Freighter', icon: '🦊' },
  ledger: { name: 'Ledger', icon: '💻' },
  trezor: { name: 'Trezor', icon: '🔒' },
};

type ConnectorState =
  | { status: 'disconnected' }
  | { status: 'connecting' }
  | { status: 'connected'; publicKey: string; walletType: WalletType }
  | { status: 'error'; message: string };

export function WalletConnector() {
  const { address, walletType, connect, disconnect, error, hasFreighter, availableWallets, isInitializing } = useWallet();

  if (isInitializing) {
    return (
      <div>
        <span>Checking wallet…</span>
      </div>
    );
  }

  if (address) {
    const info = walletType ? WALLET_INFO[walletType] : null;
    return (
      <div>
        {info && <span>{info.icon}</span>}
        <code>{address}</code>
        {walletType && <span>{info?.name}</span>}
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

  const adapters = getAllWalletAdapters();
  const available = adapters.filter((a) => availableWallets.includes(a.type));

  return (
    <div>
      {available.length > 1 ? (
        <div>
          <span>Select wallet:</span>
          {available.map((adapter) => (
            <button key={adapter.type} onClick={() => connect(adapter.type)}>
              {adapter.icon} {adapter.name}
            </button>
          ))}
        </div>
      ) : (
        <button onClick={() => connect()}>
          Connect Wallet
        </button>
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
