import {
  Address,
  BASE_FEE,
  Contract,
  nativeToScVal,
  scValToNative,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { getRpcClient } from '../rpcClient';
import { getNetworkConfig } from '../networkConfig';
import { CONTRACT_QUORUM_PROOF } from '../../config/env';
import type { WalletType } from '../../wallets/types';
import {
  getCredential as _getCredential,
  getAttestors as _getAttestors,
  isExpired as _isExpired,
  getSlice as _getSlice,
} from '../../stellar';

// ── Issue #798: Per-Issuer Quota types ───────────────────────────────────────

export interface IssuerQuota {
  max_credentials: number;
  window_seconds: bigint;
  alert_threshold_pct: number;
}

export interface IssuerQuotaUsage {
  issued_count: number;
  window_start: bigint;
}

// ── Core types ────────────────────────────────────────────────────────────────

export interface Credential {
  id: bigint;
  subject: string;
  issuer: string;
  credential_type: number;
  metadata_hash: Uint8Array;
  revoked: boolean;
  expires_at: bigint | null;
}

export interface QuorumSlice {
  id: bigint;
  creator: string;
  attestors: string[];
  threshold: number;
}

// ── Re-exported core functions ────────────────────────────────────────────────

export const getCredential = _getCredential as (id: bigint) => Promise<Credential>;
export const getAttestors = _getAttestors as (id: bigint) => Promise<string[]>;
export const isExpired = _isExpired as (id: bigint) => Promise<boolean>;
export const getSlice = _getSlice as (id: bigint) => Promise<QuorumSlice>;

export {
  getCredentialsBySubject,
  isAttested,
} from '../../stellar';

/** Issue a new credential on-chain. Returns the new credential ID. */
export async function issueCredential(
  issuer: string,
  subject: string,
  credentialType: number,
  metadataHash: Uint8Array,
): Promise<bigint> {
  const client = getRpcClient();
  const contract = new Contract(import.meta.env.VITE_CONTRACT_QUORUM_PROOF);
  const result = await client.simulateTransaction(
    contract.call(
      'issue_credential',
      nativeToScVal(issuer, { type: 'address' }),
      nativeToScVal(subject, { type: 'address' }),
      nativeToScVal(credentialType, { type: 'u32' }),
      nativeToScVal(metadataHash, { type: 'bytes' }),
    )
  );
  return scValToNative(result.result?.retval);
}

/** Create a new quorum slice on-chain. Returns the new slice ID. */
export async function createSlice(
  creator: string,
  attestors: string[],
  threshold: number,
): Promise<bigint> {
  const client = getRpcClient();
  const contract = new Contract(import.meta.env.VITE_CONTRACT_QUORUM_PROOF);
  const result = await client.simulateTransaction(
    contract.call(
      'create_slice',
      nativeToScVal(creator, { type: 'address' }),
      nativeToScVal(attestors.map((a) => new Address(a).toScVal())),
      nativeToScVal(threshold, { type: 'u32' }),
    )
  );
  return scValToNative(result.result?.retval);
}



// Use the shared, validated env config (VITE_CONTRACT_QUORUM_PROOF) so mutating
// calls target the same contract as the read-only helpers in stellar.ts.
const CONTRACT_ID = CONTRACT_QUORUM_PROOF;

export interface RevokeCredentialsOptions {
  walletType?: WalletType;
  accountIndex?: number;
}

/**
 * Revoke credentials on-chain via the connected wallet.
 *
 * The promise resolves only after the transaction has been confirmed by the
 * network. Callers must not update local state or show success before it does,
 * otherwise the UI can claim a revocation that never happened (issue #1984).
 */
export async function revokeCredentials(
  issuer: string,
  credentialIds: bigint[],
  { walletType = 'freighter', accountIndex = 0 }: RevokeCredentialsOptions = {},
): Promise<void> {
  if (credentialIds.length === 0) return;
  if (!CONTRACT_ID) {
    throw new Error('Contract ID not configured. Set VITE_CONTRACT_QUORUM_PROOF in .env');
  }

  // Load wallet adapters lazily: most consumers of this module only perform
  // read-only contract calls and should not pull wallet SDKs into their graph.
  const { getWalletAdapter } = await import('../../wallets/registry');
  const adapter = getWalletAdapter(walletType);
  if (!adapter.signTransaction) {
    throw new Error(`Connected wallet (${walletType}) does not support transaction signing`);
  }

  const { passphrase } = getNetworkConfig();
  const server = getRpcClient();
  const account = await server.getAccount(issuer);
  const contract = new Contract(CONTRACT_ID);
  const issuerScVal = new Address(issuer).toScVal();
  // `reason` is Option<String>; scvVoid() is the canonical None value.
  const noReason = xdr.ScVal.scvVoid();

  let builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: passphrase,
  });

  for (const id of credentialIds) {
    builder = builder.addOperation(
      contract.call(
        'revoke_credential',
        issuerScVal,
        nativeToScVal(id, { type: 'u64' }),
        noReason,
      ),
    );
  }

  const prepared = await server.prepareTransaction(builder.setTimeout(60).build());
  const signedXdr = await adapter.signTransaction(prepared.toXDR(), accountIndex);
  const signedTx = TransactionBuilder.fromXDR(signedXdr, passphrase);
  const sent = await server.sendTransaction(signedTx);

  if (sent.status === 'ERROR') {
    throw new Error(`Revocation transaction was rejected: ${sent.errorResult ?? 'unknown error'}`);
  }

  // Wait for the ledger to confirm the transaction before reporting success.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await server.getTransaction(sent.hash);
    if (result.status === 'SUCCESS') return;
    if (result.status === 'FAILED') {
      throw new Error('Revocation transaction failed on-chain');
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error('Timed out waiting for on-chain revocation confirmation');
}

// Feature #355: Proof Expiry
export async function isProofExpired(credentialId: bigint, proofExpiresAt: bigint): Promise<boolean> {
  const client = getRpcClient();
  const contract = new Contract(CONTRACT_ID);
  
  const result = await client.simulateTransaction(
    contract.call(
      'is_proof_expired',
      nativeToScVal(credentialId, { type: 'u64' }),
      nativeToScVal(proofExpiresAt, { type: 'u64' })
    )
  );
  
  return scValToNative(result.result?.retval);
}

export async function renewProof(issuer: string, credentialId: bigint, newProofExpiresAt: bigint): Promise<bigint> {
  const client = getRpcClient();
  const contract = new Contract(CONTRACT_ID);
  
  const result = await client.simulateTransaction(
    contract.call(
      'renew_proof',
      nativeToScVal(issuer, { type: 'address' }),
      nativeToScVal(credentialId, { type: 'u64' }),
      nativeToScVal(newProofExpiresAt, { type: 'u64' })
    )
  );
  
  return scValToNative(result.result?.retval);
}

// Feature #356: Batch Proof Verification
export async function batchVerifyProofs(
  credentialIds: bigint[],
  sliceIds: bigint[],
  proofExpiresAtList: bigint[]
): Promise<Array<{ credentialId: bigint; isValid: boolean; isExpired: boolean }>> {
  const client = getRpcClient();
  const contract = new Contract(CONTRACT_ID);
  
  const result = await client.simulateTransaction(
    contract.call(
      'batch_verify_proofs',
      nativeToScVal(credentialIds, { type: 'Vec<u64>' }),
      nativeToScVal(sliceIds, { type: 'Vec<u64>' }),
      nativeToScVal(proofExpiresAtList, { type: 'Vec<u64>' })
    )
  );
  
  const results = scValToNative(result.result?.retval) as Array<[bigint, boolean, boolean]>;
  return results.map((r) => ({
    credentialId: r[0],
    isValid: r[1],
    isExpired: r[2]
  }));
}

// Feature #357: Claim Type Validation
export async function isClaimTypeSupported(claimType: number): Promise<boolean> {
  const client = getRpcClient();
  const contract = new Contract(CONTRACT_ID);
  
  const result = await client.simulateTransaction(
    contract.call('is_claim_type_supported', nativeToScVal(claimType, { type: 'u32' }))
  );
  
  return scValToNative(result.result?.retval);
}

export async function getSupportedClaimTypes(): Promise<number[]> {
  const client = getRpcClient();
  const contract = new Contract(CONTRACT_ID);
  
  const result = await client.simulateTransaction(
    contract.call('get_supported_claim_types')
  );
  
  return scValToNative(result.result?.retval);
}

export async function validateClaimTypes(claimTypes: number[]): Promise<boolean> {
  const client = getRpcClient();
  const contract = new Contract(CONTRACT_ID);
  
  const result = await client.simulateTransaction(
    contract.call('validate_claim_types', nativeToScVal(claimTypes, { type: 'Vec<u32>' }))
  );
  
  return scValToNative(result.result?.retval);
}

// Feature #359: Credential Search
export async function searchCredentials(
  subject?: string,
  issuer?: string,
  credentialType?: number,
  startDate?: bigint,
  endDate?: bigint,
  page: number = 1,
  pageSize: number = 10
): Promise<bigint[]> {
  const client = getRpcClient();
  const contract = new Contract(CONTRACT_ID);
  
  const result = await client.simulateTransaction(
    contract.call(
      'search_credentials',
      subject ? nativeToScVal(subject, { type: 'address' }) : nativeToScVal(null, { type: 'Option<Address>' }),
      issuer ? nativeToScVal(issuer, { type: 'address' }) : nativeToScVal(null, { type: 'Option<Address>' }),
      credentialType ? nativeToScVal(credentialType, { type: 'u32' }) : nativeToScVal(null, { type: 'Option<u32>' }),
      startDate ? nativeToScVal(startDate, { type: 'u64' }) : nativeToScVal(null, { type: 'Option<u64>' }),
      endDate ? nativeToScVal(endDate, { type: 'u64' }) : nativeToScVal(null, { type: 'Option<u64>' }),
      nativeToScVal(page, { type: 'u32' }),
      nativeToScVal(pageSize, { type: 'u32' })
    )
  );
  
  return scValToNative(result.result?.retval);
}

export async function countCredentials(
  subject?: string,
  issuer?: string,
  credentialType?: number
): Promise<number> {
  const client = getRpcClient();
  const contract = new Contract(CONTRACT_ID);
  
  const result = await client.simulateTransaction(
    contract.call(
      'count_credentials',
      subject ? nativeToScVal(subject, { type: 'address' }) : nativeToScVal(null, { type: 'Option<Address>' }),
      issuer ? nativeToScVal(issuer, { type: 'address' }) : nativeToScVal(null, { type: 'Option<Address>' }),
      credentialType ? nativeToScVal(credentialType, { type: 'u32' }) : nativeToScVal(null, { type: 'Option<u32>' })
    )
  );
  
  return scValToNative(result.result?.retval);
}

// ── Issue #798: Per-Issuer Credential Issuance Quota ─────────────────────────

/** Fetch quota configuration for an issuer. Returns null if not set. */
export async function getIssuerQuota(issuer: string): Promise<IssuerQuota | null> {
  const client = getRpcClient();
  const contract = new Contract(CONTRACT_ID);
  const result = await client.simulateTransaction(
    contract.call('get_issuer_quota', nativeToScVal(issuer, { type: 'address' }))
  );
  return scValToNative(result.result?.retval) ?? null;
}

/** Fetch current quota usage for an issuer. */
export async function getIssuerQuotaUsage(issuer: string): Promise<IssuerQuotaUsage> {
  const client = getRpcClient();
  const contract = new Contract(CONTRACT_ID);
  const result = await client.simulateTransaction(
    contract.call('get_issuer_quota_usage', nativeToScVal(issuer, { type: 'address' }))
  );
  return scValToNative(result.result?.retval);
}
