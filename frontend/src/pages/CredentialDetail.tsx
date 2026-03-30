import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Navbar } from '../components/Navbar';
import {
  getCredential,
  getAttestors,
  isExpired,
  getSlice,
} from '../lib/contracts/quorumProof';
import type { Credential, QuorumSlice } from '../lib/contracts/quorumProof';
import { decodeMetadataHash, NETWORK } from '../stellar';
import {
  credTypeLabel,
  formatTimestamp,
  formatAddress,
  attestorRole,
} from '../lib/credentialUtils';

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button className="btn btn--ghost btn--sm" onClick={handleCopy}>
      {copied ? '✓ Copied' : label}
    </button>
  );
}

function ThresholdProgress({
  attestorCount,
  threshold,
}: {
  attestorCount: number;
  threshold: number;
}) {
  const met = attestorCount >= threshold;
  const pct = threshold > 0 ? Math.min((attestorCount / threshold) * 100, 100) : 0;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          {attestorCount} of {threshold} attestors
        </span>
        <span
          className={`badge badge--${met ? 'green' : 'blue'}`}
          style={{ fontSize: 11 }}
        >
          {met ? '✓ Fully Attested' : 'Pending Quorum'}
        </span>
      </div>
      <div className="slice-progress">
        <div className="slice-progress__bar" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function AttestorTimeline({
  attestors,
  threshold,
}: {
  attestors: string[];
  threshold: number;
}) {
  if (attestors.length === 0) {
    return (
      <div style={{ color: 'var(--text-muted)', fontSize: 14, textAlign: 'center', padding: '20px 0' }}>
        No attestors have signed this credential yet.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {attestors.map((addr, idx) => {
        const isLast = idx === attestors.length - 1;
        const isMet = idx < threshold;
        return (
          <div key={addr} style={{ display: 'flex', gap: 12, position: 'relative' }}>
            {/* Timeline spine */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: '50%',
                  background: isMet
                    ? 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))'
                    : 'var(--bg-surface)',
                  border: `2px solid ${isMet ? 'var(--accent-primary)' : 'var(--border)'}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 13,
                  fontWeight: 700,
                  color: isMet ? '#fff' : 'var(--text-muted)',
                  flexShrink: 0,
                  zIndex: 1,
                }}
              >
                {idx + 1}
              </div>
              {!isLast && (
                <div
                  style={{
                    width: 2,
                    flex: 1,
                    minHeight: 16,
                    background: 'var(--border)',
                    margin: '2px 0',
                  }}
                />
              )}
            </div>

            {/* Attestor card */}
            <div
              style={{
                flex: 1,
                background: 'var(--bg-surface)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
                padding: '10px 14px',
                marginBottom: isLast ? 0 : 8,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                flexWrap: 'wrap',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: 'var(--text-muted)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  {attestorRole(idx)}
                </span>
                <span
                  className="mono"
                  title={addr}
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    color: 'var(--accent-primary)',
                    wordBreak: 'break-all',
                  }}
                >
                  {addr}
                </span>
              </div>
              <span className="badge badge--green" style={{ flexShrink: 0 }}>✓ Signed</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function CredentialDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [credential, setCredential] = useState<Credential | null>(null);
  const [attestors, setAttestors] = useState<string[]>([]);
  const [slice, setSlice] = useState<QuorumSlice | null>(null);
  const [isExpiredFlag, setIsExpiredFlag] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchAll = async () => {
      if (!id) { setError('No credential ID provided'); setLoading(false); return; }
      try {
        setLoading(true);
        setError(null);
        const credId = BigInt(id);
        const [cred, expired, attestorList] = await Promise.all([
          getCredential(credId),
          isExpired(credId).catch(() => false),
          getAttestors(credId).catch(() => [] as string[]),
        ]);
        setCredential(cred);
        setIsExpiredFlag(expired);
        setAttestors(attestorList || []);

        // Try to load the slice stored locally (set by QuorumSlice builder)
        const sliceIdRaw = localStorage.getItem('qp-slice-id');
        if (sliceIdRaw) {
          const s = await getSlice(BigInt(sliceIdRaw)).catch(() => null);
          setSlice(s);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load credential');
      } finally {
        setLoading(false);
      }
    };
    fetchAll();
  }, [id]);

  if (loading) {
    return (
      <>
        <Navbar />
        <main className="container" style={{ paddingTop: 40 }}>
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
        <main className="container" style={{ paddingTop: 40 }}>
          <div className="error-card">
            <div className="error-card__icon">⚠️</div>
            <div>
              <div className="error-card__title">Could Not Load Credential</div>
              <div className="error-card__msg">{error || 'Credential not found'}</div>
              <button
                className="btn btn--ghost btn--sm"
                style={{ marginTop: 12 }}
                onClick={() => navigate('/dashboard')}
              >
                ← Back to Dashboard
              </button>
            </div>
          </div>
        </main>
      </>
    );
  }

  const metaStr = decodeMetadataHash(credential.metadata_hash);
  const shareUrl = `${window.location.origin}/verify?id=${id}`;
  const threshold = slice?.threshold ?? attestors.length;

  const statusBadge = credential.revoked
    ? { cls: 'revoked', icon: '🚫', label: 'Revoked' }
    : isExpiredFlag
      ? { cls: 'expired', icon: '⏰', label: 'Expired' }
      : attestors.length >= threshold && threshold > 0
        ? { cls: 'valid', icon: '✅', label: 'Active & Attested' }
        : { cls: 'pending', icon: '⏳', label: 'Awaiting Attestation' };

  return (
    <>
      <Navbar />
      <main className="container" style={{ paddingTop: 40, paddingBottom: 64, maxWidth: 800 }}>
        <article className="result-section">

          {/* ── Status Banner ── */}
          <div className={`status-banner status-banner--${statusBadge.cls}`} style={{ marginBottom: 24 }}>
            <div className="status-banner__icon">{statusBadge.icon}</div>
            <div>
              <div className="status-banner__title">
                Credential #{id} — {statusBadge.label}
              </div>
              <div className="status-banner__sub">
                {credential.revoked
                  ? 'This credential has been officially revoked and is no longer valid.'
                  : isExpiredFlag
                    ? `Expired on ${formatTimestamp(credential.expires_at)}.`
                    : `Issued on ${NETWORK} network · ${attestors.length} attestor${attestors.length !== 1 ? 's' : ''}`}
              </div>
            </div>
          </div>

          {/* ── Share Bar ── */}
          <div className="share-bar" style={{ marginBottom: 24 }}>
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>🔗 Share:</span>
            <span className="share-bar__url">{shareUrl}</span>
            <CopyButton text={shareUrl} label="Copy Link" />
          </div>

          {/* ── Credential Details ── */}
          <div className="detail-card" style={{ marginBottom: 20 }}>
            <div className="detail-card__header">
              <span className="detail-card__title">Credential Details</span>
              <span className={`badge badge--${credential.revoked ? 'red' : isExpiredFlag ? 'gray' : 'green'}`}>
                {credential.revoked ? '⛔ Revoked' : isExpiredFlag ? '⏰ Expired' : '✓ Active'}
              </span>
            </div>
            <div className="detail-card__body">
              <div className="meta-grid">
                <div className="meta-item">
                  <div className="meta-item__label">ID</div>
                  <div className="meta-item__value meta-item__value--mono">#{id}</div>
                </div>
                <div className="meta-item">
                  <div className="meta-item__label">Type</div>
                  <div className="meta-item__value">{credTypeLabel(credential.credential_type)}</div>
                </div>
                <div className="meta-item" style={{ gridColumn: '1 / -1' }}>
                  <div className="meta-item__label">Subject</div>
                  <div className="meta-item__value meta-item__value--mono" title={credential.subject}>
                    {credential.subject}
                  </div>
                </div>
                <div className="meta-item" style={{ gridColumn: '1 / -1' }}>
                  <div className="meta-item__label">Issuer</div>
                  <div className="meta-item__value meta-item__value--mono" title={credential.issuer}>
                    {credential.issuer}
                  </div>
                </div>
                {metaStr && (
                  <div className="meta-item" style={{ gridColumn: '1 / -1' }}>
                    <div className="meta-item__label">Metadata</div>
                    <div className="meta-item__value meta-item__value--mono">{metaStr}</div>
                  </div>
                )}
                <div className="meta-item">
                  <div className="meta-item__label">Expires</div>
                  <div className="meta-item__value">
                    {credential.expires_at ? formatTimestamp(credential.expires_at) : 'Never'}
                  </div>
                </div>
                <div className="meta-item">
                  <div className="meta-item__label">Network</div>
                  <div className="meta-item__value">{NETWORK}</div>
                </div>
              </div>

              {/* Revocation notice */}
              {credential.revoked && (
                <div
                  style={{
                    marginTop: 16,
                    padding: '12px 16px',
                    background: 'var(--red-subtle)',
                    border: '1px solid rgba(239,68,68,0.25)',
                    borderRadius: 'var(--radius-md)',
                    fontSize: 13,
                    color: 'var(--red)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  🚫 This credential was revoked
                  {credential.expires_at ? ` · last valid ${formatTimestamp(credential.expires_at)}` : ''}
                </div>
              )}
            </div>
          </div>

          {/* ── Quorum Threshold Progress ── */}
          <div className="detail-card" style={{ marginBottom: 20 }}>
            <div className="detail-card__header">
              <span className="detail-card__title">Quorum Progress</span>
              <span className="badge badge--gray">
                {slice ? `Slice #${slice.id.toString()}` : 'No slice loaded'}
              </span>
            </div>
            <div className="detail-card__body">
              <ThresholdProgress attestorCount={attestors.length} threshold={threshold} />
              {slice && (
                <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)' }}>
                  Creator:{' '}
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
                    {formatAddress(slice.creator)}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* ── Attestor Timeline ── */}
          <div className="detail-card" style={{ marginBottom: 20 }}>
            <div className="detail-card__header">
              <span className="detail-card__title">Attestor Timeline</span>
              <span className={`badge badge--${attestors.length > 0 ? 'green' : 'gray'}`}>
                {attestors.length} node{attestors.length !== 1 ? 's' : ''}
              </span>
            </div>
            <div className="detail-card__body">
              <AttestorTimeline attestors={attestors} threshold={threshold} />
            </div>
          </div>

          {/* ── Actions ── */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <button className="btn btn--ghost" onClick={() => navigate('/dashboard')}>
              ← Back to Dashboard
            </button>
            <CopyButton
              text={shareUrl}
              label="🔗 Share Verification Link"
            />
          </div>

        </article>
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
