export { useWallet } from '../context/WalletContext';
export { useRealtimeUpdates } from './useRealtimeUpdates';
export { FreighterAdapter } from '../wallets/FreighterAdapter';
export { LedgerAdapter } from '../wallets/LedgerAdapter';
export { TrezorAdapter } from '../wallets/TrezorAdapter';
export { getWalletAdapter, getAllWalletAdapters, detectAvailableWallets } from '../wallets/registry';
export type { WalletType, WalletAdapter, WalletState as WalletStateType } from '../wallets/types';
