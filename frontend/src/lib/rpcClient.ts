import { rpc as StellarRpc } from '@stellar/stellar-sdk';
import { STELLAR_RPC_URL } from '../config/env';
import { onNetworkChange } from './networkConfig';

let rpcServer = new StellarRpc.Server(STELLAR_RPC_URL, {
  allowHttp: false
});

const handler = {
  get(_target: any, prop: string | symbol) {
    const val = (rpcServer as any)[prop];
    return typeof val === 'function' ? val.bind(rpcServer) : val;
  }
};

export const rpcClient = new Proxy<StellarRpc.Server>({} as StellarRpc.Server, handler);

export function getRpcClient() { return rpcServer; }

export function updateRpcUrl(url: string): void {
  rpcServer = new StellarRpc.Server(url, {
    allowHttp: url.startsWith('http://')
  });
}

onNetworkChange((config) => {
  updateRpcUrl(config.rpcUrl);
});
