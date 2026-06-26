import { useState, useEffect, useCallback } from 'react';
import {
  isConnected,
  isAllowed,
  setAllowed,
  getAddress,
} from '@stellar/freighter-api';

export interface FreighterState {
  address: string | null;
  wallets: string[];
  activeIndex: number;
  hasFreighter: boolean;
  isInitializing: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  switchWallet: (index: number) => void;
}

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
  } catch { /* noop */ }
}

function clearPersistedState(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* noop */ }
}

export function useFreighter(): FreighterState {
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

  const address = wallets.length > 0 ? wallets[activeIndex] ?? wallets[0] : null;

  useEffect(() => {
    savePersistedState(wallets, activeIndex);
  }, [wallets, activeIndex]);

  useEffect(() => {
    const init = async () => {
      try {
        const connResult = await isConnected();
        setHasFreighter(connResult.isConnected);
        if (connResult.isConnected) {
          const allowedResult = await isAllowed();
          if (allowedResult.isAllowed) {
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
  }, [activeIndex, wallets.length]);

  const switchWallet = useCallback((index: number) => {
    if (index >= 0 && index < wallets.length) {
      setActiveIndex(index);
    }
  }, [wallets.length]);

  return { address, wallets, activeIndex, hasFreighter, isInitializing, connect, disconnect, switchWallet };
}
