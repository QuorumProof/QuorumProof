import { describe, it, expect, beforeAll } from 'vitest';
import { bls12_381 } from '@noble/curves/bls12-381.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  BeaconLightClientStore,
  LightClientError,
  hashTreeRootBeaconBlockHeader,
  hashTreeRootSyncCommittee,
  type BeaconBlockHeader,
  type LightClientBootstrap,
  type LightClientUpdate,
  type SyncCommittee,
} from '../src/services/beaconLightClient.js';
import { BEACON_NETWORKS } from '../src/services/beaconChainConfig.js';
import { merkleize, packUint64 } from '../src/services/ssz.js';
import { merkleProofForLeaf } from './helpers/merkleTree.js';

const SYNC_COMMITTEE_SIZE = 512;

function fixedHeader(slot: number, stateRoot: Uint8Array): BeaconBlockHeader {
  return {
    slot,
    proposerIndex: 7,
    parentRoot: new Uint8Array(32).fill(1),
    stateRoot,
    bodyRoot: new Uint8Array(32).fill(2),
  };
}

function sign(secretKeys: Uint8Array[], message: Uint8Array): Uint8Array {
  const point = bls12_381.longSignatures.hash(message, 'BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_');
  const sigs = secretKeys.map((sk) => bls12_381.longSignatures.sign(point, sk));
  return bls12_381.longSignatures.aggregateSignatures(sigs).toBytes(true);
}

function computeDomainForTest(forkVersion: Uint8Array): Uint8Array {
  const versionChunk = new Uint8Array(32);
  versionChunk.set(forkVersion);
  const forkDataRoot = merkleize([versionChunk, BEACON_NETWORKS.mainnet.genesisValidatorsRoot]);
  return new Uint8Array([...new Uint8Array([0x07, 0x00, 0x00, 0x00]), ...forkDataRoot.subarray(0, 28)]);
}
function computeSigningRootForTest(objectRoot: Uint8Array, domain: Uint8Array): Uint8Array {
  return merkleize([objectRoot, domain]);
}

// Mainnet epoch 300000 is post-Deneb, pre-Electra — gindices 54/55/105 and the plain (non-Electra) path apply.
const BOOTSTRAP_SLOT = 300000 * 32;

/**
 * Builds a fully self-consistent synthetic bootstrap + update pair: a 32-leaf "BeaconState" tree
 * for the bootstrap header (embedding current_sync_committee at gindex 54) and a second one for
 * the attested header (embedding next_sync_committee at gindex 55, and a Checkpoint{epoch, root}
 * at gindex 52 = parent(105) so finality_branch can prove gindex 105). Deterministic given the same
 * committees and `finalizedBodyRoot`, so callers can precompute an expensive BLS signature once and
 * reuse it across every test that doesn't need a different setup.
 */
function buildBootstrapAndUpdate(committeeA: SyncCommittee, committeeB: SyncCommittee, finalizedBodyRoot?: Uint8Array) {
  const committeeARoot = hashTreeRootSyncCommittee(committeeA);
  const committeeBRoot = hashTreeRootSyncCommittee(committeeB);

  const bootstrapStateLeaves = Array.from({ length: 32 }, (_, i) => new Uint8Array(32).fill(i + 10));
  bootstrapStateLeaves[22] = committeeARoot; // gindex 54 - 32 = 22
  const bootstrapStateRoot = merkleize(bootstrapStateLeaves);
  const bootstrapHeader = fixedHeader(BOOTSTRAP_SLOT, bootstrapStateRoot);
  const bootstrap: LightClientBootstrap = {
    header: { beacon: bootstrapHeader },
    currentSyncCommittee: committeeA,
    currentSyncCommitteeBranch: merkleProofForLeaf(bootstrapStateLeaves, 22),
  };
  const trustedBlockRoot = hashTreeRootBeaconBlockHeader(bootstrapHeader);

  const attestedSlot = BOOTSTRAP_SLOT + 10;
  const finalizedSlot = BOOTSTRAP_SLOT + 5;
  const finalizedStateRoot = merkleize(Array.from({ length: 32 }, (_, i) => new Uint8Array(32).fill(i + 50)));
  const finalizedHeader = fixedHeader(finalizedSlot, finalizedStateRoot);
  if (finalizedBodyRoot) finalizedHeader.bodyRoot = finalizedBodyRoot;
  const finalizedHeaderRoot = hashTreeRootBeaconBlockHeader(finalizedHeader);
  const checkpointEpoch = Math.floor(finalizedSlot / 32);
  const checkpointRoot = merkleize([packUint64(checkpointEpoch), finalizedHeaderRoot]);

  const attestedStateLeaves = Array.from({ length: 32 }, (_, i) => new Uint8Array(32).fill(i + 100));
  attestedStateLeaves[23] = committeeBRoot; // gindex 55 - 32 = 23 (next sync committee)
  attestedStateLeaves[20] = checkpointRoot; // gindex 52 - 32 = 20 (finalized_checkpoint field; 52 = parent(105))
  const attestedStateRoot = merkleize(attestedStateLeaves);
  const attestedHeader = fixedHeader(attestedSlot, attestedStateRoot);

  const nextSyncCommitteeBranch = merkleProofForLeaf(attestedStateLeaves, 23);
  // gindex 105 branch: [sibling of 'root' within Checkpoint{epoch,root} (i.e. the epoch chunk), ...proof of position 20]
  const finalityBranch = [packUint64(checkpointEpoch), ...merkleProofForLeaf(attestedStateLeaves, 20)];

  const signatureSlot = attestedSlot + 1;
  const forkVersion = new Uint8Array([0x04, 0x00, 0x00, 0x00]); // Deneb, matches epoch 300000's fork window
  const domain = computeDomainForTest(forkVersion);
  const signingRoot = computeSigningRootForTest(hashTreeRootBeaconBlockHeader(attestedHeader), domain);

  return { trustedBlockRoot, bootstrap, attestedHeader, finalizedHeader, finalityBranch, nextSyncCommitteeBranch, signatureSlot, signingRoot };
}

function buildCommittee(seedByte: number) {
  const keys = Array.from({ length: SYNC_COMMITTEE_SIZE }, (_, i) => {
    const seed = new Uint8Array(48); // Fr.ORDER's getMinHashLength — keygen() requires exactly this many seed bytes.
    seed[0] = seedByte;
    seed[1] = i & 0xff;
    seed[2] = (i >> 8) & 0xff;
    return bls12_381.longSignatures.keygen(seed);
  });
  const committee: SyncCommittee = {
    pubkeys: keys.map((k) => k.publicKey.toBytes(true)),
    aggregatePubkey: bls12_381.longSignatures.aggregatePublicKeys(keys.map((k) => k.publicKey)).toBytes(true),
  };
  return { keys, committee };
}

describe('BeaconLightClientStore (Altair sync-committee protocol, real BLS12-381)', () => {
  let dataDir: string;
  let committeeA: ReturnType<typeof buildCommittee>;
  let committeeB: ReturnType<typeof buildCommittee>;
  let setup: ReturnType<typeof buildBootstrapAndUpdate>;
  /** A genuine full-committee signature over `setup.signingRoot` — expensive (512 BLS signs), computed once. */
  let fullQuorumSignature: Uint8Array;

  beforeAll(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beacon-lc-test-'));
    committeeA = buildCommittee(0xaa);
    committeeB = buildCommittee(0xbb);
    setup = buildBootstrapAndUpdate(committeeA.committee, committeeB.committee);
    fullQuorumSignature = sign(
      committeeA.keys.map((k) => k.secretKey),
      setup.signingRoot,
    );
  }, 120_000);

  function freshStore(): BeaconLightClientStore {
    return new BeaconLightClientStore(fs.mkdtempSync(path.join(dataDir, 'run-')));
  }

  function fullParticipationUpdate(overrides: Partial<LightClientUpdate> = {}): LightClientUpdate {
    return {
      attestedHeader: { beacon: setup.attestedHeader },
      nextSyncCommittee: committeeB.committee,
      nextSyncCommitteeBranch: setup.nextSyncCommitteeBranch,
      finalizedHeader: { beacon: setup.finalizedHeader },
      finalityBranch: setup.finalityBranch,
      syncAggregate: { syncCommitteeBits: new Array(SYNC_COMMITTEE_SIZE).fill(true), syncCommitteeSignature: fullQuorumSignature },
      signatureSlot: setup.signatureSlot,
      ...overrides,
    };
  }

  it('bootstraps from a trusted checkpoint root', () => {
    const store = freshStore();
    expect(() => store.bootstrap(1, setup.trustedBlockRoot, setup.bootstrap)).not.toThrow();
    expect(store.get('mainnet')).toBeDefined();
  });

  it('rejects bootstrap against the wrong trusted block root', () => {
    const store = freshStore();
    const wrongRoot = new Uint8Array(32).fill(0xff);
    expect(() => store.bootstrap(1, wrongRoot, setup.bootstrap)).toThrow(LightClientError);
  });

  it('rejects bootstrap with a tampered sync-committee Merkle branch', () => {
    const store = freshStore();
    const tampered: LightClientBootstrap = {
      ...setup.bootstrap,
      currentSyncCommitteeBranch: setup.bootstrap.currentSyncCommitteeBranch.map((b) => new Uint8Array(b).fill(0)),
    };
    expect(() => store.bootstrap(1, setup.trustedBlockRoot, tampered)).toThrow(LightClientError);
  });

  it('applies a genuinely-signed update, advancing the finalized header and learning the next sync committee', () => {
    const store = freshStore();
    store.bootstrap(1, setup.trustedBlockRoot, setup.bootstrap);

    const result = store.applyUpdate(1, fullParticipationUpdate());
    expect(result.beacon.slot).toBe(setup.finalizedHeader.slot);

    const stored = store.get('mainnet')!;
    expect(hashTreeRootSyncCommittee(stored.nextSyncCommittee!)).toEqual(hashTreeRootSyncCommittee(committeeB.committee));
  });

  it('rejects an update signed by fewer than a supermajority of the sync committee', () => {
    const store = freshStore();
    store.bootstrap(1, setup.trustedBlockRoot, setup.bootstrap);

    // Only 100 of 512 (well under 2/3) sign — cheap enough to compute fresh in this one test.
    const signers = committeeA.keys.slice(0, 100);
    const signature = sign(
      signers.map((k) => k.secretKey),
      setup.signingRoot,
    );
    const bits = new Array(SYNC_COMMITTEE_SIZE).fill(false);
    for (let i = 0; i < 100; i++) bits[i] = true;

    // Signature itself is genuinely valid (100 real signers over the real signing root), but the
    // bridge must not advance finality on anything short of a supermajority.
    const result = store.applyUpdate(1, fullParticipationUpdate({ syncAggregate: { syncCommitteeBits: bits, syncCommitteeSignature: signature } }));
    expect(result.beacon.slot).toBe(setup.bootstrap.header.beacon.slot); // unchanged — still the bootstrap header
  });

  it('rejects a corrupted signature even with full, honestly-claimed participation bits', () => {
    const store = freshStore();
    store.bootstrap(1, setup.trustedBlockRoot, setup.bootstrap);
    const corrupted = new Uint8Array(fullQuorumSignature);
    corrupted[0] ^= 0xff;
    expect(() => store.applyUpdate(1, fullParticipationUpdate({ syncAggregate: { syncCommitteeBits: new Array(SYNC_COMMITTEE_SIZE).fill(true), syncCommitteeSignature: corrupted } }))).toThrow(
      LightClientError,
    );
  });

  it('rejects a tampered finality_branch', () => {
    const store = freshStore();
    store.bootstrap(1, setup.trustedBlockRoot, setup.bootstrap);
    const update = fullParticipationUpdate({ finalityBranch: setup.finalityBranch.map((b) => new Uint8Array(b).fill(0xab)) });
    expect(() => store.applyUpdate(1, update)).toThrow(LightClientError);
  });

  it('verifies an execution-layer block hash against the light-client-finalized header, and rejects a wrong one', () => {
    // Build a body tree whose gindex-812 leaf is the claimed EL block hash, and pin the finalized
    // header's bodyRoot to it *before* hashing/signing (headers are content-addressed, so this needs
    // its own setup + signature rather than reusing the shared `setup`/`fullQuorumSignature`).
    const blockHash = new Uint8Array(32).fill(0x42);
    const bodyLeaves = Array.from({ length: 512 }, (_, i) => new Uint8Array(32).fill(i % 256));
    bodyLeaves[812 - 512] = blockHash; // depth-9 tree (512 leaves), gindex 812 -> position 300
    const bodyRoot = merkleize(bodyLeaves);
    const proof = merkleProofForLeaf(bodyLeaves, 812 - 512);

    const store = freshStore();
    const localSetup = buildBootstrapAndUpdate(committeeA.committee, committeeB.committee, bodyRoot);
    store.bootstrap(1, localSetup.trustedBlockRoot, localSetup.bootstrap);
    const signature = sign(
      committeeA.keys.map((k) => k.secretKey),
      localSetup.signingRoot,
    );
    const update: LightClientUpdate = {
      attestedHeader: { beacon: localSetup.attestedHeader },
      nextSyncCommittee: committeeB.committee,
      nextSyncCommitteeBranch: localSetup.nextSyncCommitteeBranch,
      finalizedHeader: { beacon: localSetup.finalizedHeader },
      finalityBranch: localSetup.finalityBranch,
      syncAggregate: { syncCommitteeBits: new Array(SYNC_COMMITTEE_SIZE).fill(true), syncCommitteeSignature: signature },
      signatureSlot: localSetup.signatureSlot,
    };
    const finalized = store.applyUpdate(1, update);
    expect(finalized.beacon.bodyRoot).toEqual(bodyRoot);

    const verifiedHeader = store.verifyExecutionBlockHash(1, blockHash, proof);
    expect(verifiedHeader.slot).toBe(localSetup.finalizedHeader.slot);

    const wrongBlockHash = new Uint8Array(32).fill(0x99);
    expect(() => store.verifyExecutionBlockHash(1, wrongBlockHash, proof)).toThrow(LightClientError);
  });
});
