import { describe, it, expect } from 'vitest';
import { compactXlmLabel } from '../balance';

describe('compactXlmLabel', () => {
  it('shortens large balances for the navbar', () => {
    expect(compactXlmLabel('9998.9069755 XLM')).toBe('9,998.91 XLM');
  });

  it('keeps small balances readable', () => {
    expect(compactXlmLabel('0.5 XLM')).toBe('0.5 XLM');
  });
});
