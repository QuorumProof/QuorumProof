import { createContext, useContext } from 'react';
import type { StellarNetwork, NetworkConfig } from '../lib/networkConfig';

export interface NetworkContextValue {
  config: NetworkConfig;
  setNetwork: (network: StellarNetwork) => void;
  availableNetworks: StellarNetwork[];
}

export const NetworkContext = createContext<NetworkContextValue | undefined>(undefined);

export function useNetwork(): NetworkContextValue {
  const ctx = useContext(NetworkContext);
  if (!ctx) throw new Error('useNetwork must be used within a NetworkProvider');
  return ctx;
}
