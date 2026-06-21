import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  getCredential,
  getCredentialsBySubject,
  getAttestors,
  isExpired,
  isAttested,
} from '../lib/contracts/quorumProof';
import type { Credential } from '../lib/contracts/quorumProof';
import { decodeMetadataHash, CONTRACT_ID, RPC_URL, NETWORK } from '../stellar';
import { credTypeLabel, formatTimestamp, formatAddress } from '../lib/credentialUtils';
import { DEFAULT_SLICE_ID } from './Verify';

interface VerifyResult {
  credential: Credential;
  attestors: string[];
  expired: boolean;
  attested: boolean | null;
  verifiedAt: string;
}

function StatusBanner({ result }: { result: VerifyResult }) {
  const { credential, attestors, expired, attested } = result;
  const revoked = credential.revoked;

  let statusClass: string;
  let icon: string;
  let title: string;
  let sub: string;

  if (revoked) {
    statusClass = 'revoked'; icon = '🚫'; title = 'Credential Revoked';
    sub = 'This credential has been officially revoked.';
  } else if (expired) {
    statusClass = 'expired'; icon = '⏰'; title = 'Credential Expired';
    sub = `Expired on ${formatTimestamp(credential.expires_at)}.`;
  } else if (attested === true || attestors.length > 0) {
    statusClass = 'valid'; icon = '✅'; title = 'Credential Verified';
    sub = `Attested by ${attestors.length} trusted node${attestors.length !== 1 ? 's' : ''}.`;
  } else if (attested === null) {
    statusClass = 'warning'; icon = '⚠️'; title = 'Attestation Unconfirmed';
    sub = 'Could not confirm quorum attestation.';
  } else {
    statusClass = 'pending'; icon = '⏳'; title = 'Awaiting Attestation';
    sub = 'No attestors have signed this credential yet.';
  }

  return (
    <div className={`status-banner status-banner--${statusClass}`}>
      <div className="status-banner__icon">{icon}</div>
      <div>
        <div className="status-banner__title">{title}</div>
        <div className="status-banner__sub">{sub}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
          Verified at: {result.verifiedAt}
        </div>
      </div>
    </div>
  );
}

function CredentialDetails({ result }: { result: VerifyResult }) {
  const { credential, attestors } = result;
  const metaStr = decodeMetadataHash(credential.metadata_hash);

  return (
    <div className="result-section">
      <StatusBanner result={result} />

      <div className="detail-card">
        <div className="detail-card__header">
          <span className="detail-card__title">CREDENTIAL DETAILS</span>
          <span className={`badge badge--${credential.revoked ? 'red' : result.expired ? 'gray' : 'green'}`}>
            {credential.revoked ? '⛔ Revoked' : result.expired ? '⏰ Expired' : '✓ Active'}
          </span>
        </div>
        <div className="detail-card__body">
          <div className="meta-grid">
            <div className="meta-item">
              <div className="meta-item__label">ID</div>
              <div className="meta-item__value meta-item__value--mono">#{credential.id.toString()}</div>
            </div>
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
            <div className="meta-item" style={{ gridColumn: '1 / -1' }}>
              <div className="meta-item__label">Metadata Hash</div>
              <div className="meta-item__value meta-item__value--mono">{metaStr || '—'}</div>
            </div>
            <div className="meta-item">
              <div className="meta-item__label">Expires</div>
              <div className="meta-item__value">{credential.expires_at ? formatTimestamp(credential.expires_at) : 'Never'}</div>
            </div>
            <div className="meta-item">
              <div className="meta-item__label">Network</div>
              <div className="meta-item__value">{NETWORK}</div>
            </div>
          </div>
        </div>
      </div>

      <div className="detail-card">
        <div className="detail-card__header">
          <span className="detail-card__title">ATTESTATION STATUS</span>
          <span className={`badge badge--${attestors.length > 0 ? 'green' : 'gray'}`}>
            {attestors.length} attestor{attestors.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="detail-card__body">
          {attestors.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 14, textAlign: 'center', padding: '20px 0' }}>
              No attestors have signed this credential yet.
            </div>
          ) : (
            <div className="attestor-list">
              {attestors.map((addr) => (
                <div key={addr} className="attestor-item">
                  <div className="attestor-item__avatar">🏛️</div>
                  <div className="attestor-item__addr" title={addr}>{addr}</div>
                  <span className="attestor-item__badge">✓ Signed</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function VerifierUI() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<'id' | 'addr'>('id');
  const [credInput, setCredInput] = useState(searchParams.get('id') || '');
  const [addrInput, setAddrInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [addrResults, setAddrResults] = useState<bigint[] | null>(null);
  const autoTriggered = useRef(false);

  const fetchCred = async (id: bigint) => {
    setLoading(true); setError(null); setResult(null); setAddrResults(null);
    setSearchParams({ id: id.toString() });
    try {
      const [credential, attestors, expired, attested] = await Promise.all([
        getCredential(id),
        getAttestors(id).catch(() => [] as string[]),
        isExpired(id).catch(() => false),
        isAttested(id, DEFAULT_SLICE_ID).catch(() => null),
      ]);
      setResult({
        credential,
        attestors,
        expired,
        attested,
        verifiedAt: new Date().toLocaleString(),
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to fetch credential.');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyId = async () => {
    const id = parseInt(credInput, 10);
    if (isNaN(id) || id < 1) {
      setError('Please enter a valid credential ID (positive integer).');
      return;
    }
    await fetchCred(BigInt(id));
  };

  const handleVerifyAddr = async () => {
    const addr = addrInput.trim();
    if (!addr.startsWith('G') || addr.length < 56) {
      setError('Please enter a valid Stellar address (starts with G, 56+ characters).');
      return;
    }
    setLoading(true); setError(null); setResult(null); setAddrResults(null);
    try {
      const ids: bigint[] = await getCredentialsBySubject(addr);
      setAddrResults(ids || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to look up address.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const preId = searchParams.get('id');
    if (autoTriggered.current || !preId) return;
    autoTriggered.current = true;
    const id = parseInt(preId, 10);
    if (!isNaN(id) && id > 0) fetchCred(BigInt(id));
    else setError('Invalid credential ID in URL.');
  }, []);

  return (
    <>
      <main className="container" style={{ paddingTop: 0, paddingBottom: 64 }}>
        <div className="verify-hero">
          <div className="verify-hero__eyebrow">🔍 Verifier Dashboard</div>
          <h1 className="verify-hero__title">Credential Verification</h1>
          <p className="verify-hero__subtitle">
            Look up credentials by ID or holder address. View attestation status, issuer details, and verification timestamp.
          </p>
        </div>

        <div className="search-card" id="search-card">
          <div className="search-card__label">SEARCH BY</div>
          <div className="search-card__tabs" role="tablist">
            <button
              className={`tab-btn${activeTab === 'id' ? ' active' : ''}`}
              role="tab"
              aria-selected={activeTab === 'id'}
              onClick={() => { setActiveTab('id'); setError(null); }}
            >
              🔑 Credential ID
            </button>
            <button
              className={`tab-btn${activeTab === 'addr' ? ' active' : ''}`}
              role="tab"
              aria-selected={activeTab === 'addr'}
              onClick={() => { setActiveTab('addr'); setError(null); }}
            >
              🌐 Holder Address
            </button>
          </div>

          {activeTab === 'id' && (
            <div className="input-group">
              <div className="input-wrap">
                <span className="input-icon">#</span>
                <input
                  type="number"
                  min="1"
                  placeholder="Enter credential ID (e.g. 42)"
                  value={credInput}
                  onChange={(e) => setCredInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleVerifyId()}
                  aria-label="Credential ID"
                />
              </div>
              <button
                className="btn btn--primary"
                onClick={handleVerifyId}
                disabled={loading}
                style={{ minWidth: 120 }}
              >
                {loading ? 'Verifying…' : 'Verify'}
              </button>
            </div>
          )}

          {activeTab === 'addr' && (
            <div className="input-group">
              <div className="input-wrap">
                <span className="input-icon">G</span>
                <input
                  type="text"
                  placeholder="Enter holder Stellar address (GABC…)"
                  value={addrInput}
                  onChange={(e) => setAddrInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleVerifyAddr()}
                  aria-label="Holder Stellar address"
                  spellCheck={false}
                />
              </div>
              <button
                className="btn btn--primary"
                onClick={handleVerifyAddr}
                disabled={loading}
                style={{ minWidth: 120 }}
              >
                {loading ? 'Looking up…' : 'Look Up'}
              </button>
            </div>
          )}

          <div style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span className="badge badge--gray">🌐 {NETWORK}</span>
            <span
              className="badge badge--gray"
              style={{ fontSize: 10, fontFamily: 'var(--font-mono)', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis' }}
              title={RPC_URL}
            >
              {RPC_URL}
            </span>
            {CONTRACT_ID
              ? <span className="badge badge--blue" style={{ fontSize: 10, fontFamily: 'var(--font-mono)' }} title={`Contract: ${CONTRACT_ID}`}>📄 {formatAddress(CONTRACT_ID)}</span>
              : <span className="badge badge--red">⚠ Contract not configured</span>
            }
          </div>
        </div>

        <div id="results-area">
          {loading && (
            <div className="loading-state">
              <div className="spinner" />
              <p>Verifying on-chain…</p>
            </div>
          )}

          {error && (
            <div className="error-card">
              <div className="error-card__icon">⚠️</div>
              <div>
                <div className="error-card__title">Could Not Verify</div>
                <div className="error-card__msg">{error}</div>
              </div>
            </div>
          )}

          {result && <CredentialDetails result={result} />}

          {addrResults && addrResults.length === 0 && (
            <div className="empty-state">
              <div className="empty-state__icon">🔍</div>
              <div className="empty-state__title">No credentials found</div>
              <p>This address has no credentials recorded on-chain.</p>
            </div>
          )}

          {addrResults && addrResults.length > 0 && (
            <div className="result-section">
              <div className="detail-card">
                <div className="detail-card__header">
                  <span className="detail-card__title">CREDENTIALS FOR ADDRESS</span>
                  <span className="badge badge--blue">{addrResults.length} found</span>
                </div>
                <div className="detail-card__body">
                  <div className="cred-list">
                    {addrResults.map((id) => (
                      <div
                        key={id.toString()}
                        className="cred-list-item"
                        role="button"
                        tabIndex={0}
                        onClick={() => fetchCred(id)}
                        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fetchCred(id)}
                      >
                        <div>
                          <div className="cred-list-item__id">Credential #{id.toString()}</div>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                            Click to view full details and attestation status
                          </div>
                        </div>
                        <span style={{ color: 'var(--text-muted)' }}>→</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
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
