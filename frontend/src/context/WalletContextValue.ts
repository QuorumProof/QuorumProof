import { createContext, useContext } from 'react';
import type { WalletType } from '../wallets/types';

export interface WalletState {
  address: string | null;
  wallets: string[];
  walletType: WalletType | null;
  activeIndex: number;
  isConnected: boolean;
  hasFreighter: boolean;
  isInitializing: boolean;
  network: string;
  error: string | null;
  availableWallets: WalletType[];
  connect: (type?: WalletType) => Promise<void>;
  disconnect: () => void;
  switchWallet: (index: number) => void;
}

export const WalletContext = createContext<WalletState | undefined>(undefined);

export function useWallet(): WalletState {
  const context = useContext(WalletContext);
  if (context === undefined) {
    throw new Error('useWallet must be used within a WalletProvider');
  }
  return context;
}
