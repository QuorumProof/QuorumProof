import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import { type StellarNetwork, VALID_NETWORKS, getNetworkConfig, setNetwork as setGlobalNetwork, onNetworkChange } from '../lib/networkConfig';
import type { NetworkConfig } from '../lib/networkConfig';

interface NetworkContextValue {
  config: NetworkConfig;
  setNetwork: (network: StellarNetwork) => void;
  availableNetworks: StellarNetwork[];
}

const NetworkContext = createContext<NetworkContextValue | undefined>(undefined);

export function NetworkProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<NetworkConfig>(getNetworkConfig);

  useEffect(() => {
    const unsubscribe = onNetworkChange((newConfig) => {
      setConfig(newConfig);
    });
    return unsubscribe;
  }, []);

  const setNetwork = useCallback((network: StellarNetwork) => {
    setGlobalNetwork(network);
  }, []);

  return (
    <NetworkContext.Provider value={{ config, setNetwork, availableNetworks: VALID_NETWORKS }}>
      {children}
    </NetworkContext.Provider>
  );
}

export function useNetwork(): NetworkContextValue {
  const ctx = useContext(NetworkContext);
  if (!ctx) throw new Error('useNetwork must be used within a NetworkProvider');
  return ctx;
}
