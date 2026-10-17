import {
  Contract,
  Networks,
  rpc as StellarRpc,
  scValToNative,
  nativeToScVal,
  TransactionBuilder,
  Keypair,
  Account,
  BASE_FEE,
} from '@stellar/stellar-sdk';
import type { Operation, Transaction } from '@stellar/stellar-sdk';
import type { rpc as StellarRpcClient } from '@stellar/stellar-sdk';
import { getDefaultRpcCircuitBreaker } from './services/rpcCircuitBreaker.js';
import { getDefaultGasCostTracker } from './services/gasCostTracker.js';

const RPC_URL = process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const NETWORK = (process.env.STELLAR_NETWORK ?? 'testnet') as keyof typeof PASSPHRASES;
const CONTRACT_ID = process.env.CONTRACT_QUORUM_PROOF ?? '';

const PASSPHRASES = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
  futurenet: Networks.FUTURENET,
};

const server = new StellarRpc.Server(RPC_URL);
type SorobanRpcServer = Pick<StellarRpcClient.Server, 'getAccount' | 'simulateTransaction' | 'sendTransaction' | 'getTransaction'>;
let rpcServer: SorobanRpcServer = server;
const networkPassphrase = PASSPHRASES[NETWORK] ?? Networks.TESTNET;

export type SubmitCallResult =
  | { status: 'prepared'; transaction_xdr: string; authorization_entries_xdr: string[] }
  | { status: 'pending'; transaction_hash: string }
  | { status: 'confirmed'; transaction_hash: string; result: unknown };

export function _setSorobanServerForTest(testServer: SorobanRpcServer | null): void {
  rpcServer = testServer ?? server;
}

function getSourceKeypair(): Keypair {
  const secretKey = process.env.STELLAR_SOURCE_SECRET_KEY;
  if (!secretKey) throw new Error('STELLAR_SOURCE_SECRET_KEY env var not set');
  return Keypair.fromSecret(secretKey);
}

function buildInvokeTransaction(
  sourceAccount: Account,
  method: string,
  args: ReturnType<typeof nativeToScVal>[],
) {
  if (!CONTRACT_ID) throw new Error('CONTRACT_QUORUM_PROOF env var not set');
  const contract = new Contract(CONTRACT_ID);
  return new TransactionBuilder(sourceAccount, { fee: BASE_FEE, networkPassphrase })
    .addOperation(contract.call(method, ...args))
    .setTimeout(300)
    .build();
}

type InvokeHostFunctionOperation = Extract<Operation, { type: 'invokeHostFunction' }>;

function isInvokeHostFunctionOperation(operation: Operation): operation is InvokeHostFunctionOperation {
  return operation.type === 'invokeHostFunction';
}

function assertSignedAuthorization(
  transaction: Transaction,
  expectedTransaction: Transaction,
  sourceAddress: string,
): void {
  if (transaction.source !== sourceAddress) {
    throw new Error('Signed transaction source does not match the configured fee account');
  }
  if (transaction.operations.length !== 1 || transaction.operations[0].type !== 'invokeHostFunction') {
    throw new Error('Signed transaction must contain exactly one Soroban contract invocation');
  }

  const operation = transaction.operations[0];
  const expectedOperation = expectedTransaction.operations[0];
  if (!isInvokeHostFunctionOperation(operation) || !isInvokeHostFunctionOperation(expectedOperation)) {
    throw new Error('Signed transaction must contain exactly one Soroban contract invocation');
  }
  if (!operation.func.toXDR().equals(expectedOperation.func.toXDR())) {
    throw new Error('Signed transaction does not match the requested contract call');
  }
  if (!operation.auth || operation.auth.length === 0) {
    throw new Error('Signed transaction is missing the caller authorization entry');
  }

  const expectedInvocation = expectedOperation.func.invokeContract().toXDR();
  for (const entry of operation.auth) {
    const credentials = entry.credentials();
    if (credentials.switch().name !== 'sorobanCredentialsAddress') {
      throw new Error('Source-account authorization is not accepted for caller-signed transactions');
    }
    if (credentials.address().signature().switch().name === 'scvVoid') {
      throw new Error('Caller authorization entry has not been signed');
    }

    const invocation = entry.rootInvocation().function();
    if (
      invocation.switch().name !== 'sorobanAuthorizedFunctionTypeContractFn' ||
      !invocation.contractFn().toXDR().equals(expectedInvocation)
    ) {
      throw new Error('Caller authorization does not match the requested contract call');
    }
  }
}

async function submitAndConfirm(transaction: Transaction): Promise<SubmitCallResult> {
  const submitted = await rpcServer.sendTransaction(transaction);
  if (submitted.status === 'ERROR' || submitted.status === 'TRY_AGAIN_LATER') {
    throw new Error(`Soroban transaction submission failed with status ${submitted.status}`);
  }

  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await rpcServer.getTransaction(submitted.hash);
    if (result.status === StellarRpc.Api.GetTransactionStatus.SUCCESS) {
      return {
        status: 'confirmed',
        transaction_hash: submitted.hash,
        result: result.returnValue ? deserializeContractState(result.returnValue) : undefined,
      };
    }
    if (result.status === StellarRpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`Soroban transaction ${submitted.hash} failed on-chain`);
    }
    if (attempt < 19) await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return { status: 'pending', transaction_hash: submitted.hash };
}

/**
 * Prepare a write call for caller authorization, or submit its caller-signed
 * transaction and wait for the final Soroban RPC result.
 */
export async function submitCall(
  method: string,
  args: ReturnType<typeof nativeToScVal>[] = [],
  signedTransactionXdr?: string,
): Promise<SubmitCallResult> {
  const sourceKeypair = getSourceKeypair();
  const expectedTransaction = buildInvokeTransaction(
    new Account(sourceKeypair.publicKey(), '0'),
    method,
    args,
  );

  if (!signedTransactionXdr) {
    const sourceAccount = await rpcServer.getAccount(sourceKeypair.publicKey());
    const transaction = buildInvokeTransaction(sourceAccount, method, args);
    const simulation = await rpcServer.simulateTransaction(transaction);
    if (StellarRpc.Api.isSimulationError(simulation)) {
      throw new Error(simulation.error ?? 'Transaction simulation failed');
    }
    if (!simulation.result) throw new Error('No result from transaction simulation');

    const assembled = StellarRpc.assembleTransaction(transaction, simulation).build();
    const operation = assembled.operations[0];
    if (!isInvokeHostFunctionOperation(operation)) {
      throw new Error('Prepared transaction is not a Soroban contract invocation');
    }
    return {
      status: 'prepared',
      transaction_xdr: assembled.toXDR(),
      authorization_entries_xdr: (operation.auth ?? []).map((entry) => entry.toXDR().toString('base64')),
    };
  }

  const transaction = TransactionBuilder.fromXDR(signedTransactionXdr, networkPassphrase);
  if ('innerTransaction' in transaction) throw new Error('Fee-bump transactions are not supported');
  assertSignedAuthorization(transaction, expectedTransaction, sourceKeypair.publicKey());
  transaction.sign(sourceKeypair);
  return submitAndConfirm(transaction);
}

/**
 * Custom serialization for large contract state values (issue #1567).
 *
 * `scValToNative` walks the entire ScVal tree eagerly, which is the dominant
 * cost when a contract returns large maps/vectors of state. We instead keep
 * the raw ScVal and only convert the top-level container lazily: nested
 * entries are decoded on first access and memoized, so callers that only read
 * a few fields never pay for the whole tree.
 */
const LAZY_THRESHOLD = 64;

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null;
}

function lazyWrap<T>(value: T): T {
  if (!isContainer(value)) return value;

  if (Array.isArray(value)) {
    if (value.length < LAZY_THRESHOLD) return value;
    const cache = new Map<number, unknown>();
    return new Proxy(value, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) {
          const idx = Number(prop);
          if (!cache.has(idx)) cache.set(idx, lazyWrap(target[idx]));
          return cache.get(idx);
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as T;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length < LAZY_THRESHOLD) return value;
  const cache = new Map<string, unknown>();
  return new Proxy(value as Record<string, unknown>, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(target, prop)) {
        if (!cache.has(prop)) cache.set(prop, lazyWrap(target[prop]));
        return cache.get(prop);
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as T;
}

/**
 * Decode a contract return value, applying lazy deserialization to large
 * containers so nested state is only materialized on demand.
 */
export function deserializeContractState(retval: Parameters<typeof scValToNative>[0]) {
  return lazyWrap(scValToNative(retval));
}

/**
 * Simulate a read-only contract call and return the native JS value.
 *
 * Routed through the RPC circuit breaker (issue #2): after repeated RPC
 * failures the breaker trips open and this starts serving the last
 * successful result per (method, args) from an in-memory cache instead of
 * hanging on a degraded/unreachable RPC endpoint, then probes recovery via
 * limited half-open trials. See services/rpcCircuitBreaker.ts.
 *
 * Every successful simulation's `minResourceFee` (the resource/gas cost
 * Soroban computed for this call) is recorded against the operation name
 * by the gas cost tracker (issue #4) — see services/gasCostTracker.ts.
 *
 * Design rationale: docs/adr/adr-015-read-only-api-server-via-simulation.md
 */
export async function simulateCall(
  method: string,
  args: ReturnType<typeof nativeToScVal>[] = [],
  options: { cache?: boolean } = {},
) {
  if (!CONTRACT_ID) throw new Error('CONTRACT_QUORUM_PROOF env var not set');

  const cacheArgs = options.cache === false ? undefined : args.map((arg) => {
    try {
      return scValToNative(arg);
    } catch {
      return String(arg);
    }
  });

  return getDefaultRpcCircuitBreaker().execute(
    async () => {
      const contract = new Contract(CONTRACT_ID);
      const dummyKeypair = Keypair.random();
      const dummyAccount = new Account(dummyKeypair.publicKey(), '0');

      const tx = new TransactionBuilder(dummyAccount, { fee: BASE_FEE, networkPassphrase })
        .addOperation(contract.call(method, ...args))
        .setTimeout(30)
        .build();

      const result = await server.simulateTransaction(tx);
      if (StellarRpc.Api.isSimulationError(result)) {
        throw new Error(result.error ?? 'Simulation failed');
      }
      if (!result.result) throw new Error('No result from simulation');
      getDefaultGasCostTracker().record(method, result.minResourceFee);
      return deserializeContractState(result.result.retval);
    },
    cacheArgs ? { method, args: cacheArgs } : undefined
  );
}

export function u64Val(n: number | bigint) {
  return nativeToScVal(BigInt(n), { type: 'u64' });
}

export function u32Val(n: number) {
  return nativeToScVal(n, { type: 'u32' });
}

export function addressVal(addr: string) {
  return nativeToScVal(addr, { type: 'address' });
}
