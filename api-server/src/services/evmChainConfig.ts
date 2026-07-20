/**
 * Per-chain header RLP schema configuration — Issue #880 hardening.
 *
 * Block header hash verification (see `blockHeaderStore.ts`) needs to know
 * exactly which fields a chain's header RLP includes, because that's
 * hardfork- and consensus-specific:
 *
 *  - Ethereum mainnet/Sepolia: field layout is precisely determined by
 *    block number + timestamp via the real, actively-maintained hardfork
 *    schedule baked into `@ethereumjs/common`'s `Mainnet`/`Sepolia`
 *    presets. We let it auto-detect (`setHardfork: true`) rather than
 *    pinning a hardfork, so this keeps working as new hardforks activate
 *    without a code change here.
 *
 *  - Polygon PoS (Bor): not a preset chain in `@ethereumjs/common`, and its
 *    consensus (Clique-derived PoA) produces a larger `extraData` than
 *    Ethereum's client-side validation allows, so consensus-format checks
 *    are skipped. Polygon has had EIP-1559 (`baseFeePerGas`) since Jan 2022
 *    but — lacking a beacon chain — never gained `withdrawalsRoot` /
 *    `blobGasUsed` / `parentBeaconBlockRoot`, so its header shape matches
 *    Ethereum's "London" hardfork field set. This is a **pinned
 *    approximation**, not a real schedule: if Polygon's header format ever
 *    changes, checkpointing fails closed (hash mismatch) rather than
 *    silently miscomputing — but it does mean this file needs a manual
 *    update if/when that happens.
 *
 *  - Goerli / Mumbai: both deprecated/shut down testnets, kept mapped only
 *    so `SUPPORTED_CHAINS` doesn't hard-crash; approximated the same way as
 *    Polygon.
 */
import { createCustomCommon, Mainnet, Sepolia, Hardfork, type Common } from '@ethereumjs/common';

export const SUPPORTED_CHAINS: Record<number, string> = {
  1: 'Ethereum Mainnet',
  5: 'Ethereum Goerli',
  11155111: 'Ethereum Sepolia',
  137: 'Polygon Mainnet',
  80001: 'Polygon Mumbai',
};

export interface ChainHeaderSchema {
  common: Common;
  /** true = auto-detect hardfork from (blockNumber, timestamp) via the chain's real schedule. */
  setHardfork: boolean;
}

const SCHEMA_BUILDERS: Record<number, () => ChainHeaderSchema> = {
  1: () => ({ common: createCustomCommon({ chainId: 1 }, Mainnet), setHardfork: true }),
  11155111: () => ({ common: createCustomCommon({ chainId: 11155111 }, Sepolia), setHardfork: true }),
  5: () => ({ common: createCustomCommon({ chainId: 5 }, Mainnet, { hardfork: Hardfork.Paris }), setHardfork: false }),
  137: () => ({ common: createCustomCommon({ chainId: 137 }, Mainnet, { hardfork: Hardfork.London }), setHardfork: false }),
  80001: () => ({ common: createCustomCommon({ chainId: 80001 }, Mainnet, { hardfork: Hardfork.London }), setHardfork: false }),
};

export function headerSchemaForChain(chainId: number): ChainHeaderSchema {
  const build = SCHEMA_BUILDERS[chainId];
  if (!build) {
    throw new Error(
      `No header RLP schema mapping for chain ${chainId} — add one in evmChainConfig.ts before checkpointing headers for this chain`,
    );
  }
  return build();
}

/**
 * Confirmation depth required before accepting a header as checkpointed when
 * the relay can't supply a `finalized`/`safe` RPC tag (see blockHeaderStore.ts).
 * Deliberately conservative; these are not consensus-derived, just an
 * operational safety margin against short reorgs.
 */
export const MIN_CONFIRMATIONS: Record<number, number> = {
  1: 12,
  11155111: 12,
  5: 12,
  137: 128,
  80001: 128,
};
