import { useState, useCallback } from 'react';
import {
  getCredential,
  getCredentialsBySubject,
  getAttestors,
  isExpired,
} from '../lib/contracts/quorumProof';
import type { Credential } from '../lib/contracts/quorumProof';
import { credTypeLabel, formatTimestamp, formatAddress } from '../lib/credentialUtils';
import { exportCredentials } from '../lib/exportUtils';

export type CredentialStatus = 'all' | 'active' | 'revoked' | 'expired';

export interface SearchFilters {
  subject: string;
  issuer: string;
  credentialType: string;
  status: CredentialStatus;
  startDate: string;
  endDate: string;
}

const EMPTY_FILTERS: SearchFilters = {
  subject: '',
  issuer: '',
  credentialType: '',
  status: 'all',
  startDate: '',
  endDate: '',
};

const CREDENTIAL_TYPES: Record<string, string> = {
  '1': '🎓 Degree',
  '2': '🏛️ License',
  '3': '💼 Employment',
  '4': '📜 Certification',
  '5': '🔬 Research',
};

interface SearchResult {
  credential: Credential;
  attestors: string[];
  expired: boolean;
}

/** Apply client-side filters to results */
export function applyFilters(results: SearchResult[], filters: SearchFilters): SearchResult[] {
  return results.filter(({ credential, expired }) => {
    if (filters.issuer && !credential.issuer.toLowerCase().includes(filters.issuer.toLowerCase())) return false;
    if (filters.credentialType && credential.credential_type !== Number(filters.credentialType)) return false;
    if (filters.status === 'revoked' && !credential.revoked) return false;
    if (filters.status === 'active' && (credential.revoked || expired)) return false;
    if (filters.status === 'expired' && !expired) return false;
    if (filters.startDate) {
      const start = new Date(filters.startDate).getTime() / 1000;
      if (credential.expires_at && Number(credential.expires_at) < start) return false;
    }
    if (filters.endDate) {
      const end = new Date(filters.endDate).getTime() / 1000;
      if (credential.expires_at && Number(credential.expires_at) > end) return false;
    }
    return true;
  });
}

export default function CredentialSearch() {
  const [filters, setFilters] = useState<SearchFilters>(EMPTY_FILTERS);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSearch = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const subject = filters.subject.trim();
    if (!subject) {
      setError('Subject address is required to search.');
      return;
    }
    if (!subject.startsWith('G') || subject.length < 56) {
      setError('Please enter a valid Stellar address for Subject (starts with G, 56+ chars).');
      return;
    }

    setLoading(true);
    setError(null);
    setResults(null);

    try {
      const ids: bigint[] = await getCredentialsBySubject(subject);
      const fetched = await Promise.all(
        ids.map(async (id): Promise<SearchResult> => {
          const [credential, attestors, expired] = await Promise.all([
            getCredential(id),
            getAttestors(id).catch(() => [] as string[]),
            isExpired(id).catch(() => false),
          ]);
          return { credential, attestors, expired };
        })
      );
      setResults(applyFilters(fetched, filters));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed.');
    } finally {
      setLoading(false);
    }
  }, [filters]);

  const handleReset = () => {
    setFilters(EMPTY_FILTERS);
    setResults(null);
    setError(null);
  };

  const handleExport = (format: 'json' | 'csv') => {
    if (!results || results.length === 0) return;
    exportCredentials(results.map((r) => r.credential), format);
  };

  const setFilter = <K extends keyof SearchFilters>(key: K, value: SearchFilters[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <>
      <main className="container" style={{ paddingBottom: 64 }}>
        <div className="verify-hero">
          <div className="verify-hero__eyebrow">🔎 Credential Search</div>
          <h1 className="verify-hero__title">Search & Filter Credentials</h1>
          <p className="verify-hero__subtitle">
            Search credentials by holder, type, issuer, date range, and status. Export results as JSON or CSV.
          </p>
        </div>

        <form onSubmit={handleSearch} className="search-card" aria-label="Credential search form">
          <div className="filter-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16, marginBottom: 16 }}>
            {/* Subject */}
            <div className="form-group">
              <label htmlFor="cs-subject" style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, display: 'block' }}>
                Subject (Holder) Address *
              </label>
              <input
                id="cs-subject"
                type="text"
                placeholder="G…"
                value={filters.subject}
                onChange={(e) => setFilter('subject', e.target.value)}
                spellCheck={false}
                aria-label="Subject address"
              />
            </div>

            {/* Issuer */}
            <div className="form-group">
              <label htmlFor="cs-issuer" style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, display: 'block' }}>
                Issuer Address
              </label>
              <input
                id="cs-issuer"
                type="text"
                placeholder="G…"
                value={filters.issuer}
                onChange={(e) => setFilter('issuer', e.target.value)}
                spellCheck={false}
                aria-label="Issuer address"
              />
            </div>

            {/* Credential Type */}
            <div className="form-group">
              <label htmlFor="cs-type" style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, display: 'block' }}>
                Credential Type
              </label>
              <select
                id="cs-type"
                value={filters.credentialType}
                onChange={(e) => setFilter('credentialType', e.target.value)}
                aria-label="Credential type"
              >
                <option value="">All Types</option>
                {Object.entries(CREDENTIAL_TYPES).map(([val, label]) => (
                  <option key={val} value={val}>{label}</option>
                ))}
              </select>
            </div>

            {/* Status */}
            <div className="form-group">
              <label htmlFor="cs-status" style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, display: 'block' }}>
                Status
              </label>
              <select
                id="cs-status"
                value={filters.status}
                onChange={(e) => setFilter('status', e.target.value as CredentialStatus)}
                aria-label="Credential status"
              >
                <option value="all">All Statuses</option>
                <option value="active">✓ Active</option>
                <option value="revoked">⛔ Revoked</option>
                <option value="expired">⏰ Expired</option>
              </select>
            </div>

            {/* Start Date */}
            <div className="form-group">
              <label htmlFor="cs-start" style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, display: 'block' }}>
                Expiry From
              </label>
              <input
                id="cs-start"
                type="date"
                value={filters.startDate}
                onChange={(e) => setFilter('startDate', e.target.value)}
                aria-label="Start date"
              />
            </div>

            {/* End Date */}
            <div className="form-group">
              <label htmlFor="cs-end" style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, display: 'block' }}>
                Expiry To
              </label>
              <input
                id="cs-end"
                type="date"
                value={filters.endDate}
                onChange={(e) => setFilter('endDate', e.target.value)}
                aria-label="End date"
              />
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button type="submit" className="btn btn--primary" disabled={loading}>
              {loading ? '⏳ Searching…' : '🔍 Search'}
            </button>
            <button type="button" className="btn btn--ghost" onClick={handleReset} disabled={loading}>
              Reset
            </button>
            {results && results.length > 0 && (
              <>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => handleExport('json')}
                  aria-label="Export as JSON"
                >
                  📥 Export JSON
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => handleExport('csv')}
                  aria-label="Export as CSV"
                >
                  📊 Export CSV
                </button>
              </>
            )}
          </div>
        </form>

        {error && (
          <div className="error-card" style={{ marginTop: 16 }}>
            <div className="error-card__icon">⚠️</div>
            <div>
              <div className="error-card__title">Search Error</div>
              <div className="error-card__msg">{error}</div>
            </div>
          </div>
        )}

        {results !== null && (
          <div style={{ marginTop: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary, #f1f5f9)' }}>
                Results
              </h2>
              <span className={`badge badge--${results.length > 0 ? 'blue' : 'gray'}`}>
                {results.length} credential{results.length !== 1 ? 's' : ''}
              </span>
            </div>

            {results.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state__icon">🔍</div>
                <div className="empty-state__title">No credentials match your filters</div>
                <p>Try adjusting your search criteria.</p>
              </div>
            ) : (
              <div className="dashboard-grid">
                {results.map(({ credential, attestors, expired }) => (
                  <div key={credential.id.toString()} className="detail-card">
                    <div className="detail-card__header">
                      <span className="detail-card__title">#{credential.id.toString()}</span>
                      <span className={`badge badge--${credential.revoked ? 'red' : expired ? 'gray' : 'green'}`}>
                        {credential.revoked ? '⛔ Revoked' : expired ? '⏰ Expired' : '✓ Active'}
                      </span>
                    </div>
                    <div className="detail-card__body">
                      <div className="meta-grid">
                        <div className="meta-item">
                          <div className="meta-item__label">Type</div>
                          <div className="meta-item__value">{credTypeLabel(credential.credential_type)}</div>
                        </div>
                        <div className="meta-item">
                          <div className="meta-item__label">Attestors</div>
                          <div className="meta-item__value">{attestors.length}</div>
                        </div>
                        <div className="meta-item" style={{ gridColumn: '1 / -1' }}>
                          <div className="meta-item__label">Issuer</div>
                          <div className="meta-item__value meta-item__value--mono" style={{ fontSize: 11 }}>
                            {formatAddress(credential.issuer)}
                          </div>
                        </div>
                        <div className="meta-item">
                          <div className="meta-item__label">Expires</div>
                          <div className="meta-item__value">
                            {credential.expires_at ? formatTimestamp(credential.expires_at) : 'Never'}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>

      <footer className="footer">
        <div className="container">
          Powered by{' '}
          <a href="https://stellar.org" target="_blank" rel="noopener">Stellar Soroban</a>
          {' · '}
          <a href="https://github.com/Phantomcall/QuorumProof" target="_blank" rel="noopener">QuorumProof</a>
        </div>
      </footer>
    </>
  );
}
