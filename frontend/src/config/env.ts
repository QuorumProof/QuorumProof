/**
 * Environment configuration with validation
 * Centralizes all environment variable access to ensure consistency and prevent runtime errors
 */

interface EnvConfig {
  STELLAR_NETWORK: string;
  STELLAR_RPC_URL: string;
  HORIZON_URL: string;
  CONTRACT_QUORUM_PROOF: string;
  CONTRACT_SBT_REGISTRY: string;
  CONTRACT_ZK_VERIFIER: string;
}

const HORIZON_DEFAULTS: Record<string, string> = {
  testnet: 'https://horizon-testnet.stellar.org',
  mainnet: 'https://horizon.stellar.org',
  futurenet: 'https://horizon-futurenet.stellar.org',
};

function readEnv(): EnvConfig {
  const network = import.meta.env.VITE_STELLAR_NETWORK ?? 'testnet';
  const rpcUrl =
    import.meta.env.VITE_STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';
  const horizonUrl =
    import.meta.env.VITE_HORIZON_URL ?? HORIZON_DEFAULTS[network] ?? HORIZON_DEFAULTS.testnet;

  const config: EnvConfig = {
    STELLAR_NETWORK: network,
    STELLAR_RPC_URL: rpcUrl,
    HORIZON_URL: horizonUrl,
    CONTRACT_QUORUM_PROOF: import.meta.env.VITE_CONTRACT_QUORUM_PROOF ?? '',
    CONTRACT_SBT_REGISTRY: import.meta.env.VITE_CONTRACT_SBT_REGISTRY ?? '',
    CONTRACT_ZK_VERIFIER: import.meta.env.VITE_CONTRACT_ZK_VERIFIER ?? '',
  };

  const trackedVars = [
    'VITE_STELLAR_NETWORK',
    'VITE_STELLAR_RPC_URL',
    'VITE_HORIZON_URL',
    'VITE_CONTRACT_QUORUM_PROOF',
    'VITE_CONTRACT_SBT_REGISTRY',
    'VITE_CONTRACT_ZK_VERIFIER',
  ];

  const missingVars = trackedVars.filter((varName) => !import.meta.env[varName]);

  if (missingVars.length > 0) {
    console.warn(
      `[QuorumProof] Missing env vars: ${missingVars.join(', ')}. Using defaults where applicable.`
    );
  }

  return config;
}

export const env = readEnv();

export const {
  STELLAR_NETWORK,
  STELLAR_RPC_URL,
  HORIZON_URL,
  CONTRACT_QUORUM_PROOF,
  CONTRACT_SBT_REGISTRY,
  CONTRACT_ZK_VERIFIER,
} = env;
