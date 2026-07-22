import { useState, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import { STELLAR_NETWORK } from '../config/env';
import type { WalletType } from '../wallets/types';
import { detectAvailableWallets } from '../wallets/registry';
import { isConnected, isAllowed, setAllowed, getAddress } from '@stellar/freighter-api';
import type { WalletState } from './WalletContextValue';
import { WalletContext } from './WalletContextValue';

const STORAGE_KEY = 'quorum-proof-wallets';

interface PersistedWalletState {
  wallets: string[];
  walletTypes: WalletType[];
  activeIndex: number;
}

function loadPersistedState(): PersistedWalletState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedWalletState;
    if (Array.isArray(parsed.wallets) && parsed.wallets.length > 0) {
      return {
        ...parsed,
        walletTypes: Array.isArray(parsed.walletTypes) ? parsed.walletTypes : [],
      };
    }
    return null;
  } catch {
    return null;
  }
}

function savePersistedState(wallets: string[], walletTypes: WalletType[], activeIndex: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ wallets, walletTypes, activeIndex }));
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
  const [walletTypes, setWalletTypes] = useState<WalletType[]>(() => {
    const persisted = loadPersistedState();
    return persisted ? persisted.walletTypes : [];
  });
  const [activeIndex, setActiveIndex] = useState<number>(() => {
    const persisted = loadPersistedState();
    return persisted ? persisted.activeIndex : 0;
  });
  const [hasFreighter, setHasFreighter] = useState(false);
  const [isInitializing, setIsInitializing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [availableWallets, setAvailableWallets] = useState<WalletType[]>([]);

  const address = wallets.length > 0 ? wallets[activeIndex] ?? wallets[0] : null;
  const walletType = walletTypes.length > 0 ? walletTypes[activeIndex] ?? walletTypes[0] ?? null : null;

  useEffect(() => {
    savePersistedState(wallets, walletTypes, activeIndex);
  }, [wallets, walletTypes, activeIndex]);

  useEffect(() => {
    const init = async () => {
      try {
        setError(null);
        // Detect available wallets
        const detected = await detectAvailableWallets();
        setAvailableWallets(detected);
        
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
                setWalletTypes(persisted.wallets.map((_, i) => persisted.walletTypes[i] ?? 'freighter'));
                setActiveIndex(persisted.activeIndex);
              } else {
                setWallets(prev => {
                  if (prev.includes(result.address)) return prev;
                  return [result.address, ...prev];
                });
                setWalletTypes(prev => {
                  if (wallets.includes(result.address)) return prev;
                  return ['freighter', ...prev];
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

  const connect = useCallback(async (type?: WalletType) => {
    const walletToUse = type || (availableWallets.includes('freighter') ? 'freighter' : availableWallets[0]);

    if (!walletToUse) {
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
            setWalletTypes(types => types.map((t, i) => (i === existing ? walletToUse : t)));
            return prev;
          }
          const newWallets = [...prev, result.address];
          setActiveIndex(newWallets.length - 1);
          setWalletTypes(types => [...types, walletToUse]);
          return newWallets;
        });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to connect wallet';
      setError(errorMsg);
      console.error('Wallet connection error:', err);
    }
  }, [availableWallets]);

  const disconnect = useCallback(() => {
    setWallets(prev => {
      const next = prev.filter((_, i) => i !== activeIndex);
      if (next.length === 0) clearPersistedState();
      return next;
    });
    setWalletTypes(prev => prev.filter((_, i) => i !== activeIndex));
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
    walletType,
    activeIndex,
    isConnected: wallets.length > 0,
    hasFreighter,
    isInitializing,
    network: STELLAR_NETWORK,
    error,
    availableWallets,
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
