import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import { STELLAR_NETWORK } from '../config/env';
import type { WalletType, WalletState as WalletStateType } from '../wallets/types';
import { getWalletAdapter, detectAvailableWallets } from '../wallets/registry';

interface WalletState {
  address: string | null;
  walletType: WalletType | null;
  isConnected: boolean;
  hasFreighter: boolean;
  isInitializing: boolean;
  network: string;
  error: string | null;
  connect: (type?: WalletType) => Promise<void>;
  disconnect: () => void;
  availableWallets: WalletType[];
}

const WalletContext = createContext<WalletState | undefined>(undefined);

const STORAGE_KEY = 'quorum-proof-wallet-address';
const WALLET_TYPE_KEY = 'quorum-proof-wallet-type';

interface WalletProviderProps {
  children: ReactNode;
}

export function WalletProvider({ children }: WalletProviderProps) {
  const [address, setAddress] = useState<string | null>(null);
  const [walletType, setWalletType] = useState<WalletType | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [availableWallets, setAvailableWallets] = useState<WalletType[]>([]);

  useEffect(() => {
    const init = async () => {
      try {
        setError(null);
        const available = await detectAvailableWallets();
        setAvailableWallets(available);

        const savedType = localStorage.getItem(WALLET_TYPE_KEY) as WalletType | null;
        if (savedType && available.includes(savedType)) {
          setWalletType(savedType);
          const adapter = getWalletAdapter(savedType);
          try {
            const addr = await adapter.connect();
            setAddress(addr);
            localStorage.setItem(STORAGE_KEY, addr);
          } catch {
            localStorage.removeItem(STORAGE_KEY);
            localStorage.removeItem(WALLET_TYPE_KEY);
          }
        } else {
          localStorage.removeItem(STORAGE_KEY);
          localStorage.removeItem(WALLET_TYPE_KEY);
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Failed to initialize wallet';
        setError(errorMsg);
        console.error('Error initializing wallet:', err);
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(WALLET_TYPE_KEY);
      } finally {
        setIsInitializing(false);
      }
    };
    init();
  }, []);

  const connect = useCallback(async (type?: WalletType) => {
    const walletToUse = type || (availableWallets.includes('freighter') ? 'freighter' : availableWallets[0]);

    if (!walletToUse) {
      window.open('https://freighter.app', '_blank');
      return;
    }

    try {
      setError(null);
      setWalletType(walletToUse);
      const adapter = getWalletAdapter(walletToUse);
      const addr = await adapter.connect();
      setAddress(addr);
      localStorage.setItem(STORAGE_KEY, addr);
      localStorage.setItem(WALLET_TYPE_KEY, walletToUse);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to connect wallet';
      setError(errorMsg);
      setWalletType(null);
      console.error('Wallet connection error:', err);
    }
  }, [availableWallets]);

  const disconnect = useCallback(() => {
    if (walletType) {
      const adapter = getWalletAdapter(walletType);
      adapter.disconnect();
    }
    setAddress(null);
    setWalletType(null);
    setError(null);
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(WALLET_TYPE_KEY);
  }, [walletType]);

  const value: WalletState = {
    address,
    walletType,
    isConnected: address !== null,
    hasFreighter: availableWallets.includes('freighter'),
    isInitializing,
    network: STELLAR_NETWORK,
    error,
    connect,
    disconnect,
    availableWallets,
  };

  return (
    <WalletContext.Provider value={value}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet(): WalletState {
  const context = useContext(WalletContext);
  if (context === undefined) {
    throw new Error('useWallet must be used within a WalletProvider');
  }
  return context;
}