import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Navbar } from '../components/Navbar';
import {
  getCredential,
  getAttestors,
  isExpired,
  isAttested,
  getSlice,
} from '../lib/contracts/quorumProof';
import type { Credential } from '../lib/contracts/quorumProof';
import { decodeMetadataHash, NETWORK } from '../stellar';
import { credTypeLabel, formatTimestamp, formatAddress } from '../pages/Verify';

export default function CredentialDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [credential, setCredential] = useState<Credential | null>(null);
  const [attestors, setAttestors] = useState<string[]>([]);
  const [isExpiredFlag, setIsExpiredFlag] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchCredential = async () => {
      if (!id) {
        setError('No credential ID provided');
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        setError(null);
        const credId = BigInt(id);
        const [cred, expired, attestorList] = await Promise.all([
          getCredential(credId),
          isExpired(credId),
          getAttestors(credId),
        ]);
        setCredential(cred);
        setIsExpiredFlag(expired);
        setAttestors(attestorList || []);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to load credential';
        setError(msg);
      } finally {
        setLoading(false);
      }
    };

    fetchCredential();
  }, [id]);

  if (loading) {
    return (
      <>
        <Navbar />
        <main className="container" style={{ paddingTop: '40px' }}>
          <div className="loading-state">
            <div className="spinner" />
            <p>Loading credential…</p>
          </div>
        </main>
      </>
    );
  }

  if (error || !credential) {
    return (
      <>
        <Navbar />
        <main className="container" style={{ paddingTop: '40px' }}>
          <div className="error-card">
            <div className="error-card__icon">⚠️</div>
            <div>
              <div className="error-card__title">Could Not Load Credential</div>
              <div className="error-card__msg">{error || 'Credential not found'}</div>
              <button
                className="btn btn--ghost btn--sm"
                style={{ marginTop: '12px' }}
                onClick={() => navigate('/dashboard')}
              >
                Back to Dashboard
              </button>
            </div>
          </div>
        </main>
      </>
    );
  }

  const metaStr = decodeMetadataHash(credential.metadata_hash);
  const statusBadge = credential.revoked
    ? { label: 'Revoked', icon: '🚫', color: 'var(--red)' }
    : isExpiredFlag
      ? { label: 'Expired', icon: '⏰', color: 'var(--gray)' }
      : { label: 'Active', icon: '✅', color: 'var(--green)' };

  return (
    <>
      <Navbar />
      <main className="container" style={{ paddingTop: '40px', maxWidth: '800px' }}>
        <article>
          <header style={{ marginBottom: '32px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '16px' }}>
              <h1 style={{ margin: 0 }}>Credential #{id}</h1>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '6px 12px',
                  backgroundColor: 'var(--bg-secondary)',
                  borderRadius: '4px',
                  fontSize: '14px',
                  color: statusBadge.color,
                }}
              >
                {statusBadge.icon} {statusBadge.label}
              </span>
            </div>
            <p style={{ color: 'var(--text-muted)', margin: 0 }}>
              Issued on {NETWORK} network
            </p>
          </header>

          <section style={{ marginBottom: '32px' }}>
            <h2 style={{ fontSize: '16px', fontWeight: '600', marginBottom: '16px' }}>
              Credential Details
            </h2>
            <div style={{ display: 'grid', gap: '12px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '16px' }}>
                <span style={{ color: 'var(--text-muted)', fontSize: '14px' }}>Type</span>
                <span style={{ fontWeight: '500' }}>{credTypeLabel(credential.credential_type)}</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '16px' }}>
                <span style={{ color: 'var(--text-muted)', fontSize: '14px' }}>Subject</span>
                <span className="mono" title={credential.subject} style={{ wordBreak: 'break-all' }}>
                  {formatAddress(credential.subject)}
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '16px' }}>
                <span style={{ color: 'var(--text-muted)', fontSize: '14px' }}>Issuer</span>
                <span className="mono" title={credential.issuer} style={{ wordBreak: 'break-all' }}>
                  {formatAddress(credential.issuer)}
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '16px' }}>
                <span style={{ color: 'var(--text-muted)', fontSize: '14px' }}>Metadata</span>
                <span className="mono">{metaStr || '—'}</span>
              </div>
              {credential.expires_at && (
                <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '16px' }}>
                  <span style={{ color: 'var(--text-muted)', fontSize: '14px' }}>Expires</span>
                  <span>{formatTimestamp(credential.expires_at)}</span>
                </div>
              )}
            </div>
          </section>

          {attestors.length > 0 && (
            <section style={{ marginBottom: '32px' }}>
              <h2 style={{ fontSize: '16px', fontWeight: '600', marginBottom: '16px' }}>
                Attestors ({attestors.length})
              </h2>
              <div style={{ display: 'grid', gap: '8px' }}>
                {attestors.map((addr, idx) => (
                  <div
                    key={addr}
                    style={{
                      padding: '12px',
                      backgroundColor: 'var(--bg-secondary)',
                      borderRadius: '4px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                    }}
                  >
                    <span
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '32px',
                        height: '32px',
                        backgroundColor: 'var(--indigo)',
                        borderRadius: '50%',
                        color: 'white',
                        fontSize: '14px',
                        fontWeight: '600',
                      }}
                    >
                      {idx + 1}
                    </span>
                    <span className="mono" title={addr} style={{ wordBreak: 'break-all', flex: 1 }}>
                      {formatAddress(addr)}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <div style={{ display: 'flex', gap: '12px', marginTop: '32px' }}>
            <button
              className="btn btn--ghost"
              onClick={() => navigate('/dashboard')}
            >
              ← Back to Dashboard
            </button>
          </div>
        </article>
      </main>
    </>
  );
}