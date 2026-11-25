import { afterEach, describe, expect, it, vi } from 'vitest'
import { xdr } from '@stellar/stellar-sdk'
import { invokeContract } from './rpc'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('invokeContract', () => {
  it('sends a base64 XDR transaction envelope to simulateTransaction', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: { results: [] } }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await invokeContract({
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      method: 'get_credential_count',
    })

    const request = JSON.parse(fetchMock.mock.calls[0][1].body)
    const envelope = xdr.TransactionEnvelope.fromXDR(
      request.params.transaction,
      'base64',
    )

    expect(request.method).toBe('simulateTransaction')
    expect(envelope.v1().tx().operations()).toHaveLength(1)
    expect(request.params).not.toHaveProperty('network')
  })

  it('surfaces Soroban simulation errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ result: { error: 'contract execution failed' } }),
      }),
    )

    await expect(
      invokeContract({
        contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
        method: 'get_credential_count',
      }),
    ).rejects.toThrow('Soroban simulation error: contract execution failed')
  })
})
