import { type StellarNetwork, VALID_NETWORKS as VALID, getNetworkConfig } from './lib/networkConfig';

export type { StellarNetwork } from './lib/networkConfig';
export const VALID_NETWORKS = VALID;

export interface EnvConfig {
  network: StellarNetwork;
  rpcUrl: string;
}

export function getEnvConfig(): EnvConfig {
  const cfg = getNetworkConfig();
  return { network: cfg.network, rpcUrl: cfg.rpcUrl };
}

export const envConfig: EnvConfig = getEnvConfig();
