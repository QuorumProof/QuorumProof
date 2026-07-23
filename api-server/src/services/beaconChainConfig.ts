/**
 * Ethereum beacon-chain network constants for the Altair light-client sync
 * protocol (`beaconLightClient.ts`). These are public, protocol-level
 * parameters (genesis validators root, fork schedule) fixed once each network
 * launches or hard-forks — not something learned from an untrusted relay —
 * so they're pinned here the same way `evmChainConfig.ts` pins per-chain RLP
 * header schemas.
 *
 * Values sourced from the canonical network metadata
 * (https://github.com/eth-clients/mainnet, https://github.com/eth-clients/sepolia).
 *
 * SCOPE: only chains with a real Ethereum beacon chain (mainnet, Sepolia) can
 * have a BLS sync-committee light client at all — Polygon PoS has its own,
 * unrelated (Heimdall checkpoint) consensus mechanism and is deliberately not
 * mapped here; its bridge headers remain on the RPC-trust model documented in
 * `blockHeaderStore.ts`. Goerli is deprecated and unsupported.
 */
import { hexToBytes } from '@ethereumjs/util';

export type BeaconNetwork = 'mainnet' | 'sepolia';

/** Maps the bridge's EVM chain IDs to the beacon-chain network they run on. */
export const EL_CHAIN_TO_BEACON_NETWORK: Partial<Record<number, BeaconNetwork>> = {
  1: 'mainnet',
  11155111: 'sepolia',
};

export interface ForkScheduleEntry {
  epoch: number;
  version: Uint8Array;
}

export interface BeaconNetworkConfig {
  genesisValidatorsRoot: Uint8Array;
  /** Ascending by epoch; compute_fork_version() picks the last entry with epoch <= target. */
  forkSchedule: ForkScheduleEntry[];
  electraForkEpoch: number;
  /** Unix seconds at slot 0 — public network constant, used only to derive "current slot" for the update-freshness check. */
  genesisTime: number;
}

export const SECONDS_PER_SLOT = 12;
export const SLOTS_PER_EPOCH = 32;
export const EPOCHS_PER_SYNC_COMMITTEE_PERIOD = 256;
export const SYNC_COMMITTEE_SIZE = 512;

function schedule(entries: [number, `0x${string}`][]): ForkScheduleEntry[] {
  return entries.map(([epoch, version]) => ({ epoch, version: hexToBytes(version) }));
}

const MAINNET: BeaconNetworkConfig = {
  genesisValidatorsRoot: hexToBytes('0x4b363db94e286120d76eb905340fdd4e54bfe9f06bf33ff6cf5ad27f511bfe95'),
  forkSchedule: schedule([
    [0, '0x00000000'], // Phase0 (Genesis)
    [74240, '0x01000000'], // Altair
    [144896, '0x02000000'], // Bellatrix
    [194048, '0x03000000'], // Capella
    [269568, '0x04000000'], // Deneb
    [364032, '0x05000000'], // Electra
  ]),
  electraForkEpoch: 364032,
  genesisTime: 1606824023,
};

const SEPOLIA: BeaconNetworkConfig = {
  genesisValidatorsRoot: hexToBytes('0xd8ea171f3c94aea21ebc42a1ed61052acf3f9209c00e4efbaaddac09ed9b8078'),
  forkSchedule: schedule([
    [0, '0x90000069'], // Phase0 (Genesis)
    [50, '0x90000070'], // Altair
    [100, '0x90000071'], // Bellatrix
    [56832, '0x90000072'], // Capella
    [132608, '0x90000073'], // Deneb
    [222464, '0x90000074'], // Electra
  ]),
  electraForkEpoch: 222464,
  genesisTime: 1655733600,
};

export const BEACON_NETWORKS: Record<BeaconNetwork, BeaconNetworkConfig> = {
  mainnet: MAINNET,
  sepolia: SEPOLIA,
};

export function beaconConfigForChain(chainId: number): BeaconNetworkConfig {
  const network = EL_CHAIN_TO_BEACON_NETWORK[chainId];
  if (!network) {
    throw new Error(
      `Chain ${chainId} has no beacon-chain light client network mapping — either it has no beacon ` +
        `chain (e.g. Polygon), or support needs to be added in beaconChainConfig.ts`,
    );
  }
  return BEACON_NETWORKS[network];
}

/** compute_fork_version(epoch) per the phase0 spec, using the pinned schedule above. */
export function computeForkVersion(config: BeaconNetworkConfig, epoch: number): Uint8Array {
  let active = config.forkSchedule[0];
  for (const entry of config.forkSchedule) {
    if (entry.epoch <= epoch) active = entry;
    else break;
  }
  return active.version;
}

/** Current slot derived from wall-clock time, used only for the update-freshness check in validate_light_client_update. */
export function currentSlot(config: BeaconNetworkConfig, nowMs: number = Date.now()): number {
  const elapsedSeconds = Math.floor(nowMs / 1000) - config.genesisTime;
  return Math.max(0, Math.floor(elapsedSeconds / SECONDS_PER_SLOT));
}
