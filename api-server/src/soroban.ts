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
const networkPassphrase = PASSPHRASES[NETWORK] ?? Networks.TESTNET;

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
export async function simulateCall(method: string, args: ReturnType<typeof nativeToScVal>[] = []) {
  if (!CONTRACT_ID) throw new Error('CONTRACT_QUORUM_PROOF env var not set');

  const cacheArgs = args.map((arg) => {
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
    { method, args: cacheArgs }
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
