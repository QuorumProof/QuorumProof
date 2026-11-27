import { describe, it, expect, vi, beforeEach } from 'vitest';
import { contractInvocationDurationHistogram } from './soroban.js';

describe('Soroban metrics', () => {
  it('emits contract invocation duration histogram', async () => {
    const observeSpy = vi.spyOn(contractInvocationDurationHistogram, 'observe');
    const timer = contractInvocationDurationHistogram.startTimer({ operation: 'test_method' });
    timer({ status: 'success' });
    expect(observeSpy).toHaveBeenCalled();
  });
});
