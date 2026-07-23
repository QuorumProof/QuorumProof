/**
 * Ethereum Altair light-client sync-committee protocol — closes the gap
 * documented in `blockHeaderStore.ts`: instead of trusting a relay's RPC
 * provider to honestly report which beacon block is "finalized", this module
 * independently verifies that a beacon block was actually finalized by
 * checking a BLS aggregate signature from the (>=2/3-participating) sync
 * committee against it, per the consensus spec
 * (https://github.com/ethereum/consensus-specs/blob/dev/specs/altair/light-client/sync-protocol.md).
 *
 * TRUST MODEL: a light client (this one included) is bootstrapped from a
 * single trusted checkpoint block root (a "weak subjectivity checkpoint") —
 * that is the one fact this module takes on faith, exactly like every other
 * Ethereum light client (Helios, Lodestar's light client mode, etc.). From
 * that point on, every `next_sync_committee` and `finalized_header` is
 * cryptographically derived: the sync committee that must sign the *next*
 * period's updates is itself Merkle-proven against a header the *previous*
 * committee signed, so an attacker who doesn't control a supermajority of
 * some past sync committee cannot forge a transition. This replaces the
 * "trust the RPC's `finalized` tag" assumption in `blockHeaderStore.ts` with
 * "trust one checkpoint root, obtained out of band (e.g. a checkpoint sync
 * provider, or a node you ran yourself), at bootstrap time only."
 *
 * SCOPE: implements the protocol for Ethereum mainnet and Sepolia
 * (`beaconChainConfig.ts`) from the Altair fork through Electra. Binding a
 * light-client-verified beacon header to a specific *execution-layer* block
 * hash (`verifyExecutionBlockHash`) is pinned to the post-Deneb
 * `BeaconBlockBody` / `ExecutionPayload` layout (see the gindex comment
 * below) — both networks have been past Deneb since March 2024, so this
 * covers the live chain; a pre-Deneb historical header would need a
 * different generalized index and isn't supported here.
 */
import { bls12_381 } from '@noble/curves/bls12-381.js';
import path from 'path';
import { DurableLog } from './durableLog.js';
import {
  beaconConfigForChain,
  computeForkVersion,
  currentSlot as computeCurrentSlot,
  EL_CHAIN_TO_BEACON_NETWORK,
  SLOTS_PER_EPOCH,
  EPOCHS_PER_SYNC_COMMITTEE_PERIOD,
  SYNC_COMMITTEE_SIZE,
  type BeaconNetworkConfig,
} from './beaconChainConfig.js';
import { merkleize, packUint64, hashTreeRootBytes, verifyMerkleBranch, concatBytes, bytesEqual } from './ssz.js';

export class LightClientError extends Error {}

// --- SSZ types -------------------------------------------------------------

export interface BeaconBlockHeader {
  slot: number;
  proposerIndex: number;
  parentRoot: Uint8Array;
  stateRoot: Uint8Array;
  bodyRoot: Uint8Array;
}

export interface LightClientHeader {
  beacon: BeaconBlockHeader;
}

export interface SyncCommittee {
  /** SYNC_COMMITTEE_SIZE (512) compressed BLS12-381 G1 pubkeys, 48 bytes each. */
  pubkeys: Uint8Array[];
  aggregatePubkey: Uint8Array;
}

export interface SyncAggregate {
  /** Participation bitvector, length SYNC_COMMITTEE_SIZE — bits[i] true iff pubkeys[i] signed. */
  syncCommitteeBits: boolean[];
  /** Compressed BLS12-381 G2 signature, 96 bytes. */
  syncCommitteeSignature: Uint8Array;
}

export interface LightClientBootstrap {
  header: LightClientHeader;
  currentSyncCommittee: SyncCommittee;
  currentSyncCommitteeBranch: Uint8Array[];
}

export interface LightClientUpdate {
  attestedHeader: LightClientHeader;
  nextSyncCommittee?: SyncCommittee;
  nextSyncCommitteeBranch?: Uint8Array[];
  finalizedHeader?: LightClientHeader;
  finalityBranch?: Uint8Array[];
  syncAggregate: SyncAggregate;
  signatureSlot: number;
}

interface StoredLightClientState {
  finalizedHeader: LightClientHeader;
  currentSyncCommittee: SyncCommittee;
  nextSyncCommittee: SyncCommittee | null;
}

// --- Constants ---------------------------------------------------------------

const DOMAIN_SYNC_COMMITTEE = new Uint8Array([0x07, 0x00, 0x00, 0x00]);
const BLS_SIG_POP_DST = 'BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_';
const GENESIS_SLOT = 0;

// get_generalized_index(altair.BeaconState, 'finalized_checkpoint', 'root'), etc. — frozen at
// their Altair values; Electra restructured BeaconState and re-derives new ones.
const FINALIZED_ROOT_GINDEX = 105n;
const CURRENT_SYNC_COMMITTEE_GINDEX = 54n;
const NEXT_SYNC_COMMITTEE_GINDEX = 55n;
const FINALIZED_ROOT_GINDEX_ELECTRA = 169n;
const CURRENT_SYNC_COMMITTEE_GINDEX_ELECTRA = 86n;
const NEXT_SYNC_COMMITTEE_GINDEX_ELECTRA = 87n;

/**
 * get_generalized_index(BeaconBlockBody, 'execution_payload', 'block_hash'), Deneb/Electra
 * layout: execution_payload is field 9 of 12-13 (next_pow2=16) => 1*16+9=25; block_hash is
 * field 12 of 17 (next_pow2=32) => 25*32+12=812. Stable across Deneb->Electra because
 * `execution_payload`'s position and the ExecutionPayload container itself are unchanged
 * between those forks (Electra only appends a new BeaconBlockBody field after it).
 */
const EXECUTION_PAYLOAD_BLOCK_HASH_GINDEX = 812n;

// --- SSZ hashing for the types above ----------------------------------------

export function hashTreeRootBeaconBlockHeader(header: BeaconBlockHeader): Uint8Array {
  return merkleize([
    packUint64(header.slot),
    packUint64(header.proposerIndex),
    header.parentRoot,
    header.stateRoot,
    header.bodyRoot,
  ]);
}

export function hashTreeRootSyncCommittee(committee: SyncCommittee): Uint8Array {
  if (committee.pubkeys.length !== SYNC_COMMITTEE_SIZE) {
    throw new LightClientError(`SyncCommittee.pubkeys must have exactly ${SYNC_COMMITTEE_SIZE} entries`);
  }
  const pubkeysRoot = merkleize(committee.pubkeys.map(hashTreeRootBytes));
  const aggregateRoot = hashTreeRootBytes(committee.aggregatePubkey);
  return merkleize([pubkeysRoot, aggregateRoot]);
}

function computeForkDataRoot(version: Uint8Array, genesisValidatorsRoot: Uint8Array): Uint8Array {
  const versionChunk = new Uint8Array(32);
  versionChunk.set(version);
  return merkleize([versionChunk, genesisValidatorsRoot]);
}

function computeDomain(domainType: Uint8Array, forkVersion: Uint8Array, genesisValidatorsRoot: Uint8Array): Uint8Array {
  const forkDataRoot = computeForkDataRoot(forkVersion, genesisValidatorsRoot);
  return concatBytes(domainType, forkDataRoot.subarray(0, 28));
}

function computeSigningRoot(objectRoot: Uint8Array, domain: Uint8Array): Uint8Array {
  return merkleize([objectRoot, domain]);
}

function computeEpochAtSlot(slot: number): number {
  return Math.floor(slot / SLOTS_PER_EPOCH);
}

function computeSyncCommitteePeriodAtSlot(slot: number): number {
  return Math.floor(computeEpochAtSlot(slot) / EPOCHS_PER_SYNC_COMMITTEE_PERIOD);
}

function finalizedRootGindexAtSlot(config: BeaconNetworkConfig, slot: number): bigint {
  return computeEpochAtSlot(slot) >= config.electraForkEpoch ? FINALIZED_ROOT_GINDEX_ELECTRA : FINALIZED_ROOT_GINDEX;
}
function currentSyncCommitteeGindexAtSlot(config: BeaconNetworkConfig, slot: number): bigint {
  return computeEpochAtSlot(slot) >= config.electraForkEpoch
    ? CURRENT_SYNC_COMMITTEE_GINDEX_ELECTRA
    : CURRENT_SYNC_COMMITTEE_GINDEX;
}
function nextSyncCommitteeGindexAtSlot(config: BeaconNetworkConfig, slot: number): bigint {
  return computeEpochAtSlot(slot) >= config.electraForkEpoch ? NEXT_SYNC_COMMITTEE_GINDEX_ELECTRA : NEXT_SYNC_COMMITTEE_GINDEX;
}

const EMPTY_HEADER: BeaconBlockHeader = {
  slot: 0,
  proposerIndex: 0,
  parentRoot: new Uint8Array(32),
  stateRoot: new Uint8Array(32),
  bodyRoot: new Uint8Array(32),
};

function isEmptyLightClientHeader(header: LightClientHeader | undefined): boolean {
  if (!header) return true;
  return bytesEqual(hashTreeRootBeaconBlockHeader(header.beacon), hashTreeRootBeaconBlockHeader(EMPTY_HEADER));
}

// --- BLS aggregate signature verification -----------------------------------

/**
 * bls.FastAggregateVerify(pubkeys, message, signature) per
 * draft-irtf-cfrg-bls-signature, ciphersuite BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_
 * (Ethereum consensus uses the "long signature" / minimal-pubkey-size mode: 48-byte G1
 * pubkeys, 96-byte G2 signatures).
 */
function fastAggregateVerify(pubkeys: Uint8Array[], message: Uint8Array, signature: Uint8Array): boolean {
  if (pubkeys.length === 0) return false;
  try {
    const messagePoint = bls12_381.longSignatures.hash(message, BLS_SIG_POP_DST);
    const aggregatePubkey = bls12_381.longSignatures.aggregatePublicKeys(pubkeys);
    return bls12_381.longSignatures.verify(signature, messagePoint, aggregatePubkey);
  } catch {
    return false;
  }
}

// --- Store -------------------------------------------------------------------

export class BeaconLightClientStore {
  private readonly log: DurableLog<StoredLightClientState>;

  constructor(dataDir?: string) {
    const dir = dataDir ?? process.env.BRIDGE_STORE_DATA_DIR ?? path.join(process.cwd(), '.data', 'bridge');
    this.log = new DurableLog<StoredLightClientState>(path.join(dir, 'light-client-store.jsonl'));
  }

  private key(network: string): string {
    return `beacon:${network}`;
  }

  get(network: string): StoredLightClientState | undefined {
    return this.log.get(this.key(network));
  }

  private set(network: string, state: StoredLightClientState): void {
    this.log.set(this.key(network), state);
  }

  /**
   * initialize_light_client_store: establishes the trust anchor. `trustedBlockRoot` must be
   * obtained out of band (a checkpoint-sync provider, or your own beacon node) — this is the
   * one fact the whole light client chain of trust rests on.
   */
  bootstrap(chainId: number, trustedBlockRoot: Uint8Array, bootstrap: LightClientBootstrap): void {
    const config = beaconConfigForChain(chainId);
    const network = networkNameForChain(chainId);

    const headerRoot = hashTreeRootBeaconBlockHeader(bootstrap.header.beacon);
    if (!bytesEqual(headerRoot, trustedBlockRoot)) {
      throw new LightClientError('Bootstrap header does not hash to the trusted checkpoint block root');
    }

    const committeeRoot = hashTreeRootSyncCommittee(bootstrap.currentSyncCommittee);
    const gindex = currentSyncCommitteeGindexAtSlot(config, bootstrap.header.beacon.slot);
    if (!verifyMerkleBranch(committeeRoot, bootstrap.currentSyncCommitteeBranch, gindex, bootstrap.header.beacon.stateRoot)) {
      throw new LightClientError('current_sync_committee Merkle branch does not verify against the bootstrap header\'s state root');
    }

    this.set(network, {
      finalizedHeader: bootstrap.header,
      currentSyncCommittee: bootstrap.currentSyncCommittee,
      nextSyncCommittee: null,
    });
  }

  /**
   * validate_light_client_update + apply_light_client_update, with the bridge-specific
   * supermajority requirement from BRIDGE_MIN_SYNC_COMMITTEE_PARTICIPANTS layered on top.
   * Throws LightClientError (and leaves the store untouched) on any failed check; on success,
   * persists and returns the (possibly-advanced) finalized header.
   */
  applyUpdate(chainId: number, update: LightClientUpdate, nowMs?: number): LightClientHeader {
    const config = beaconConfigForChain(chainId);
    const network = networkNameForChain(chainId);
    const store = this.get(network);
    if (!store) {
      throw new LightClientError(`No bootstrap state for ${network} — call bootstrap() before applyUpdate()`);
    }

    const participantCount = update.syncAggregate.syncCommitteeBits.filter(Boolean).length;
    if (participantCount < 1) {
      throw new LightClientError('sync committee has zero participants');
    }

    const attestedSlot = update.attestedHeader.beacon.slot;
    const finalizedSlot = update.finalizedHeader?.beacon.slot ?? GENESIS_SLOT;
    const nowSlot = computeCurrentSlot(config, nowMs);
    if (!(nowSlot >= update.signatureSlot && update.signatureSlot > attestedSlot && attestedSlot >= finalizedSlot)) {
      throw new LightClientError(
        `Update slot ordering invalid: expected current(${nowSlot}) >= signature(${update.signatureSlot}) > attested(${attestedSlot}) >= finalized(${finalizedSlot})`,
      );
    }

    const storePeriod = computeSyncCommitteePeriodAtSlot(store.finalizedHeader.beacon.slot);
    const updateSignaturePeriod = computeSyncCommitteePeriodAtSlot(update.signatureSlot);
    const nextKnown = store.nextSyncCommittee !== null;
    if (nextKnown) {
      if (updateSignaturePeriod !== storePeriod && updateSignaturePeriod !== storePeriod + 1) {
        throw new LightClientError(`Update signature period ${updateSignaturePeriod} skips a sync committee period (store is at ${storePeriod})`);
      }
    } else if (updateSignaturePeriod !== storePeriod) {
      throw new LightClientError(`Update signature period ${updateSignaturePeriod} does not match store period ${storePeriod} (next committee unknown)`);
    }

    const hasNextSyncCommittee = !!update.nextSyncCommittee && !!update.nextSyncCommitteeBranch;
    const updateAttestedPeriod = computeSyncCommitteePeriodAtSlot(attestedSlot);
    const updateHasNextSyncCommittee = !nextKnown && hasNextSyncCommittee && updateAttestedPeriod === storePeriod;
    if (!(attestedSlot > store.finalizedHeader.beacon.slot || updateHasNextSyncCommittee)) {
      throw new LightClientError('Update is not relevant: attested header is not newer and carries no new next_sync_committee');
    }

    const isFinalityUpdate = !!update.finalizedHeader && !!update.finalityBranch && !isEmptyLightClientHeader(update.finalizedHeader);
    if (isFinalityUpdate) {
      const finalizedRoot =
        finalizedSlot === GENESIS_SLOT ? new Uint8Array(32) : hashTreeRootBeaconBlockHeader(update.finalizedHeader!.beacon);
      const gindex = finalizedRootGindexAtSlot(config, attestedSlot);
      if (!verifyMerkleBranch(finalizedRoot, update.finalityBranch!, gindex, update.attestedHeader.beacon.stateRoot)) {
        throw new LightClientError('finality_branch does not verify against the attested header\'s state root');
      }
    }

    if (hasNextSyncCommittee) {
      if (updateAttestedPeriod === storePeriod && nextKnown) {
        if (!bytesEqual(hashTreeRootSyncCommittee(update.nextSyncCommittee!), hashTreeRootSyncCommittee(store.nextSyncCommittee!))) {
          throw new LightClientError('next_sync_committee conflicts with the already-known committee for this period');
        }
      }
      const nextCommitteeRoot = hashTreeRootSyncCommittee(update.nextSyncCommittee!);
      const gindex = nextSyncCommitteeGindexAtSlot(config, attestedSlot);
      if (!verifyMerkleBranch(nextCommitteeRoot, update.nextSyncCommitteeBranch!, gindex, update.attestedHeader.beacon.stateRoot)) {
        throw new LightClientError('next_sync_committee Merkle branch does not verify against the attested header\'s state root');
      }
    }

    const signingCommittee = updateSignaturePeriod === storePeriod ? store.currentSyncCommittee : store.nextSyncCommittee;
    if (!signingCommittee) {
      throw new LightClientError('No sync committee known for the update\'s signature period');
    }
    const participantPubkeys = signingCommittee.pubkeys.filter((_, i) => update.syncAggregate.syncCommitteeBits[i]);

    const forkVersionSlot = Math.max(update.signatureSlot, 1) - 1;
    const forkVersion = computeForkVersion(config, computeEpochAtSlot(forkVersionSlot));
    const domain = computeDomain(DOMAIN_SYNC_COMMITTEE, forkVersion, config.genesisValidatorsRoot);
    const signingRoot = computeSigningRoot(hashTreeRootBeaconBlockHeader(update.attestedHeader.beacon), domain);

    if (!fastAggregateVerify(participantPubkeys, signingRoot, update.syncAggregate.syncCommitteeSignature)) {
      throw new LightClientError('Sync committee aggregate signature does not verify');
    }

    // --- process_light_client_update's "normal update through 2/3 threshold" gate ---
    // Only a supermajority-signed update advances `finalizedHeader`; this module doesn't
    // implement the spec's separate (weaker) optimistic-head tracking, since a bridge has no
    // use for a "probably fine" header — it needs the real finality safety property.
    const hasSupermajority = participantCount * 3 >= SYNC_COMMITTEE_SIZE * 2;
    const updateFinalizedPeriod = computeSyncCommitteePeriodAtSlot(finalizedSlot);
    const updateHasFinalizedNextSyncCommittee =
      !nextKnown && hasNextSyncCommittee && isFinalityUpdate && updateFinalizedPeriod === updateAttestedPeriod;
    const shouldApply =
      hasSupermajority && (finalizedSlot > store.finalizedHeader.beacon.slot || updateHasFinalizedNextSyncCommittee);
    if (!shouldApply) {
      return store.finalizedHeader;
    }

    const next = { ...store };
    if (!nextKnown) {
      if (updateFinalizedPeriod === storePeriod) next.nextSyncCommittee = update.nextSyncCommittee ?? null;
    } else if (updateFinalizedPeriod === storePeriod + 1) {
      next.currentSyncCommittee = store.nextSyncCommittee!;
      next.nextSyncCommittee = update.nextSyncCommittee ?? null;
    }
    if (finalizedSlot > store.finalizedHeader.beacon.slot) {
      next.finalizedHeader = update.finalizedHeader!;
    }

    this.set(network, next);
    return next.finalizedHeader;
  }

  /**
   * Verify that `blockHash` (an execution-layer block hash) is committed to by the
   * light-client-verified finalized header's `bodyRoot`, via a Merkle proof of
   * `BeaconBlockBody.execution_payload.block_hash`. This is what actually binds a
   * specific EL block to consensus-verified finality, closing the gap `blockHeaderStore.ts`
   * documents (which only ever had the RPC's word for "finalized").
   */
  verifyExecutionBlockHash(chainId: number, blockHash: Uint8Array, proof: Uint8Array[]): BeaconBlockHeader {
    const network = networkNameForChain(chainId);
    const store = this.get(network);
    if (!store) throw new LightClientError(`No bootstrap state for ${network}`);
    if (!verifyMerkleBranch(blockHash, proof, EXECUTION_PAYLOAD_BLOCK_HASH_GINDEX, store.finalizedHeader.beacon.bodyRoot)) {
      throw new LightClientError('execution_payload.block_hash Merkle proof does not verify against the finalized beacon header\'s body root');
    }
    return store.finalizedHeader.beacon;
  }
}

function networkNameForChain(chainId: number): string {
  const network = EL_CHAIN_TO_BEACON_NETWORK[chainId];
  if (!network) throw new LightClientError(`Chain ${chainId} has no beacon-chain light client network mapping`);
  return network;
}

let defaultStore: BeaconLightClientStore | undefined;
export function getDefaultBeaconLightClientStore(): BeaconLightClientStore {
  if (!defaultStore) defaultStore = new BeaconLightClientStore();
  return defaultStore;
}
/** Test-only: force the module to construct a fresh default store. */
export function _setDefaultBeaconLightClientStoreForTest(store: BeaconLightClientStore | undefined): void {
  defaultStore = store;
}
