import { describe, expect, it } from 'vitest';
import { PrivilegeEscalationManager } from '../src/services/privilegeEscalationPrevention.js';

describe('PrivilegeEscalationManager MFA challenges', () => {
  it('returns a challenge without exposing its verification code', () => {
    const manager = new PrivilegeEscalationManager();

    const challenge = manager.requireMFAForEscalation('user-1');

    expect(challenge).toMatchObject({
      userId: 'user-1',
      method: 'totp',
      attempts: 0,
    });
    expect(challenge).not.toHaveProperty('code');
  });
});
