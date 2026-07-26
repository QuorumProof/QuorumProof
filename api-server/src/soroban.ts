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
 * Simulate a read-only contract call and return the native JS value.
 *
 * Routed through the RPC circuit breaker (issue #2): after repeated RPC
 * failures the breaker trips open and this starts serving the last
 * successful result per (method, args) from an in-memory cache instead of
 * hanging on a degraded/unreachable RPC endpoint, then probes recovery via
 * limited half-open trials. See services/rpcCircuitBreaker.ts.
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
      return scValToNative(result.result.retval);
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
