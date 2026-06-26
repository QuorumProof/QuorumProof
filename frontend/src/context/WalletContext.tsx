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

const STORAGE_KEY = 'quorum-proof-wallets';

interface PersistedWalletState {
  wallets: string[];
  activeIndex: number;
}

function loadPersistedState(): PersistedWalletState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedWalletState;
    if (Array.isArray(parsed.wallets) && parsed.wallets.length > 0) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function savePersistedState(wallets: string[], activeIndex: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ wallets, activeIndex }));
  } catch (err) {
    console.error('Failed to persist wallet state:', err);
  }
}

function clearPersistedState(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* noop */ }
}

interface WalletProviderProps {
  children: ReactNode;
}

export function WalletProvider({ children }: WalletProviderProps) {
  const [wallets, setWallets] = useState<string[]>(() => {
    const persisted = loadPersistedState();
    return persisted ? persisted.wallets : [];
  });
  const [activeIndex, setActiveIndex] = useState<number>(() => {
    const persisted = loadPersistedState();
    return persisted ? persisted.activeIndex : 0;
  });
  const [hasFreighter, setHasFreighter] = useState(false);
  const [isInitializing, setIsInitializing] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const address = wallets.length > 0 ? wallets[activeIndex] ?? wallets[0] : null;

  useEffect(() => {
    savePersistedState(wallets, activeIndex);
  }, [wallets, activeIndex]);

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
              const persisted = loadPersistedState();
              if (persisted && persisted.wallets.includes(result.address)) {
                setWallets(persisted.wallets);
                setActiveIndex(persisted.activeIndex);
              } else {
                setWallets(prev => {
                  if (prev.includes(result.address)) return prev;
                  return [result.address, ...prev];
                });
                setActiveIndex(0);
              }
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
    setWallets(prev => {
      const next = prev.filter((_, i) => i !== activeIndex);
      if (next.length === 0) clearPersistedState();
      return next;
    });
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
