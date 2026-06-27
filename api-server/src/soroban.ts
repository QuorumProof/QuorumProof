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

const RPC_URL = process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const NETWORK = (process.env.STELLAR_NETWORK ?? 'testnet') as keyof typeof PASSPHRASES;
const CONTRACT_ID = process.env.CONTRACT_QUORUM_PROOF ?? '';
const RPC_POOL_SIZE = parseInt(process.env.RPC_POOL_SIZE ?? '5', 10);

const PASSPHRASES = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
  futurenet: Networks.FUTURENET,
};

const networkPassphrase = PASSPHRASES[NETWORK] ?? Networks.TESTNET;

/** Round-robin pool of RPC server instances to reuse connections across requests. */
class RpcConnectionPool {
  private readonly pool: StellarRpc.Server[];
  private index = 0;

  constructor(url: string, size: number) {
    this.pool = Array.from({ length: size }, () => new StellarRpc.Server(url));
  }

  acquire(): StellarRpc.Server {
    const server = this.pool[this.index];
    this.index = (this.index + 1) % this.pool.length;
    return server;
  }
}

const rpcPool = new RpcConnectionPool(RPC_URL, RPC_POOL_SIZE);

/** Simulate a read-only contract call and return the native JS value. */
export async function simulateCall(method: string, args: ReturnType<typeof nativeToScVal>[] = []) {
  if (!CONTRACT_ID) throw new Error('CONTRACT_QUORUM_PROOF env var not set');

  const server = rpcPool.acquire();
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
