/**
 * Minimal Soroban RPC client wrapper.
 * Reads network config from Vite env vars and exposes a single `invokeContract`
 * helper used by all three contract clients.
 */

import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Networks,
  nativeToScVal,
  StrKey,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'

const RPC_URL = import.meta.env.VITE_STELLAR_RPC_URL as string
const NETWORK = (import.meta.env.VITE_STELLAR_NETWORK ?? 'testnet') as string
const NETWORK_PASSPHRASES: Record<string, string> = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
  public: Networks.PUBLIC,
  futurenet: Networks.FUTURENET,
  standalone: Networks.STANDALONE,
}
const SIMULATION_SOURCE = StrKey.encodeEd25519PublicKey(new Uint8Array(32))
const ENUM_VARIANTS = new Set([
  'HasDegree',
  'HasLicense',
  'HasEmploymentHistory',
  'HasCertification',
  'HasResearchPublication',
])

if (!RPC_URL) {
  console.warn('[QuorumProof] VITE_STELLAR_RPC_URL is not set.')
}

export interface InvokeParams {
  contractId: string
  method: string
  args?: unknown[]
  /** Stellar account address that signs the transaction (for write calls). */
  source?: string
}

/**
 * Call a Soroban contract function via JSON-RPC.
 *
 * For read-only (simulation) calls, `source` can be omitted.
 * For state-mutating calls the caller must supply a `source` address and
 * handle signing externally (e.g. via Freighter) before submitting.
 *
 * Returns the decoded XDR result as a plain JS value.
 */
export async function invokeContract<T = unknown>({
  contractId,
  method,
  args = [],
  source,
}: InvokeParams): Promise<T> {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'simulateTransaction',
    params: {
      transaction: buildTransactionEnvelope(contractId, method, args, source),
    },
  }

  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    throw new Error(`RPC HTTP error ${res.status}: ${res.statusText}`)
  }

  const json = await res.json()

  if (json.error) {
    throw new Error(`RPC error [${json.error.code}]: ${json.error.message}`)
  }

  if (json.result?.error) {
    throw new Error(`Soroban simulation error: ${json.result.error}`)
  }

  return decodeResult<T>(json.result)
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Builds an unsigned Soroban invocation transaction and encodes its envelope
 * as base64 XDR for the RPC `simulateTransaction` method.
 */
function buildTransactionEnvelope(
  contractId: string,
  method: string,
  args: unknown[],
  source?: string,
): string {
  const networkPassphrase = NETWORK_PASSPHRASES[NETWORK.toLowerCase()]
  if (!networkPassphrase) {
    throw new Error(`Unsupported VITE_STELLAR_NETWORK value: ${NETWORK}`)
  }

  const account = new Account(source ?? SIMULATION_SOURCE, '0')
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      new Contract(contractId).call(
        method,
        ...args.map(toScVal),
      ),
    )
    .setTimeout(30)
    .build()

  return transaction.toXDR()
}

function toScVal(value: unknown): xdr.ScVal {
  if (typeof value === 'string') {
    if (StrKey.isValidEd25519PublicKey(value)) {
      return new Address(value).toScVal()
    }
    if (ENUM_VARIANTS.has(value)) {
      return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(value)])
    }
  }
  if (Array.isArray(value)) {
    return xdr.ScVal.scvVec(value.map(toScVal))
  }
  return nativeToScVal(value)
}

/**
 * Decodes the XDR result from a simulateTransaction response.
 * Replace with proper XDR decoding via `@stellar/stellar-sdk` SorobanDataBuilder.
 */
function decodeResult<T>(result: unknown): T {
  // Passthrough until real XDR decoding is wired up.
  return result as T
}
