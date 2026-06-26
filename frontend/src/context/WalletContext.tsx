import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import {
  isConnected,
  isAllowed,
  setAllowed,
  getAddress,
} from '@stellar/freighter-api';
import { STELLAR_NETWORK } from '../config/env';

interface WalletState {
  address: string | null;
  wallets: string[];
  activeIndex: number;
  isConnected: boolean;
  hasFreighter: boolean;
  isInitializing: boolean;
  network: string;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  switchWallet: (index: number) => void;
}

const WalletContext = createContext<WalletState | undefined>(undefined);

interface WalletProviderProps {
  children: ReactNode;
}

export function WalletProvider({ children }: WalletProviderProps) {
  const [wallets, setWallets] = useState<string[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [hasFreighter, setHasFreighter] = useState(false);
  const [isInitializing, setIsInitializing] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const address = wallets.length > 0 ? wallets[activeIndex] ?? wallets[0] : null;

  useEffect(() => {
    const init = async () => {
      try {
        setError(null);
        const connResult = await isConnected();
        const freighterConnected = connResult.isConnected;
        setHasFreighter(freighterConnected);
        if (freighterConnected) {
          const allowed = await isAllowed();
          if (allowed.isAllowed) {
            const result = await getAddress();
            if (result.address) {
              setWallets([result.address]);
              setActiveIndex(0);
            }
          }
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Failed to initialize wallet';
        setError(errorMsg);
        console.error('Error checking Freighter connection:', err);
      } finally {
        setIsInitializing(false);
      }
    };
    init();
  }, []);

  const connect = useCallback(async () => {
    if (!hasFreighter) {
      window.open('https://freighter.app', '_blank');
      return;
    }
    try {
      setError(null);
      await setAllowed();
      const result = await getAddress();
      if (result.address) {
        setWallets(prev => {
          const existing = prev.findIndex(w => w === result.address);
          if (existing >= 0) {
            setActiveIndex(existing);
            return prev;
          }
          const newWallets = [...prev, result.address];
          setActiveIndex(newWallets.length - 1);
          return newWallets;
        });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to connect wallet';
      setError(errorMsg);
      console.error('User rejected connection or error occurred:', err);
    }
  }, [hasFreighter]);

  const disconnect = useCallback(() => {
    setWallets(prev => prev.filter((_, i) => i !== activeIndex));
    setActiveIndex(() => {
      const newLength = wallets.length - 1;
      if (newLength <= 0) return 0;
      if (activeIndex >= newLength) return newLength - 1;
      return activeIndex;
    });
    setError(null);
  }, [activeIndex, wallets.length]);

  const switchWallet = useCallback((index: number) => {
    if (index >= 0 && index < wallets.length) {
      setActiveIndex(index);
    }
  }, [wallets.length]);

  const value: WalletState = {
    address,
    wallets,
    activeIndex,
    isConnected: wallets.length > 0,
    hasFreighter,
    isInitializing,
    network: STELLAR_NETWORK,
    error,
    connect,
    disconnect,
    switchWallet,
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
