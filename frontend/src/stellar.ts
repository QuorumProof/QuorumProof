/**
 * stellar.ts — Soroban RPC read-only wrapper for QuorumProof.
 *
 * All functions simulate contract calls without a wallet (no auth needed
 * for read-only methods).  Results are parsed from XDR ScVal.
 */

import {
  Contract,
  Networks,
  rpc as StellarRpc,
  scValToNative,
  xdr,
  nativeToScVal,
  Address,
} from '@stellar/stellar-sdk';
import {
  STELLAR_NETWORK,
  CONTRACT_QUORUM_PROOF,
  CONTRACT_ZK_VERIFIER,
  STELLAR_RPC_URL,
} from './config/env';
import { getRpcClient } from './lib/rpcClient';
import { handleContractError } from './lib/handleContractError';
import { onNetworkChange } from './lib/networkConfig';

/** Stellar network passphrase map */
const PASSPHRASES: Record<string, string> = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
  futurenet: Networks.FUTURENET,
};

let networkPassphrase = PASSPHRASES[STELLAR_NETWORK] || Networks.TESTNET;

onNetworkChange((config) => {
  networkPassphrase = PASSPHRASES[config.network] || Networks.TESTNET;
  void config;
});

/**
 * Simulate a read-only contract call and return the parsed native JS value.
 */
async function simulate(contractId: string, method: string, args: any[] = []): Promise<any> {
  if (!contractId) {
    throw new Error(
      'Contract ID not configured. Set VITE_CONTRACT_QUORUM_PROOF in .env'
    );
  }

  const contract = new Contract(contractId);

  // Build a transaction to simulate (no source account needed for simulation)
  const { TransactionBuilder, Keypair, Account, BASE_FEE } =
    await import('@stellar/stellar-sdk');

  // Use a dummy source account for simulation
  const dummyKeypair = Keypair.random();
  const dummyAccount = new Account(dummyKeypair.publicKey(), '0');

  const tx = new TransactionBuilder(dummyAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  try {
    const result = await getRpcClient().simulateTransaction(tx);

    if (StellarRpc.Api.isSimulationError(result)) {
      throw new Error(result.error || 'Simulation failed');
    }

    if (!result.result) {
      throw new Error('No result returned from simulation');
    }

    return scValToNative(result.result.retval);
  } catch (error) {
    throw new Error(handleContractError(error));
  }
}

/**
 * Retrieve a credential by numeric ID.
 * Returns a plain JS object with fields: id, subject, issuer, credential_type,
 * metadata_hash, revoked, expires_at.
 * Throws if the credential does not exist.
 */
export async function getCredential(credentialId: string | number | bigint) {
  try {
    const idVal = nativeToScVal(BigInt(credentialId), { type: 'u64' }) as any;
    return await simulate(CONTRACT_QUORUM_PROOF, 'get_credential', [idVal]);
  } catch (error) {
    throw new Error(handleContractError(error));
  }
}

/**
 * Get all credential IDs issued to a Stellar address (subject lookup).
 * Returns an array of BigInt credential IDs (may be empty).
 */
export async function getCredentialsBySubject(stellarAddress: string) {
  try {
    const addressVal = new Address(stellarAddress).toScVal();
    return await simulate(CONTRACT_QUORUM_PROOF, 'get_credentials_by_subject', [addressVal]);
  } catch (error) {
    throw new Error(handleContractError(error));
  }
}

/**
 * Check whether a credential has reached its quorum threshold.
 */
export async function isAttested(credentialId: string | number | bigint, sliceId: string | number | bigint): Promise<boolean> {
  try {
    const credVal = nativeToScVal(BigInt(credentialId), { type: 'u64' }) as any;
    const sliceVal = nativeToScVal(BigInt(sliceId), { type: 'u64' }) as any;
    return await simulate(CONTRACT_QUORUM_PROOF, 'is_attested', [credVal, sliceVal]);
  } catch (error) {
    throw new Error(handleContractError(error));
  }
}

/**
 * Get all attestor addresses for a credential.
 */
export async function getAttestors(credentialId: string | number | bigint): Promise<string[]> {
  try {
    const credVal = nativeToScVal(BigInt(credentialId), { type: 'u64' }) as any;
    return await simulate(CONTRACT_QUORUM_PROOF, 'get_attestors', [credVal]);
  } catch (error) {
    throw new Error(handleContractError(error));
  }
}

/**
 * Check whether a credential is expired.
 */
export async function isExpired(credentialId: string | number | bigint): Promise<boolean> {
  try {
    const credVal = nativeToScVal(BigInt(credentialId), { type: 'u64' }) as any;
    return await simulate(CONTRACT_QUORUM_PROOF, 'is_expired', [credVal]);
  } catch (error) {
    throw new Error(handleContractError(error));
  }
}

/**
 * Retrieve a quorum slice by ID.
 * Returns the QuorumSlice struct: { id, creator, attestors, threshold }
 */
export async function getSlice(sliceId: string | number | bigint) {
  try {
    const sliceVal = nativeToScVal(BigInt(sliceId), { type: 'u64' }) as any;
    return await simulate(CONTRACT_QUORUM_PROOF, 'get_slice', [sliceVal]);
  } catch (error) {
    throw new Error(handleContractError(error));
  }
}

/**
 * Verify a ZK claim against the ZK verifier contract.
 */
export async function verifyClaim(credentialId: string | number | bigint, claimType: string, proofHex: string): Promise<boolean> {
  try {
    if (!CONTRACT_ZK_VERIFIER) {
      throw new Error(
        'ZK Contract ID not configured. Set VITE_CONTRACT_ZK_VERIFIER in .env'
      );
    }
    const credVal = nativeToScVal(BigInt(credentialId), { type: 'u64' }) as any;
    const claimVal = nativeToScVal(claimType, { type: 'string' }) as any;
    const proofBytes = hexToBytes(proofHex);
    const proofVal = xdr.ScVal.scvBytes(proofBytes);
    return await simulate(CONTRACT_ZK_VERIFIER, 'verify_claim', [credVal, claimVal, proofVal]);
  } catch (error) {
    throw new Error(handleContractError(error));
  }
}

/** Utility: hex string → Uint8Array */
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '').replace(/\s/g, '');
  if (clean.length % 2 !== 0) throw new Error('Invalid hex string');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return bytes as any as Uint8Array;
}

/**
 * Generate a time-limited share link token for a credential.
 * The caller must be the credential subject (holder).
 */
export async function generateShareLink(subject: string, credentialId: string | number | bigint, expiryHours: number): Promise<Uint8Array> {
  try {
    const subjectVal = new Address(subject).toScVal();
    const credVal = nativeToScVal(BigInt(credentialId), { type: 'u64' }) as any;
    const hoursVal = nativeToScVal(expiryHours, { type: 'u32' }) as any;
    return await simulate(CONTRACT_QUORUM_PROOF, 'generate_share_link', [subjectVal, credVal, hoursVal]);
  } catch (error) {
    throw new Error(handleContractError(error));
  }
}

/**
 * Validate a share token and return the credential ID.
 * Throws if the token is unknown or expired.
 */
export async function validateShareToken(token: Uint8Array | ArrayLike<number>): Promise<bigint> {
  try {
    const tokenVal = xdr.ScVal.scvBytes(token instanceof Uint8Array ? token : new Uint8Array(token));
    return await simulate(CONTRACT_QUORUM_PROOF, 'validate_share_token', [tokenVal]);
  } catch (error) {
    throw new Error(handleContractError(error));
  }
}

/** Utility: Uint8Array → hex string */
export function bytesToHex(arr: Uint8Array | ArrayLike<number>): string {
  return Array.from(arr instanceof Uint8Array ? arr : new Uint8Array(arr))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Utility: hex string → Uint8Array */
export function hexToUint8Array(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return bytes;
}

/** Metadata hash bytes → readable string (utf8 or hex fallback) */
export function decodeMetadataHash(rawValue: string | Uint8Array | ArrayLike<number>): string {
  if (typeof rawValue === 'string') return rawValue;
  if (rawValue instanceof Uint8Array || Array.isArray(rawValue)) {
    try {
      return new TextDecoder().decode(new Uint8Array(rawValue));
    } catch {
      return uint8ArrayToHex(new Uint8Array(rawValue));
    }
  }
  return String(rawValue);
}

function uint8ArrayToHex(arr: Uint8Array): string {
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Export aliases for backward compatibility
export { STELLAR_NETWORK as NETWORK, CONTRACT_QUORUM_PROOF as CONTRACT_ID, STELLAR_RPC_URL as RPC_URL };

/**
 * Get proof/verification requests for a credential (returns empty array if none).
 */
export async function getProofRequests(credentialId: string | number | bigint): Promise<any[]> {
  try {
    const credVal = nativeToScVal(BigInt(credentialId), { type: 'u64' }) as any;
    return await simulate(CONTRACT_QUORUM_PROOF, 'get_proof_requests', [credVal]);
  } catch {
    return [];
  }
}
