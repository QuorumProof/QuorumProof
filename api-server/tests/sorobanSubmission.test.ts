import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Account,
  Address,
  authorizeEntry,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  xdr,
  nativeToScVal,
} from '@stellar/stellar-sdk';

describe('Soroban caller-authorized transaction submission', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('prepares caller auth, submits the signed call, and returns only after confirmation', async () => {
    vi.stubEnv('STELLAR_NETWORK', 'testnet');
    vi.stubEnv('CONTRACT_QUORUM_PROOF', StrKey.encodeContract(Buffer.alloc(32, 1)));
    const sourceKeypair = Keypair.random();
    const callerKeypair = Keypair.random();
    vi.stubEnv('STELLAR_SOURCE_SECRET_KEY', sourceKeypair.secret());

    const rpc = {
      getAccount: vi.fn().mockResolvedValue(new Account(sourceKeypair.publicKey(), '1')),
      simulateTransaction: vi.fn(async (transaction: import('@stellar/stellar-sdk').Transaction) => {
        const invokeArgs = transaction.operations[0].func.invokeContract();
        const rootInvocation = new xdr.SorobanAuthorizedInvocation({
          function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(invokeArgs),
          subInvocations: [],
        });
        const credentials = xdr.SorobanCredentials.sorobanCredentialsAddress(
          new xdr.SorobanAddressCredentials({
            address: new Address(callerKeypair.publicKey()).toScAddress(),
            nonce: xdr.Int64.fromString('1'),
            signatureExpirationLedger: 1000,
            signature: nativeToScVal(null, { type: 'void' }),
          }),
        );
        const authEntry = new xdr.SorobanAuthorizationEntry({ credentials, rootInvocation });
        return {
          _parsed: true,
          id: 'simulation-id',
          latestLedger: 1,
          events: [],
          minResourceFee: '100',
          transactionData: new SorobanDataBuilder()
            .setResources(1000, 100, 100)
            .setFootprint([], [])
            .setResourceFee(100),
          result: { auth: [authEntry], retval: nativeToScVal(null, { type: 'void' }) },
        };
      }),
      sendTransaction: vi.fn().mockResolvedValue({
        status: 'PENDING',
        hash: 'confirmed-transaction-hash',
        latestLedger: 1,
        latestLedgerCloseTime: 1,
      }),
      getTransaction: vi.fn().mockResolvedValue({
        status: 'SUCCESS',
        txHash: 'confirmed-transaction-hash',
        returnValue: nativeToScVal(9n, { type: 'u64' }),
      }),
    };

    const soroban = await import('../src/soroban.js');
    soroban._setSorobanServerForTest(rpc as unknown as Parameters<typeof soroban._setSorobanServerForTest>[0]);

    const prepared = await soroban.submitCall('test_write', [nativeToScVal(7, { type: 'u32' })]);
    expect(prepared.status).toBe('prepared');
    if (prepared.status !== 'prepared') throw new Error('Expected a prepared transaction');
    expect(prepared.authorization_entries_xdr).toHaveLength(1);

    const transaction = TransactionBuilder.fromXDR(prepared.transaction_xdr, Networks.TESTNET);
    const unsignedOperation = transaction.operations[0];
    const signedAuth = await authorizeEntry(unsignedOperation.auth![0], callerKeypair, 1000, Networks.TESTNET);
    const signedTransaction = TransactionBuilder.cloneFrom(transaction)
      .clearOperations()
      .addOperation(Operation.invokeHostFunction({
        func: unsignedOperation.func,
        auth: [signedAuth],
      }))
      .build();

    const submitted = await soroban.submitCall(
      'test_write',
      [nativeToScVal(7, { type: 'u32' })],
      signedTransaction.toXDR(),
    );

    expect(submitted).toEqual({
      status: 'confirmed',
      transaction_hash: 'confirmed-transaction-hash',
      result: 9n,
    });
    expect(rpc.sendTransaction).toHaveBeenCalledOnce();
    expect(rpc.getTransaction).toHaveBeenCalledOnce();
  });
});
