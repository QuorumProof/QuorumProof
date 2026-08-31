import { describe, it, expect } from 'vitest';
import {
  ContractError,
  CONTRACT_ERROR_MESSAGES,
  handleContractError,
  parseContractErrorCode,
} from '../handleContractError';

describe('handleContractError (#1445)', () => {
  describe('parseContractErrorCode', () => {
    it('parses standard Error(Contract, #N) format', () => {
      expect(parseContractErrorCode('Error(Contract, #11)')).toBe(11);
      expect(parseContractErrorCode('HostError: Error(Contract, #1)')).toBe(1);
      expect(parseContractErrorCode('Simulation error: Error(Contract, #93)')).toBe(93);
    });

    it('parses Error(Contract, N) without hash prefix', () => {
      expect(parseContractErrorCode('Error(Contract, 11)')).toBe(11);
      expect(parseContractErrorCode('Error(Contract,   40)')).toBe(40);
    });

    it('returns null when no contract error pattern is present', () => {
      expect(parseContractErrorCode('Network error')).toBeNull();
      expect(parseContractErrorCode('Transaction timed out')).toBeNull();
      expect(parseContractErrorCode('')).toBeNull();
    });
  });

  describe('Mapping all 93 ContractError codes', () => {
    it('has a friendly message for all 93 ContractError enum variants', () => {
      // Enum values range from 1 to 93
      for (let code = 1; code <= 93; code++) {
        const enumKey = ContractError[code];
        expect(enumKey).toBeDefined();

        const message = CONTRACT_ERROR_MESSAGES[code as ContractError];
        expect(message).toBeDefined();
        expect(typeof message).toBe('string');
        expect(message.length).toBeGreaterThan(0);

        // Verify handleContractError resolves this code correctly
        const result = handleContractError(`HostError: Error(Contract, #${code})`);
        expect(result).toBe(message);

        // Also test with Error instance
        const errorObj = new Error(`Transaction simulation failed: Error(Contract, #${code})`);
        expect(handleContractError(errorObj)).toBe(message);
      }
    });

    it('translates specific notable contract error codes', () => {
      expect(handleContractError('Error(Contract, #1)')).toBe(
        'Requested credential was not found on chain.'
      );
      expect(handleContractError('Error(Contract, #2)')).toBe(
        'Quorum slice was not found on chain.'
      );
      expect(handleContractError('Error(Contract, #11)')).toBe(
        'Action is not authorized. Please check your permissions.'
      );
      expect(handleContractError('Error(Contract, #31)')).toBe(
        'Credential holder is blacklisted by this issuer.'
      );
      expect(handleContractError('Error(Contract, #34)')).toBe(
        'Conflicting attestations detected for the same quorum slice.'
      );
      expect(handleContractError('Error(Contract, #40)')).toBe(
        'Transfer not authorized by the credential subject.'
      );
      expect(handleContractError('Error(Contract, #41)')).toBe(
        'Rate limit exceeded. Please try again later.'
      );
      expect(handleContractError('Error(Contract, #61)')).toBe(
        'Revocation time lock is still active.'
      );
      expect(handleContractError('Error(Contract, #84)')).toBe(
        'Quorum intersection check failed or partition detected.'
      );
      expect(handleContractError('Error(Contract, #87)')).toBe(
        'Invalid key escrow guardian or threshold configuration.'
      );
      expect(handleContractError('Error(Contract, #93)')).toBe(
        'Referenced slice schema version is not registered.'
      );
    });
  });

  describe('Fallback behavior', () => {
    it('falls back to substring matching for non-contract errors', () => {
      expect(handleContractError('Transaction failed: already attested')).toBe(
        'This credential has already been attested by your quorum slice.'
      );
      expect(handleContractError('credential revoked by issuer')).toBe(
        'This credential has been revoked and cannot be used.'
      );
      expect(handleContractError('Resource not found in cache')).toBe(
        'Requested credential was not found on chain.'
      );
      expect(handleContractError('User is unauthorized')).toBe(
        'Action is not authorized. Please check your permissions.'
      );
      expect(handleContractError('Server received invalid request payload')).toBe(
        'Contract call was invalid. Please try again with correct data.'
      );
    });

    it('falls back to unknown numeric code error message if code is not recognized', () => {
      const result = handleContractError('Error(Contract, #999)');
      expect(result).toContain('Contract error #999');
    });

    it('falls back to generic error message for unrecognized errors', () => {
      expect(handleContractError('Connection refused: RPC endpoint down')).toBe(
        'Contract error: Connection refused: RPC endpoint down'
      );
    });

    it('handles empty, null, and undefined gracefully', () => {
      expect(handleContractError('')).toBe('An unknown contract error occurred.');
      expect(handleContractError(null)).toBe('An unknown contract error occurred.');
      expect(handleContractError(undefined)).toBe('An unknown contract error occurred.');
      expect(handleContractError(new Error(''))).toBe('An unknown contract error occurred.');
    });
  });
});
