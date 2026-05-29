import { useState } from 'react';
import { CREDENTIAL_TYPES } from '../lib/credentialUtils';

export type StatusFilter = 'all' | 'active' | 'expired' | 'revoked';
export type SortField = 'issued' | 'expiry' | 'issuer';
export type SortOrder = 'asc' | 'desc';

export interface SearchFilters {
  query?: string;
  credentialType?: number;
  status: StatusFilter;
  sortField: SortField;
  sortOrder: SortOrder;
}

interface Props {
  onSearch: (filters: SearchFilters) => void;
  loading?: boolean;
}

const DEFAULT_FILTERS: SearchFilters = {
  query: '',
  credentialType: undefined,
  status: 'all',
  sortField: 'issued',
  sortOrder: 'desc',
};

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: '✅ Active' },
  { value: 'expired', label: '⏰ Expired' },
  { value: 'revoked', label: '🚫 Revoked' },
];

export function CredentialSearchFilter({ onSearch, loading }: Props) {
  const [filters, setFilters] = useState<SearchFilters>(DEFAULT_FILTERS);

  const update = (patch: Partial<SearchFilters>) => {
    const next = { ...filters, ...patch };
    setFilters(next);
    onSearch(next);
  };

  const handleReset = () => {
    setFilters(DEFAULT_FILTERS);
    onSearch(DEFAULT_FILTERS);
  };

  return (
    <div className="search-filter-form">
      {/* Search bar */}
      <div className="form-group" style={{ marginBottom: '12px' }}>
        <input
          id="cred-search"
          type="search"
          placeholder="Search by type, issuer, or holder address…"
          value={filters.query || ''}
          onChange={(e) => update({ query: e.target.value })}
          className="form-input"
          aria-label="Search credentials"
          disabled={loading}
        />
      </div>

      <div className="filter-grid">
        {/* Credential type */}
        <div className="form-group">
          <label htmlFor="credentialType">Type</label>
          <select
            id="credentialType"
            value={filters.credentialType ?? ''}
            onChange={(e) =>
              update({ credentialType: e.target.value ? Number(e.target.value) : undefined })
            }
            className="form-input"
            disabled={loading}
          >
            <option value="">All Types</option>
            {Object.entries(CREDENTIAL_TYPES).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>

        {/* Sort field */}
        <div className="form-group">
          <label htmlFor="sortField">Sort by</label>
          <select
            id="sortField"
            value={filters.sortField}
            onChange={(e) => update({ sortField: e.target.value as SortField })}
            className="form-input"
            disabled={loading}
          >
            <option value="issued">Date Issued</option>
            <option value="expiry">Expiry Date</option>
            <option value="issuer">Issuer</option>
          </select>
        </div>

        {/* Sort order */}
        <div className="form-group">
          <label htmlFor="sortOrder">Order</label>
          <select
            id="sortOrder"
            value={filters.sortOrder}
            onChange={(e) => update({ sortOrder: e.target.value as SortOrder })}
            className="form-input"
            disabled={loading}
          >
            <option value="desc">Newest first</option>
            <option value="asc">Oldest first</option>
          </select>
        </div>
      </div>

      {/* Status filter buttons */}
      <div className="filter-actions" style={{ flexWrap: 'wrap', gap: '8px' }}>
        {STATUS_OPTIONS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            className={`btn btn--sm ${filters.status === value ? 'btn--primary' : 'btn--ghost'}`}
            onClick={() => update({ status: value })}
            disabled={loading}
            aria-pressed={filters.status === value}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={handleReset}
          disabled={loading}
          style={{ marginLeft: 'auto' }}
        >
          Reset
        </button>
      </div>
    </div>
  );
}
