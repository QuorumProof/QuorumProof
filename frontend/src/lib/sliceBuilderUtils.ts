export interface AttestorEntry {
  id: string;
  address: string;
  role: string;
  weight: number;
}

export interface SliceDraft {
  attestors: AttestorEntry[];
  threshold: number;
}

// ── Preset Templates ─────────────────────────────────────────────────────────

export interface Preset {
  id: string;
  label: string;
  description: string;
  attestors: Omit<AttestorEntry, 'id'>[];
  threshold: number;
}

export const PRESETS: Preset[] = [
  {
    id: 'academic',
    label: '🎓 Academic',
    description: 'University + licensing body, both required',
    attestors: [
      { address: '', role: 'University', weight: 2 },
      { address: '', role: 'Licensing Body', weight: 2 },
    ],
    threshold: 4,
  },
  {
    id: 'employer',
    label: '💼 Professional',
    description: 'University + two employers, majority required',
    attestors: [
      { address: '', role: 'University', weight: 2 },
      { address: '', role: 'Employer', weight: 1 },
      { address: '', role: 'Employer', weight: 1 },
    ],
    threshold: 3,
  },
  {
    id: 'full',
    label: '🏛️ Full Trust',
    description: 'All four node types, supermajority required',
    attestors: [
      { address: '', role: 'University', weight: 3 },
      { address: '', role: 'Licensing Body', weight: 3 },
      { address: '', role: 'Employer', weight: 2 },
      { address: '', role: 'Other', weight: 1 },
    ],
    threshold: 7,
  },
];

// ── Threshold Calculator ──────────────────────────────────────────────────────

/** Total weight of all attestors in the slice */
export function totalWeight(attestors: AttestorEntry[]): number {
  return attestors.reduce((s, a) => s + a.weight, 0);
}

/** Percentage of total weight the threshold represents */
export function thresholdPercent(threshold: number, attestors: AttestorEntry[]): number {
  const t = totalWeight(attestors);
  return t === 0 ? 0 : Math.round((threshold / t) * 100);
}

/** Weighted consensus: how many attestors must sign to cross threshold */
export function consensusSummary(threshold: number, attestors: AttestorEntry[]) {
  const tw = totalWeight(attestors);
  const pct = thresholdPercent(threshold, attestors);
  const sorted = [...attestors].sort((a, b) => b.weight - a.weight);
  let cum = 0;
  let minSigners = 0;
  for (const a of sorted) {
    cum += a.weight;
    minSigners++;
    if (cum >= threshold) break;
  }
  return { totalWeight: tw, pct, minSigners: attestors.length ? minSigners : 0 };
}

// ── localStorage Draft ────────────────────────────────────────────────────────

const DRAFT_KEY = 'qp-slice-draft';

export function saveDraft(draft: SliceDraft): void {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* quota */ }
}

export function loadDraft(): SliceDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as SliceDraft;
  } catch { return null; }
}

export function clearDraft(): void {
  localStorage.removeItem(DRAFT_KEY);
}

// ── URL Sharing ───────────────────────────────────────────────────────────────

export function encodeSliceToUrl(draft: SliceDraft): string {
  const encoded = btoa(JSON.stringify(draft));
  const url = new URL(window.location.href);
  url.searchParams.set('slice', encoded);
  return url.toString();
}

export function decodeSliceFromSearch(search: string): SliceDraft | null {
  try {
    const params = new URLSearchParams(search);
    const raw = params.get('slice');
    if (!raw) return null;
    return JSON.parse(atob(raw)) as SliceDraft;
  } catch { return null; }
}

// ── JSON Import / Export ──────────────────────────────────────────────────────

export interface SliceExport {
  version: 1;
  exportedAt: string;
  attestors: AttestorEntry[];
  threshold: number;
}

/** Serialise the current draft to a JSON string and trigger a file download. */
export function exportSliceAsJson(draft: SliceDraft, filename = 'quorum-slice.json'): void {
  const payload: SliceExport = {
    version: 1,
    exportedAt: new Date().toISOString(),
    ...draft,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Parse a JSON string exported by `exportSliceAsJson`. Throws on invalid data. */
export function importSliceFromJson(raw: string): SliceDraft {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('Invalid JSON file.'); }
  const data = parsed as SliceExport;
  if (data.version !== 1 || !Array.isArray(data.attestors) || typeof data.threshold !== 'number') {
    throw new Error('Unrecognised slice export format.');
  }
  return { attestors: data.attestors, threshold: data.threshold };
}
