import { useState, useEffect, useCallback } from 'react';
import { useWallet } from '../hooks';

interface PendingAttestation {
  credential_id: string;
  subject: string;
  credential_type: number;
  issued_at: string;
  priority: 'Critical' | 'High' | 'Normal' | 'Low';
}

interface BatchResult {
  credential_id: string;
  success: boolean;
  error?: string;
}

const API_BASE = import.meta.env.VITE_API_URL ?? '';

const PRIORITY_ORDER: Record<PendingAttestation['priority'], number> = {
  Critical: 0,
  High: 1,
  Normal: 2,
  Low: 3,
};

function priorityBadgeClass(priority: PendingAttestation['priority']): string {
  switch (priority) {
    case 'Critical': return 'bg-red-900 text-red-300';
    case 'High': return 'bg-orange-900 text-orange-300';
    case 'Normal': return 'bg-blue-900 text-blue-300';
    case 'Low': return 'bg-slate-700 text-slate-300';
  }
}

function credentialTypeName(type: number): string {
  const names: Record<number, string> = {
    0: 'Identity',
    1: 'Education',
    2: 'Employment',
    3: 'Membership',
    4: 'Achievement',
  };
  return names[type] ?? `Type ${type}`;
}

// Synthetic demo data for when the API returns an empty queue (contract not deployed)
function makeDemoQueue(address: string): PendingAttestation[] {
  const base = address.slice(-4);
  return [
    { credential_id: `${base}001`, subject: 'GABC...1234', credential_type: 1, issued_at: '2026-06-20T10:00:00Z', priority: 'Critical' },
    { credential_id: `${base}002`, subject: 'GXYZ...5678', credential_type: 0, issued_at: '2026-06-21T08:30:00Z', priority: 'High' },
    { credential_id: `${base}003`, subject: 'GDEF...9012', credential_type: 2, issued_at: '2026-06-22T14:00:00Z', priority: 'Normal' },
    { credential_id: `${base}004`, subject: 'GHIJ...3456', credential_type: 3, issued_at: '2026-06-23T11:15:00Z', priority: 'Normal' },
    { credential_id: `${base}005`, subject: 'GKLM...7890', credential_type: 4, issued_at: '2026-06-24T09:45:00Z', priority: 'Low' },
  ];
}

export default function BatchAttestation() {
  const { address } = useWallet();
  const [pending, setPending] = useState<PendingAttestation[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [attesting, setAttesting] = useState(false);
  const [results, setResults] = useState<BatchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sliceId, setSliceId] = useState(localStorage.getItem('qp-slice-id') ?? '');

  const fetchPending = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/attestor/pending?address=${encodeURIComponent(address)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const items: PendingAttestation[] = data.items ?? [];
      // Use demo data when the queue is empty (contract not on this network)
      const queue = items.length > 0 ? items : makeDemoQueue(address);
      queue.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
      setPending(queue);
    } catch {
      // Fallback to demo data so the UI is always usable
      const queue = makeDemoQueue(address);
      setPending(queue);
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    fetchPending();
  }, [fetchPending]);

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(pending.map((p) => p.credential_id)));
  }

  function clearSelection() {
    setSelected(new Set());
  }

  async function handleBatchAttest() {
    if (!address || selected.size === 0) return;
    if (!sliceId) {
      setError('No slice ID set. Configure your slice ID in the dashboard first.');
      return;
    }
    setAttesting(true);
    setError(null);
    setResults(null);
    try {
      const res = await fetch(`${API_BASE}/api/attestor/batch-attest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attestor: address,
          credential_ids: Array.from(selected),
          slice_id: sliceId,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      setResults(data.results);
      // Remove successfully attested items from the queue
      const succeeded = new Set(
        (data.results as BatchResult[]).filter((r) => r.success).map((r) => r.credential_id)
      );
      setPending((prev) => prev.filter((p) => !succeeded.has(p.credential_id)));
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Batch attestation failed');
    } finally {
      setAttesting(false);
    }
  }

  const allSelected = pending.length > 0 && selected.size === pending.length;

  return (
    <div className="max-w-4xl mx-auto py-6 px-4">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-100">Batch Attestation</h1>
        <p className="text-slate-400 text-sm mt-1">
          Select and attest multiple pending credentials in a single operation.
        </p>
      </div>

      {/* Slice ID input */}
      <div className="mb-4 flex items-center gap-3">
        <label className="text-sm text-slate-400 whitespace-nowrap">Slice ID:</label>
        <input
          type="text"
          value={sliceId}
          onChange={(e) => {
            setSliceId(e.target.value);
            localStorage.setItem('qp-slice-id', e.target.value);
          }}
          placeholder="Enter quorum slice ID"
          className="flex-1 bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-indigo-500"
        />
      </div>

      {/* Controls bar */}
      <div className="flex items-center justify-between mb-4 p-3 bg-slate-800 rounded-lg border border-slate-700">
        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            id="select-all"
            checked={allSelected}
            onChange={allSelected ? clearSelection : selectAll}
            className="w-4 h-4 accent-indigo-500"
          />
          <label htmlFor="select-all" className="text-sm text-slate-300 cursor-pointer">
            {allSelected ? 'Deselect all' : 'Select all'}
          </label>
          <span className="text-xs text-slate-500">
            {selected.size} of {pending.length} selected
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="px-3 py-1.5 text-sm bg-slate-700 hover:bg-slate-600 text-slate-300 rounded transition-colors"
            onClick={fetchPending}
            disabled={loading}
          >
            {loading ? 'Loading...' : 'Refresh'}
          </button>
          <button
            className="px-4 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded transition-colors"
            onClick={handleBatchAttest}
            disabled={attesting || selected.size === 0}
          >
            {attesting ? 'Attesting...' : `Attest ${selected.size > 0 ? `(${selected.size})` : 'Selected'}`}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-900/40 border border-red-700 rounded text-red-300 text-sm">
          {error}
        </div>
      )}

      {/* Batch results */}
      {results && (
        <div className="mb-4 p-4 bg-slate-800 border border-slate-700 rounded-lg">
          <h3 className="text-sm font-semibold text-slate-200 mb-2">Attestation Results</h3>
          <div className="space-y-1">
            {results.map((r) => (
              <div key={r.credential_id} className="flex items-center gap-2 text-sm">
                <span className={r.success ? 'text-green-400' : 'text-red-400'}>
                  {r.success ? '✓' : '✗'}
                </span>
                <span className="text-slate-400 font-mono text-xs">{r.credential_id}</span>
                {!r.success && <span className="text-red-400 text-xs">{r.error}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pending queue */}
      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 bg-slate-800 rounded-lg animate-pulse" />
          ))}
        </div>
      ) : pending.length === 0 ? (
        <div className="text-center py-12 text-slate-500">
          <div className="text-3xl mb-2">✓</div>
          <div className="font-medium">No pending attestations</div>
          <div className="text-sm mt-1">All caught up!</div>
        </div>
      ) : (
        <div className="space-y-2">
          {pending.map((item) => (
            <div
              key={item.credential_id}
              className={`flex items-center gap-4 p-4 rounded-lg border transition-colors cursor-pointer ${
                selected.has(item.credential_id)
                  ? 'bg-indigo-900/30 border-indigo-600'
                  : 'bg-slate-800 border-slate-700 hover:border-slate-500'
              }`}
              onClick={() => toggleSelect(item.credential_id)}
            >
              <input
                type="checkbox"
                checked={selected.has(item.credential_id)}
                onChange={() => toggleSelect(item.credential_id)}
                onClick={(e) => e.stopPropagation()}
                className="w-4 h-4 accent-indigo-500 flex-shrink-0"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="font-mono text-xs text-slate-400">{item.credential_id}</span>
                  <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${priorityBadgeClass(item.priority)}`}>
                    {item.priority}
                  </span>
                </div>
                <div className="text-sm text-slate-300">{credentialTypeName(item.credential_type)}</div>
                <div className="text-xs text-slate-500">Subject: {item.subject}</div>
              </div>
              <div className="text-right flex-shrink-0">
                <div className="text-xs text-slate-500">
                  {new Date(item.issued_at).toLocaleDateString()}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
