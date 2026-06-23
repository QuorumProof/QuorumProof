import { describe, it, expect } from 'vitest';
import { isUserRejectedError } from '../formatWalletError';

describe('signWalletTransaction errors', () => {
  it('detects rejected signatures', () => {
    expect(isUserRejectedError(new Error('User declined access'))).toBe(true);
    expect(isUserRejectedError(new Error('Network error'))).toBe(false);
  });
});
