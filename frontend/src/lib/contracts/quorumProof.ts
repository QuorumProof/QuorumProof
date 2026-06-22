import { Contract, Address, nativeToScVal, scValToNative } from '@stellar/stellar-sdk';
import { getRpcClient } from '../rpcClient';
import {
  getCredential as _getCredential,
  getAttestors as _getAttestors,
  isExpired as _isExpired,
  getSlice as _getSlice,
} from '../../stellar';

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
  const contract = new Contract(import.meta.env.VITE_QUORUM_PROOF_CONTRACT_ID);
  const result = await client.simulateTransaction(
    contract.call(
      'issue_credential',
      nativeToScVal(issuer, { type: 'address' }),
      nativeToScVal(subject, { type: 'address' }),
      nativeToScVal(credentialType, { type: 'u32' }),
      nativeToScVal(metadataHash, { type: 'bytes' }),
    )
  );
  return scValToNative((result as any).result?.retval);
}

/** Create a new quorum slice on-chain. Returns the new slice ID. */
export async function createSlice(
  creator: string,
  attestors: string[],
  threshold: number,
): Promise<bigint> {
  const client = getRpcClient();
  const contract = new Contract(import.meta.env.VITE_QUORUM_PROOF_CONTRACT_ID);
  const result = await client.simulateTransaction(
    contract.call(
      'create_slice',
      nativeToScVal(creator, { type: 'address' }),
      nativeToScVal(attestors.map((a) => new Address(a).toScVal())),
      nativeToScVal(threshold, { type: 'u32' }),
    )
  );
  return scValToNative((result as any).result?.retval);
}



const CONTRACT_ID = import.meta.env.VITE_QUORUM_PROOF_CONTRACT_ID;

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
  
  const results = scValToNative(result.result?.retval);
  return results.map((r: any) => ({
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
