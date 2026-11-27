import { describe, expect, it } from 'vitest'
import { invokeContract } from './rpc'

const enabled = import.meta.env.VITE_RUN_STELLAR_TESTNET_INTEGRATION === 'true'
const contractId = import.meta.env.VITE_CONTRACT_QUORUM_PROOF
const rpcUrl = import.meta.env.VITE_STELLAR_RPC_URL

describe.skipIf(!enabled)('Soroban testnet integration', () => {
  it('simulates a contract call using an XDR transaction', async () => {
    if (!rpcUrl) {
      throw new Error('VITE_STELLAR_RPC_URL must be set for testnet integration')
    }
    if (!contractId) {
      throw new Error('VITE_CONTRACT_QUORUM_PROOF must be set for testnet integration')
    }
    if ((import.meta.env.VITE_STELLAR_NETWORK ?? 'testnet') !== 'testnet') {
      throw new Error('VITE_STELLAR_NETWORK must be testnet for testnet integration')
    }

    const result = await invokeContract({
      contractId,
      method: 'get_credential_count',
    })

    expect(result).toHaveProperty('results')
  })
})
