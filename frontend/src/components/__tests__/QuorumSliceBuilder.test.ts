import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  totalWeight,
  thresholdPercent,
  consensusSummary,
  saveDraft,
  loadDraft,
  clearDraft,
  encodeSliceToUrl,
  decodeSliceFromSearch,
  PRESETS,
} from '../../lib/sliceBuilderUtils';
import type { AttestorEntry, SliceDraft } from '../../lib/sliceBuilderUtils';

const makeAttestor = (weight: number, id = crypto.randomUUID()): AttestorEntry => ({
  id,
  address: `G${'A'.repeat(55)}`.slice(0, 56),
  role: 'University',
  weight,
});

// ── totalWeight ───────────────────────────────────────────────────────────────

describe('totalWeight', () => {
  it('returns 0 for empty list', () => {
    expect(totalWeight([])).toBe(0);
  });

  it('sums all weights', () => {
    expect(totalWeight([makeAttestor(3), makeAttestor(2), makeAttestor(1)])).toBe(6);
  });
});

// ── thresholdPercent ──────────────────────────────────────────────────────────

describe('thresholdPercent', () => {
  it('returns 0 when no attestors', () => {
    expect(thresholdPercent(3, [])).toBe(0);
  });

  it('calculates 50% correctly', () => {
    const attestors = [makeAttestor(2), makeAttestor(2)];
    expect(thresholdPercent(2, attestors)).toBe(50);
  });

  it('calculates 100% when threshold equals total weight', () => {
    const attestors = [makeAttestor(3), makeAttestor(2)];
    expect(thresholdPercent(5, attestors)).toBe(100);
  });

  it('rounds to integer', () => {
    const attestors = [makeAttestor(3)];
    // 1/3 = 33.33 → rounds to 33
    expect(thresholdPercent(1, attestors)).toBe(33);
  });
});

// ── consensusSummary ──────────────────────────────────────────────────────────

describe('consensusSummary', () => {
  it('returns 0 minSigners when no attestors', () => {
    const { minSigners } = consensusSummary(1, []);
    expect(minSigners).toBe(0);
  });

  it('calculates minimum signers greedily (highest weight first)', () => {
    // weights: 3, 2, 1 → threshold 4 → need weight 3+2=5≥4 → 2 signers
    const attestors = [makeAttestor(1), makeAttestor(3), makeAttestor(2)];
    const { minSigners } = consensusSummary(4, attestors);
    expect(minSigners).toBe(2);
  });

  it('requires all attestors when threshold equals total weight', () => {
    const attestors = [makeAttestor(1), makeAttestor(1), makeAttestor(1)];
    const { minSigners } = consensusSummary(3, attestors);
    expect(minSigners).toBe(3);
  });

  it('returns totalWeight and pct correctly', () => {
    const attestors = [makeAttestor(4), makeAttestor(6)];
    const { totalWeight: tw, pct } = consensusSummary(5, attestors);
    expect(tw).toBe(10);
    expect(pct).toBe(50);
  });
});

// ── localStorage draft ────────────────────────────────────────────────────────

describe('draft persistence', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('returns null when nothing saved', () => {
    expect(loadDraft()).toBeNull();
  });

  it('saves and loads draft round-trip', () => {
    const draft: SliceDraft = {
      attestors: [makeAttestor(2)],
      threshold: 2,
    };
    saveDraft(draft);
    const loaded = loadDraft();
    expect(loaded?.threshold).toBe(2);
    expect(loaded?.attestors).toHaveLength(1);
    expect(loaded?.attestors[0].weight).toBe(2);
  });

  it('clearDraft removes saved data', () => {
    saveDraft({ attestors: [makeAttestor(1)], threshold: 1 });
    clearDraft();
    expect(loadDraft()).toBeNull();
  });
});

// ── URL encoding ──────────────────────────────────────────────────────────────

describe('URL encoding', () => {
  beforeEach(() => {
    // jsdom uses about:blank; provide a real-looking href
    Object.defineProperty(window, 'location', {
      value: { href: 'http://localhost:5173/slice/new' },
      writable: true,
      configurable: true,
    });
  });

  it('decodeSliceFromSearch returns null for empty search', () => {
    expect(decodeSliceFromSearch('')).toBeNull();
  });

  it('decodeSliceFromSearch returns null for missing param', () => {
    expect(decodeSliceFromSearch('?foo=bar')).toBeNull();
  });

  it('encodes and decodes a round-trip', () => {
    const draft: SliceDraft = {
      attestors: [makeAttestor(3)],
      threshold: 3,
    };
    const url = encodeSliceToUrl(draft);
    const searchPart = '?' + url.split('?')[1];
    const decoded = decodeSliceFromSearch(searchPart);
    expect(decoded?.threshold).toBe(3);
    expect(decoded?.attestors[0].weight).toBe(3);
  });

  it('returns null for malformed base64', () => {
    expect(decodeSliceFromSearch('?slice=!!!INVALID!!!')).toBeNull();
  });
});

// ── Presets ───────────────────────────────────────────────────────────────────

describe('PRESETS', () => {
  it('has at least 3 presets', () => {
    expect(PRESETS.length).toBeGreaterThanOrEqual(3);
  });

  it('each preset has a valid threshold relative to its total weight', () => {
    for (const preset of PRESETS) {
      const tw = preset.attestors.reduce((s, a) => s + a.weight, 0);
      expect(preset.threshold).toBeGreaterThanOrEqual(1);
      expect(preset.threshold).toBeLessThanOrEqual(tw);
    }
  });

  it('academic preset requires both university and licensing body', () => {
    const academic = PRESETS.find((p) => p.id === 'academic')!;
    const roles = academic.attestors.map((a) => a.role);
    expect(roles).toContain('University');
    expect(roles).toContain('Licensing Body');
  });

  it('full preset has all four node types', () => {
    const full = PRESETS.find((p) => p.id === 'full')!;
    const roles = full.attestors.map((a) => a.role);
    expect(roles).toContain('University');
    expect(roles).toContain('Licensing Body');
    expect(roles).toContain('Employer');
    expect(roles).toContain('Other');
  });
});
