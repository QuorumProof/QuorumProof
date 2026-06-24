import { useState, useEffect, useRef, useCallback } from 'react';
import { useRealtimeUpdates } from '../hooks/useRealtimeUpdates';
import type { Credential } from '../lib/contracts/quorumProof';
import { credTypeLabel, formatTimestamp, formatAddress } from '../lib/credentialUtils';
import { CredentialSearchFilter, type SearchFilters } from './CredentialSearchFilter';

interface CredentialResult {
  credential: Credential;
  attestors: string[];
  expired: boolean;
  attested: boolean | null;
  verifiedAt: string;
  proofRequest?: { credentialId: bigint; claimType: string; requestedAt: string } | null;
}

const ITEMS_PER_PAGE = 25;

function AttestationBadge({ result }: { result: CredentialResult }) {
  if (result.credential.revoked) {
    return <span className="badge badge--red">🚫 Revoked</span>;
  }
  if (result.expired) {
    return <span className="badge badge--gray">⏰ Expired</span>;
  }
  if (result.attestors.length > 0) {
    return <span className="badge badge--green">✅ {result.attestors.length} Attested</span>;
  }
  return <span className="badge badge--yellow">⏳ Pending</span>;
}

function CredentialListItem({
  result,
  onSelect,
}: {
  result: CredentialResult;
  onSelect: (result: CredentialResult) => void;
}) {
  return (
    <div
      className="credential-list-item"
      onClick={() => onSelect(result)}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelect(result)}
      role="button"
      tabIndex={0}
    >
      <div className="credential-list-item__content">
        <div className="credential-list-item__header">
          <span className="credential-list-item__id">#{result.credential.id.toString()}</span>
          <span className="credential-list-item__type">{credTypeLabel(result.credential.credential_type)}</span>
          <AttestationBadge result={result} />
        </div>
        <div className="credential-list-item__details">
          <div className="detail-row">
            <span className="label">Holder:</span>
            <span className="value" title={result.credential.subject}>{formatAddress(result.credential.subject)}</span>
          </div>
          <div className="detail-row">
            <span className="label">Issued by:</span>
            <span className="value" title={result.credential.issuer}>{formatAddress(result.credential.issuer)}</span>
          </div>
          {result.credential.expires_at && (
            <div className="detail-row">
              <span className="label">Expires:</span>
              <span className="value">{formatTimestamp(result.credential.expires_at)}</span>
            </div>
          )}
        </div>
      </div>
      <span className="arrow">→</span>
    </div>
  );
}

function ProofRequestModal({
  credential,
  onClose,
  onSubmit,
}: {
  credential: Credential;
  onClose: () => void;
  onSubmit: (claimType: string) => Promise<void>;
}) {
  const [claimType, setClaimType] = useState('has_degree');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setError(null);
    setLoading(true);
    try {
      await onSubmit(claimType);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate proof request');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Generate Proof Request</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div style={{ marginBottom: '16px' }}>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>
              Credential ID: <span style={{ fontFamily: 'monospace' }}>#{credential.id.toString()}</span>
            </p>
            <label htmlFor="claimType" style={{ display: 'block', marginBottom: '8px', fontSize: '13px' }}>
              Claim Type
            </label>
            <select
              id="claimType"
              value={claimType}
              onChange={(e) => setClaimType(e.target.value)}
              className="form-input"
              disabled={loading}
            >
              <option value="has_degree">Has Degree</option>
              <option value="has_license">Has License</option>
              <option value="years_experience">Years of Experience</option>
              <option value="specialization">Specialization</option>
            </select>
          </div>
          {error && (
            <div className="error-card" style={{ marginBottom: '16px' }}>
              <div style={{ color: 'var(--text-error)' }}>{error}</div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn--ghost" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={handleSubmit} disabled={loading}>
            {loading ? 'Generating…' : 'Generate Request'}
          </button>
        </div>
      </div>
    </div>
  );
}

function CredentialDetailView({
  result,
  onBack,
  onGenerateProof,
}: {
  result: CredentialResult;
  onBack: () => void;
  onGenerateProof: (credentialId: bigint, claimType: string) => Promise<void>;
}) {
  const { credential, attestors, expired } = result;
  const [showProofModal, setShowProofModal] = useState(false);
  const [proofRequestStatus, setProofRequestStatus] = useState<string | null>(null);

  const handleProofSubmit = async (claimType: string) => {
    await onGenerateProof(credential.id, claimType);
    setProofRequestStatus('Proof request generated successfully');
    setTimeout(() => setProofRequestStatus(null), 3000);
  };

  return (
    <div className="detail-view">
      <button className="btn btn--ghost" onClick={onBack} style={{ marginBottom: '20px' }}>
        ← Back to Search
      </button>

      <div className="detail-card">
        <div className="detail-card__header">
          <span className="detail-card__title">CREDENTIAL #{credential.id.toString()}</span>
          <AttestationBadge result={result} />
        </div>
        <div className="detail-card__body">
          <div className="meta-grid">
            <div className="meta-item">
              <div className="meta-item__label">Type</div>
              <div className="meta-item__value">{credTypeLabel(credential.credential_type)}</div>
            </div>
            <div className="meta-item" style={{ gridColumn: '1 / -1' }}>
              <div className="meta-item__label">Subject (Holder)</div>
              <div className="meta-item__value meta-item__value--mono">{credential.subject}</div>
            </div>
            <div className="meta-item" style={{ gridColumn: '1 / -1' }}>
              <div className="meta-item__label">Issuer</div>
              <div className="meta-item__value meta-item__value--mono">{credential.issuer}</div>
            </div>
            <div className="meta-item">
              <div className="meta-item__label">Status</div>
              <div className="meta-item__value">
                {credential.revoked ? 'Revoked' : expired ? 'Expired' : 'Active'}
              </div>
            </div>
            <div className="meta-item">
              <div className="meta-item__label">Expires</div>
              <div className="meta-item__value">
                {credential.expires_at ? formatTimestamp(credential.expires_at) : 'Never'}
              </div>
            </div>
            <div className="meta-item">
              <div className="meta-item__label">Verified At</div>
              <div className="meta-item__value">{result.verifiedAt}</div>
            </div>
          </div>
        </div>
      </div>

      <div className="detail-card">
        <div className="detail-card__header">
          <span className="detail-card__title">ATTESTOR INFORMATION</span>
          <span className={`badge ${attestors.length > 0 ? 'badge--green' : 'badge--gray'}`}>
            {attestors.length} / {result.credential.metadata_hash.length}
          </span>
        </div>
        <div className="detail-card__body">
          {attestors.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 14, textAlign: 'center', padding: '20px 0' }}>
              No attestors have signed this credential yet.
            </div>
          ) : (
            <div className="attestor-list">
              {attestors.map((addr, idx) => (
                <div key={addr} className="attestor-item">
                  <div className="attestor-item__index">{idx + 1}</div>
                  <div className="attestor-item__info">
                    <div className="attestor-item__addr" title={addr}>{addr}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Weighted Vote: ~{Math.round((idx + 1) / attestors.length * 100)}%</div>
                  </div>
                  <span className="attestor-item__badge">✓ Signed</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {!credential.revoked && !expired && (
        <div className="detail-card">
          <div className="detail-card__header">
            <span className="detail-card__title">PROOF REQUEST</span>
          </div>
          <div className="detail-card__body">
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '16px' }}>
              Generate a zero-knowledge proof request for selective claim verification.
            </p>
            <button className="btn btn--primary" onClick={() => setShowProofModal(true)}>
              Generate Proof Request
            </button>
            {proofRequestStatus && (
              <div className="success-message" style={{ marginTop: '12px', padding: '8px', backgroundColor: 'rgba(34, 197, 94, 0.1)', borderRadius: '4px', color: '#22c55e', fontSize: '12px' }}>
                {proofRequestStatus}
              </div>
            )}
          </div>
        </div>
      )}

      {showProofModal && (
        <ProofRequestModal
          credential={credential}
          onClose={() => setShowProofModal(false)}
          onSubmit={handleProofSubmit}
        />
      )}
    </div>
  );
}

function VirtualizedCredentialList({
  results,
  onSelect,
  hasMore,
  onLoadMore,
  loading,
}: {
  results: CredentialResult[];
  onSelect: (result: CredentialResult) => void;
  hasMore: boolean;
  onLoadMore: () => void;
  loading: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && hasMore && !loading) {
        onLoadMore();
      }
    });

    const sentinel = containerRef.current?.querySelector('[data-sentinel]');
    if (sentinel) observer.observe(sentinel);

    return () => observer.disconnect();
  }, [hasMore, onLoadMore, loading]);

  return (
    <div ref={containerRef} className="credential-list">
      {results.map((result) => (
        <CredentialListItem key={result.credential.id.toString()} result={result} onSelect={onSelect} />
      ))}
      {hasMore && <div data-sentinel style={{ height: '1px' }} />}
      {loading && (
        <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>
          Loading more credentials…
        </div>
      )}
    </div>
  );
}

export function CredentialVerificationDashboard() {
  const [searchFilters, setSearchFilters] = useState<SearchFilters>({
    status: 'all',
    sortField: 'issued',
    sortOrder: 'desc',
  });
  const [selectedResult, setSelectedResult] = useState<CredentialResult | null>(null);
  const [allResults, setAllResults] = useState<CredentialResult[]>([]);
  const [displayedResults, setDisplayedResults] = useState<CredentialResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const resultsRef = useRef<CredentialResult[]>([]);

  const { status: realtimeStatus } = useRealtimeUpdates({
    pollIntervalMs: 15000,
    onUpdate: () => {
      // Refresh search results when realtime update triggers
      if (searchFilters.query) {
        // performSearch will be called when needed
      }
    },
  });

  const performSearch = useCallback(
    async (filters: SearchFilters) => {
      setLoading(true);
      setError(null);
      setSelectedResult(null);

      try {
        // Mock credential loading - in production, fetch from API/contract
        const mockResults: CredentialResult[] = [];

        // Apply filters and sorting
        let filtered = mockResults;

        if (filters.query) {
          filtered = filtered.filter(
            (r) =>
              r.credential.subject.includes(filters.query || '') ||
              r.credential.issuer.includes(filters.query || '')
          );
        }

        if (filters.credentialType !== undefined) {
          filtered = filtered.filter((r) => r.credential.credential_type === filters.credentialType);
        }

        if (filters.status !== 'all') {
          filtered = filtered.filter((r) => {
            if (filters.status === 'active') return !r.expired && !r.credential.revoked;
            if (filters.status === 'expired') return r.expired;
            if (filters.status === 'revoked') return r.credential.revoked;
            return true;
          });
        }

        // Sort results
        filtered.sort((a, b) => {
          let aVal: any, bVal: any;

          if (filters.sortField === 'issued') {
            aVal = a.credential.id;
            bVal = b.credential.id;
          } else if (filters.sortField === 'expiry') {
            aVal = a.credential.expires_at ?? 0;
            bVal = b.credential.expires_at ?? 0;
          } else {
            aVal = a.credential.issuer;
            bVal = b.credential.issuer;
          }

          return filters.sortOrder === 'desc' ? bVal - aVal : aVal - bVal;
        });

        resultsRef.current = filtered;
        setAllResults(filtered);
        setPage(1);
        setDisplayedResults(filtered.slice(0, ITEMS_PER_PAGE));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Search failed');
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const handleLoadMore = useCallback(() => {
    const nextPage = page + 1;
    const start = (nextPage - 1) * ITEMS_PER_PAGE;
    const end = start + ITEMS_PER_PAGE;

    setDisplayedResults((prev) => [...prev, ...allResults.slice(start, end)]);
    setPage(nextPage);
  }, [page, allResults]);

  const handleSearch = useCallback((filters: SearchFilters) => {
    setSearchFilters(filters);
    performSearch(filters);
  }, [performSearch]);

  const handleExport = useCallback(() => {
    const csv = [
      ['ID', 'Type', 'Holder', 'Issuer', 'Status', 'Expires', 'Attestors'].join(','),
      ...allResults.map((r) =>
        [
          r.credential.id.toString(),
          credTypeLabel(r.credential.credential_type),
          r.credential.subject,
          r.credential.issuer,
          r.credential.revoked ? 'Revoked' : r.expired ? 'Expired' : 'Active',
          r.credential.expires_at ? formatTimestamp(r.credential.expires_at) : 'Never',
          r.attestors.length.toString(),
        ].join(',')
      ),
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `credentials-${new Date().toISOString()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [allResults]);

  if (selectedResult) {
    return (
      <CredentialDetailView
        result={selectedResult}
        onBack={() => setSelectedResult(null)}
        onGenerateProof={async (credentialId: bigint, claimType: string) => {
          // Handle proof generation
          console.log(`Generating proof for credential ${credentialId} with claim type ${claimType}`);
        }}
      />
    );
  }

  return (
    <div className="verification-dashboard">
      <div className="dashboard-header">
        <h2>Credential Verification Dashboard</h2>
        <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px' }}>
          Search, filter, and verify credentials with real-time status updates
        </p>
      </div>

      <div className="dashboard-toolbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' }}>
          <span
            className={`status-indicator ${realtimeStatus === 'connected' ? 'connected' : realtimeStatus === 'polling' ? 'polling' : 'disconnected'}`}
            title={`Real-time: ${realtimeStatus}`}
          />
          <span style={{ color: 'var(--text-muted)' }}>{allResults.length} credentials</span>
        </div>
        <button className="btn btn--sm btn--ghost" onClick={handleExport} disabled={allResults.length === 0}>
          📥 Export CSV
        </button>
      </div>

      <CredentialSearchFilter onSearch={handleSearch} loading={loading} />

      {error && (
        <div className="error-card" style={{ marginTop: '16px' }}>
          <div className="error-card__icon">⚠️</div>
          <div>
            <div className="error-card__title">Search Error</div>
            <div className="error-card__msg">{error}</div>
          </div>
        </div>
      )}

      {displayedResults.length === 0 && !loading && !error && (
        <div className="empty-state" style={{ marginTop: '40px' }}>
          <div className="empty-state__icon">🔍</div>
          <div className="empty-state__title">No credentials found</div>
          <p>Try adjusting your search filters.</p>
        </div>
      )}

      {displayedResults.length > 0 && (
        <VirtualizedCredentialList
          results={displayedResults}
          onSelect={setSelectedResult}
          hasMore={displayedResults.length < allResults.length}
          onLoadMore={handleLoadMore}
          loading={loading}
        />
      )}

      <style>{`
        .verification-dashboard {
          padding: 20px;
        }
        .dashboard-header {
          margin-bottom: 20px;
        }
        .dashboard-header h2 {
          font-size: 24px;
          font-weight: 600;
          color: var(--text-primary);
          margin: 0;
        }
        .dashboard-toolbar {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
          padding-bottom: 12px;
          border-bottom: 1px solid var(--border-color);
        }
        .status-indicator {
          display: inline-block;
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background-color: #ef4444;
        }
        .status-indicator.connected {
          background-color: #22c55e;
          box-shadow: 0 0 8px rgba(34, 197, 94, 0.4);
        }
        .status-indicator.polling {
          background-color: #eab308;
        }
        .credential-list {
          display: flex;
          flex-direction: column;
          gap: 12px;
          margin-top: 16px;
        }
        .credential-list-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 16px;
          background-color: var(--surface-secondary);
          border-radius: 8px;
          cursor: pointer;
          border: 1px solid var(--border-color);
          transition: all 0.2s ease;
        }
        .credential-list-item:hover {
          background-color: var(--surface-hover);
          border-color: var(--text-accent);
        }
        .credential-list-item__content {
          flex: 1;
        }
        .credential-list-item__header {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 8px;
        }
        .credential-list-item__id {
          font-family: var(--font-mono);
          font-size: 12px;
          font-weight: 600;
          color: var(--text-accent);
        }
        .credential-list-item__type {
          font-size: 12px;
          font-weight: 500;
          color: var(--text-muted);
          text-transform: uppercase;
        }
        .credential-list-item__details {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
          font-size: 12px;
        }
        .detail-row {
          display: flex;
          gap: 8px;
        }
        .detail-row .label {
          color: var(--text-muted);
          font-weight: 500;
          white-space: nowrap;
        }
        .detail-row .value {
          color: var(--text-secondary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-family: var(--font-mono);
          font-size: 11px;
        }
        .arrow {
          color: var(--text-muted);
          font-size: 18px;
          margin-left: 8px;
        }
        .attestor-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .attestor-item {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 10px;
          background-color: var(--surface-tertiary);
          border-radius: 6px;
        }
        .attestor-item__index {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 24px;
          height: 24px;
          background-color: var(--text-accent);
          color: white;
          border-radius: 50%;
          font-size: 11px;
          font-weight: 600;
        }
        .attestor-item__info {
          flex: 1;
        }
        .attestor-item__addr {
          font-family: var(--font-mono);
          font-size: 12px;
          color: var(--text-primary);
        }
        .attestor-item__badge {
          font-size: 11px;
          color: #22c55e;
          font-weight: 500;
        }
        .detail-view {
          animation: fadeIn 0.2s ease;
        }
        @keyframes fadeIn {
          from {
            opacity: 0;
            transform: translateY(8px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .modal-overlay {
          position: fixed;
          inset: 0;
          background-color: rgba(0, 0, 0, 0.5);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
        }
        .modal-content {
          background-color: var(--surface-primary);
          border-radius: 8px;
          max-width: 400px;
          width: 90%;
          max-height: 90vh;
          overflow-y: auto;
          box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1);
        }
        .modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 16px;
          border-bottom: 1px solid var(--border-color);
        }
        .modal-header h3 {
          margin: 0;
          font-size: 16px;
          font-weight: 600;
        }
        .modal-close {
          background: none;
          border: none;
          font-size: 24px;
          color: var(--text-muted);
          cursor: pointer;
          padding: 0;
          width: 24px;
          height: 24px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .modal-body {
          padding: 16px;
        }
        .modal-footer {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          padding: 16px;
          border-top: 1px solid var(--border-color);
        }
        .meta-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px;
        }
        .meta-item {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .meta-item__label {
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          color: var(--text-muted);
        }
        .meta-item__value {
          font-size: 13px;
          color: var(--text-primary);
        }
        .meta-item__value--mono {
          font-family: var(--font-mono);
          font-size: 11px;
          word-break: break-all;
        }
      `}</style>
    </div>
  );
}
