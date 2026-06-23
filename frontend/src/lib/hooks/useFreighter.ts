import { useState, useEffect, useCallback } from 'react';
import {
  isConnected,
  isAllowed,
  setAllowed,
  getAddress,
} from '@stellar/freighter-api';

export interface FreighterState {
  address: string | null;
  hasFreighter: boolean;
  isInitializing: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
}

export function useFreighter(): FreighterState {
  const [address, setAddress] = useState<string | null>(null);
  const [hasFreighter, setHasFreighter] = useState(false);
  const [isInitializing, setIsInitializing] = useState(true);

  useEffect(() => {
    const init = async () => {
      try {
        const connResult = await isConnected();
        setHasFreighter(connResult.isConnected);
        if (connResult.isConnected) {
          const allowedResult = await isAllowed();
          if (allowedResult.isAllowed) {
            const result = await getAddress();
            if (result.address) setAddress(result.address);
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
      if (result.address) setAddress(result.address);
    } catch (err) {
      console.error('User rejected connection or error occurred:', err);
    }
  }, [hasFreighter]);

  const disconnect = useCallback(() => {
    setAddress(null);
  }, []);

  return { address, hasFreighter, isInitializing, connect, disconnect };
}
