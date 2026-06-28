import { useState, useCallback } from 'react';
import { Navbar } from '../components/Navbar';
import {
  getCredential,
  getCredentialsBySubject,
  getAttestors,
  isExpired,
} from '../lib/contracts/quorumProof';
import type { Credential } from '../lib/contracts/quorumProof';
import { credTypeLabel, formatAddress } from '../lib/credentialUtils';

const CREDENTIAL_TYPES: Record<string, string> = {
  '': 'All Types',
  '1': 'Degree',
  '2': 'License',
  '3': 'Employment',
  '4': 'Certification',
  '5': 'Research',
};

interface MarketplaceResult {
  credential: Credential;
  attestors: string[];
  expired: boolean;
}

export default function CredentialMarketplace() {
  const [subjectAddress, setSubjectAddress] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [results, setResults] = useState<MarketplaceResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSearch = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const subject = subjectAddress.trim();
      if (!subject) {
        setError('Enter a holder address to search.');
        return;
      }
      if (!subject.startsWith('G') || subject.length < 56) {
        setError('Please enter a valid Stellar address (starts with G, 56+ characters).');
        return;
      }

      setLoading(true);
      setError(null);
      setResults(null);

      try {
        const ids: bigint[] = await getCredentialsBySubject(subject);
        const fetched = await Promise.all(
          ids.map(async (id): Promise<MarketplaceResult> => {
            const [credential, attestors, expired] = await Promise.all([
              getCredential(id),
              getAttestors(id).catch(() => [] as string[]),
              isExpired(id).catch(() => false),
            ]);
            return { credential, attestors, expired };
          })
        );

        const filtered = typeFilter
          ? fetched.filter((r) => String(r.credential.credential_type) === typeFilter)
          : fetched;

        setResults(filtered);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Search failed.');
      } finally {
        setLoading(false);
      }
    },
    [subjectAddress, typeFilter]
  );

  return (
    <>
      <Navbar />
      <main className="container" style={{ paddingBottom: 64 }}>
        <div className="verify-hero">
          <div className="verify-hero__eyebrow">Credential Marketplace</div>
          <h1 className="verify-hero__title">Discover &amp; Verify Credentials</h1>
          <p className="verify-hero__subtitle">
            Search credential holders by address to browse and verify their credentials from
            multiple sources.
          </p>
        </div>

        <form onSubmit={handleSearch} className="search-card" aria-label="Marketplace search">
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
              gap: 16,
              marginBottom: 16,
            }}
          >
            <div className="form-group">
              <label
                htmlFor="mp-subject"
                style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, display: 'block' }}
              >
                Holder Address *
              </label>
              <input
                id="mp-subject"
                type="text"
                placeholder="G…"
                value={subjectAddress}
                onChange={(e) => setSubjectAddress(e.target.value)}
                spellCheck={false}
                aria-label="Holder address"
              />
            </div>

            <div className="form-group">
              <label
                htmlFor="mp-type"
                style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, display: 'block' }}
              >
                Credential Type
              </label>
              <select
                id="mp-type"
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                aria-label="Credential type filter"
              >
                {Object.entries(CREDENTIAL_TYPES).map(([val, label]) => (
                  <option key={val} value={val}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <button type="submit" className="btn btn--primary" disabled={loading}>
            {loading ? 'Searching...' : 'Search Credentials'}
          </button>
        </form>

        {error && (
          <div className="error-card" style={{ marginTop: 16 }}>
            <div className="error-card__icon">!</div>
            <div>
              <div className="error-card__title">Search Error</div>
              <div className="error-card__msg">{error}</div>
            </div>
          </div>
        )}

        {results !== null && (
          <div style={{ marginTop: 24 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 16,
              }}
            >
              <h2 style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary, #f1f5f9)' }}>
                Results
              </h2>
              <span className={`badge badge--${results.length > 0 ? 'blue' : 'gray'}`}>
                {results.length} credential{results.length !== 1 ? 's' : ''}
              </span>
            </div>

            {results.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state__icon">?</div>
                <div className="empty-state__title">No credentials found</div>
                <p>Try a different address or credential type.</p>
              </div>
            ) : (
              <div className="dashboard-grid">
                {results.map(({ credential, attestors, expired }) => {
                  const status = credential.revoked
                    ? 'revoked'
                    : expired
                    ? 'expired'
                    : 'active';
                  return (
                    <div key={credential.id.toString()} className="detail-card">
                      <div className="detail-card__header">
                        <span className="detail-card__title">
                          #{credential.id.toString()} &mdash;{' '}
                          {credTypeLabel(credential.credential_type)}
                        </span>
                        <span
                          className={`badge badge--${
                            status === 'active'
                              ? 'green'
                              : status === 'revoked'
                              ? 'red'
                              : 'gray'
                          }`}
                        >
                          {status === 'active'
                            ? 'Active'
                            : status === 'revoked'
                            ? 'Revoked'
                            : 'Expired'}
                        </span>
                      </div>
                      <div className="detail-card__body">
                        <div className="meta-grid">
                          <div className="meta-item">
                            <div className="meta-item__label">Issuer</div>
                            <div
                              className="meta-item__value meta-item__value--mono"
                              style={{ fontSize: 11 }}
                            >
                              {formatAddress(credential.issuer)}
                            </div>
                          </div>
                          <div className="meta-item">
                            <div className="meta-item__label">Attestors</div>
                            <div className="meta-item__value">{attestors.length}</div>
                          </div>
                        </div>
                        <div style={{ marginTop: 12 }}>
                          <a
                            href={`/verify?id=${credential.id}`}
                            className="btn btn--ghost btn--sm"
                          >
                            Verify Credential
                          </a>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </main>

      <footer className="footer">
        <div className="container">
          Powered by{' '}
          <a href="https://stellar.org" target="_blank" rel="noopener">
            Stellar Soroban
          </a>{' '}
          &middot;{' '}
          <a
            href="https://github.com/Phantomcall/QuorumProof"
            target="_blank"
            rel="noopener"
          >
            QuorumProof
          </a>
        </div>
      </footer>
    </>
  );
}
