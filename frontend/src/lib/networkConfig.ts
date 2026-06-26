export type StellarNetwork = 'testnet' | 'mainnet' | 'futurenet' | 'standalone';

export const VALID_NETWORKS: StellarNetwork[] = ['testnet', 'mainnet', 'futurenet', 'standalone'];

export interface NetworkConfig {
  network: StellarNetwork;
  rpcUrl: string;
  passphrase: string;
  name: string;
}

export const NETWORK_CONFIGS: Record<StellarNetwork, Omit<NetworkConfig, 'network'>> = {
  testnet: {
    rpcUrl: 'https://soroban-testnet.stellar.org',
    passphrase: 'Test SDF Network ; September 2015',
    name: 'Testnet',
  },
  mainnet: {
    rpcUrl: 'https://mainnet.sorobanrpc.com',
    passphrase: 'Public Global Stellar Network ; September 2015',
    name: 'Mainnet',
  },
  futurenet: {
    rpcUrl: 'https://rpc-futurenet.stellar.org',
    passphrase: 'Test SDF Future Network ; October 2022',
    name: 'Futurenet',
  },
  standalone: {
    rpcUrl: 'http://localhost:8000/soroban/rpc',
    passphrase: 'Standalone Network ; February 2017',
    name: 'Standalone',
  },
};

type Listener = (config: NetworkConfig) => void;
let currentNetwork: StellarNetwork;
let listeners: Listener[] = [];

function getInitialNetwork(): StellarNetwork {
  try {
    const stored = localStorage.getItem('quorum-proof-network');
    if (stored && (VALID_NETWORKS as string[]).includes(stored)) {
      return stored as StellarNetwork;
    }
  } catch { /* noop */ }
  const env = import.meta.env.VITE_STELLAR_NETWORK as string | undefined;
  if (env && (VALID_NETWORKS as string[]).includes(env)) {
    return env as StellarNetwork;
  }
  return 'testnet';
}

currentNetwork = getInitialNetwork();

export function getNetwork(): StellarNetwork {
  return currentNetwork;
}

export function getNetworkConfig(): NetworkConfig {
  const cfg = NETWORK_CONFIGS[currentNetwork];
  return { network: currentNetwork, ...cfg };
}

export function setNetwork(network: StellarNetwork): void {
  currentNetwork = network;
  try {
    localStorage.setItem('quorum-proof-network', network);
  } catch { /* noop */ }
  const config = getNetworkConfig();
  listeners.forEach(l => l(config));
}

export function onNetworkChange(listener: Listener): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter(l => l !== listener);
  };
}
