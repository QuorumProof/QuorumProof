/**
 * Unit tests for the shared truncation helpers — issue #1456
 *
 * Verifies that both helpers produce the correct first-N…last-N output for
 * known inputs, and in particular that they do NOT exhibit the broken
 * `substring(-N)` behaviour (which returns the entire string).
 */

import { describe, it, expect } from 'vitest'
import { truncateId, truncateAddress } from './truncate'

describe('truncateId', () => {
  it('truncates a long credential ID to first 8 … last 8 chars', () => {
    const id = '0x1234567890abcdef1234567890abcdef12345678'
    // first 8: '0x123456' (8 chars), last 8: '12345678'
    expect(truncateId(id)).toBe('0x123456...12345678')
  })

  it('does not add an ellipsis for IDs of 16 chars or fewer', () => {
    expect(truncateId('abcdef1234567890')).toBe('abcdef1234567890')
    expect(truncateId('short')).toBe('short')
  })

  it('never returns the full string for long IDs (regression: substring(-8))', () => {
    const id = 'did:quorum:0xaabbccddeeff00112233445566778899aabbccdd'
    const result = truncateId(id)
    expect(result).not.toBe(id)
    expect(result).toContain('...')
    expect(result.endsWith(id.slice(-8))).toBe(true)
  })
})

describe('truncateAddress', () => {
  it('truncates a Stellar/EVM address to first 6 … last 4 chars', () => {
    const address = 'GABC1234567890DEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFG'
    // first 6: 'GABC12', last 4: 'DEFG'
    expect(truncateAddress(address)).toBe('GABC12...DEFG')
  })

  it('does not add an ellipsis for addresses of 10 chars or fewer', () => {
    expect(truncateAddress('GABC123456')).toBe('GABC123456')
    expect(truncateAddress('short')).toBe('short')
  })

  it('never returns the full string for long addresses (regression: substring(-4))', () => {
    const address = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01'
    const result = truncateAddress(address)
    expect(result).not.toBe(address)
    expect(result).toContain('...')
    expect(result.endsWith(address.slice(-4))).toBe(true)
  })
})
