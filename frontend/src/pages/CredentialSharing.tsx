/**
 * CredentialSharing — Issue #670
 * Full credential sharing interface with selective disclosure:
 * - Share token generation with permission matrix
 * - Time-limited and revocable access
 * - QR code generation for shareable links
 * - Access log viewer (audit trail)
 */
import { useState, useEffect, useCallback } from 'react';
import { useWallet } from '../hooks';
import { generateShareLink, bytesToHex } from '../stellar';

// ── Types ─────────────────────────────────────────────────────────────────────

export type SharePermission = 'read-only' | 'proof-only' | 'full';

interface ShareToken {
  id: string;
  credentialId: string;
  permission: SharePermission;
  expiresAt: number; // unix ms
  link: string;
  qrDataUrl: string | null;
  createdAt: number;
  revoked: boolean;
}

interface AccessLogEntry {
  tokenId: string;
  credentialId: string;
  accessedAt: number;
  permission: SharePermission;
  verifier: string;
}

const PERMISSION_LABELS: Record<SharePermission, { label: string; desc: string }> = {
  'read-only':   { label: 'Read-only',   desc: 'View credential metadata only' },
  'proof-only':  { label: 'Proof-only',  desc: 'Verify proof without seeing details' },
  'full':        { label: 'Full access', desc: 'Read, verify, and export' },
};

const EXPIRY_OPTIONS = [
  { hours: 1,    label: '1 hour' },
  { hours: 24,   label: '24 hours' },
  { hours: 72,   label: '3 days' },
  { hours: 168,  label: '7 days' },
];

const STORAGE_KEY = 'qp_share_tokens';
const LOG_KEY = 'qp_access_log';

// ── QR code via Google Charts (no extra dependency) ───────────────────────────
function qrUrl(data: string): string {
  return `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(data)}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadTokens(): ShareToken[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]'); } catch { return []; }
}
function saveTokens(tokens: ShareToken[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
}
function loadLog(): AccessLogEntry[] {
  try { return JSON.parse(localStorage.getItem(LOG_KEY) ?? '[]'); } catch { return []; }
}
function saveLog(log: AccessLogEntry[]) {
  localStorage.setItem(LOG_KEY, JSON.stringify(log));
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function CredentialSharing() {
  const { address } = useWallet();

  // Form state
  const [credentialId, setCredentialId] = useState('');
  const [permission, setPermission] = useState<SharePermission>('read-only');
  const [expiryHours, setExpiryHours] = useState(24);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState('');

  // Token list
  const [tokens, setTokens] = useState<ShareToken[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'tokens' | 'log'>('tokens');

  // Access log
  const [accessLog, setAccessLog] = useState<AccessLogEntry[]>([]);

  useEffect(() => {
    setTokens(loadTokens());
    setAccessLog(loadLog());
  }, []);

  // Simulate an access log entry when a link is copied (demo behaviour)
  const recordAccess = useCallback((token: ShareToken) => {
    const entry: AccessLogEntry = {
      tokenId: token.id,
      credentialId: token.credentialId,
      accessedAt: Date.now(),
      permission: token.permission,
      verifier: 'self (link copied)',
    };
    const updated = [entry, ...loadLog()].slice(0, 200);
    saveLog(updated);
    setAccessLog(updated);
  }, []);

  async function handleGenerate() {
    if (!credentialId.trim()) { setGenError('Enter a credential ID.'); return; }
    if (!address) { setGenError('Connect your wallet to generate share tokens.'); return; }
    setGenerating(true);
    setGenError('');
    try {
      const tokenBytes = await generateShareLink(address, credentialId.trim(), expiryHours);
      const hex = bytesToHex(tokenBytes);
      const link = `${window.location.origin}/verify?token=${hex}&perm=${permission}`;
      const token: ShareToken = {
        id: hex.slice(0, 16),
        credentialId: credentialId.trim(),
        permission,
        expiresAt: Date.now() + expiryHours * 3600 * 1000,
        link,
        qrDataUrl: qrUrl(link),
        createdAt: Date.now(),
        revoked: false,
      };
      const updated = [token, ...tokens];
      setTokens(updated);
      saveTokens(updated);
    } catch (err: unknown) {
      setGenError(err instanceof Error ? err.message : 'Failed to generate share token.');
    } finally {
      setGenerating(false);
    }
  }

  function handleRevoke(tokenId: string) {
    const updated = tokens.map((t) => t.id === tokenId ? { ...t, revoked: true } : t);
    setTokens(updated);
    saveTokens(updated);
  }

  function handleCopy(token: ShareToken) {
    navigator.clipboard.writeText(token.link).then(() => {
      setCopiedId(token.id);
      setTimeout(() => setCopiedId(null), 2000);
      recordAccess(token);
    });
  }

  const activeTokens = tokens.filter((t) => !t.revoked && t.expiresAt > Date.now());
  const expiredOrRevoked = tokens.filter((t) => t.revoked || t.expiresAt <= Date.now());

  return (
    <main className="container" style={{ paddingBottom: 64 }}>
      <header className="dashboard-header" style={{ marginBottom: 24 }}>
        <div>
          <h1 className="dashboard-title">Credential Sharing</h1>
          <p className="dashboard-subtitle">Generate time-limited share tokens with fine-grained permission control</p>
        </div>
      </header>

      {/* Generate token form */}
      <div className="detail-card" style={{ marginBottom: 24 }}>
        <div className="detail-card__header">
          <span className="detail-card__title">🔗 GENERATE SHARE TOKEN</span>
        </div>
        <div className="detail-card__body">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
              Credential ID
              <input
                className="input"
                type="text"
                placeholder="e.g. 42"
                value={credentialId}
                onChange={(e) => { setCredentialId(e.target.value); setGenError(''); }}
                aria-label="Credential ID to share"
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
              Permission
              <select
                className="input"
                value={permission}
                onChange={(e) => setPermission(e.target.value as SharePermission)}
                aria-label="Share permission level"
              >
                {(Object.keys(PERMISSION_LABELS) as SharePermission[]).map((p) => (
                  <option key={p} value={p}>{PERMISSION_LABELS[p].label} — {PERMISSION_LABELS[p].desc}</option>
                ))}
              </select>
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
              Expires after
              <select
                className="input"
                value={expiryHours}
                onChange={(e) => setExpiryHours(Number(e.target.value))}
                aria-label="Link expiry duration"
              >
                {EXPIRY_OPTIONS.map((o) => (
                  <option key={o.hours} value={o.hours}>{o.label}</option>
                ))}
              </select>
            </label>
          </div>

          <button
            className="btn btn--primary"
            style={{ marginTop: 16 }}
            onClick={handleGenerate}
            disabled={generating || !address}
            aria-label="Generate share token"
          >
            {generating ? '⏳ Generating…' : '🔑 Generate Token'}
          </button>

          {!address && (
            <p style={{ marginTop: 8, fontSize: 12, color: '#f59e0b' }}>Connect wallet to generate tokens.</p>
          )}
          {genError && (
            <p style={{ marginTop: 8, fontSize: 12, color: '#ef4444' }} role="alert">{genError}</p>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="search-card__tabs" role="tablist" style={{ marginBottom: 16 }}>
        <button
          className={`tab-btn${activeTab === 'tokens' ? ' active' : ''}`}
          role="tab"
          aria-selected={activeTab === 'tokens'}
          onClick={() => setActiveTab('tokens')}
        >
          🔑 Active Tokens ({activeTokens.length})
        </button>
        <button
          className={`tab-btn${activeTab === 'log' ? ' active' : ''}`}
          role="tab"
          aria-selected={activeTab === 'log'}
          onClick={() => setActiveTab('log')}
        >
          📋 Access Log ({accessLog.length})
        </button>
      </div>

      {/* Active tokens */}
      {activeTab === 'tokens' && (
        <>
          {tokens.length === 0 && (
            <div className="empty-state">
              <div className="empty-state__icon">🔗</div>
              <div className="empty-state__title">No share tokens</div>
              <p>Generate a share token above to start sharing credentials.</p>
            </div>
          )}

          {activeTokens.length > 0 && (
            <div className="dashboard-grid" style={{ marginBottom: 24 }}>
              {activeTokens.map((token) => (
                <TokenCard
                  key={token.id}
                  token={token}
                  copied={copiedId === token.id}
                  onCopy={() => handleCopy(token)}
                  onRevoke={() => handleRevoke(token.id)}
                />
              ))}
            </div>
          )}

          {expiredOrRevoked.length > 0 && (
            <>
              <h3 style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>Expired / Revoked</h3>
              <div className="dashboard-grid">
                {expiredOrRevoked.map((token) => (
                  <TokenCard
                    key={token.id}
                    token={token}
                    copied={false}
                    onCopy={() => {}}
                    onRevoke={() => {}}
                    disabled
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}

      {/* Access log */}
      {activeTab === 'log' && (
        <div className="detail-card">
          <div className="detail-card__header">
            <span className="detail-card__title">ACCESS LOG</span>
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => { saveLog([]); setAccessLog([]); }}
              aria-label="Clear access log"
            >
              🗑 Clear
            </button>
          </div>
          <div className="detail-card__body">
            {accessLog.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No access events recorded yet.</p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                    <th style={{ padding: '4px 8px' }}>Time</th>
                    <th style={{ padding: '4px 8px' }}>Credential</th>
                    <th style={{ padding: '4px 8px' }}>Permission</th>
                    <th style={{ padding: '4px 8px' }}>Token</th>
                    <th style={{ padding: '4px 8px' }}>Verifier</th>
                  </tr>
                </thead>
                <tbody>
                  {accessLog.map((entry, i) => (
                    <tr key={i} style={{ borderTop: '1px solid var(--border-color, #334155)' }}>
                      <td style={{ padding: '6px 8px' }}>{new Date(entry.accessedAt).toLocaleString()}</td>
                      <td style={{ padding: '6px 8px' }}>#{entry.credentialId}</td>
                      <td style={{ padding: '6px 8px' }}>{PERMISSION_LABELS[entry.permission]?.label ?? entry.permission}</td>
                      <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{entry.tokenId}…</td>
                      <td style={{ padding: '6px 8px' }}>{entry.verifier}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

// ── Token Card subcomponent ───────────────────────────────────────────────────
interface TokenCardProps {
  token: ShareToken;
  copied: boolean;
  onCopy: () => void;
  onRevoke: () => void;
  disabled?: boolean;
}

function TokenCard({ token, copied, onCopy, onRevoke, disabled }: TokenCardProps) {
  const expired = token.expiresAt <= Date.now();
  const status = token.revoked ? 'Revoked' : expired ? 'Expired' : 'Active';
  const badgeColor = token.revoked ? 'red' : expired ? 'yellow' : 'green';
  const remaining = token.revoked || expired ? null : Math.max(0, Math.round((token.expiresAt - Date.now()) / 3600000));

  return (
    <div className="detail-card" style={{ opacity: disabled ? 0.6 : 1 }}>
      <div className="detail-card__header">
        <span className="detail-card__title" style={{ fontFamily: 'monospace', fontSize: 12 }}>
          {token.id}…
        </span>
        <span className={`badge badge--${badgeColor}`}>{status}</span>
      </div>
      <div className="detail-card__body">
        <div className="meta-grid">
          <div className="meta-item">
            <div className="meta-item__label">Credential</div>
            <div className="meta-item__value">#{token.credentialId}</div>
          </div>
          <div className="meta-item">
            <div className="meta-item__label">Permission</div>
            <div className="meta-item__value">{PERMISSION_LABELS[token.permission]?.label}</div>
          </div>
          <div className="meta-item">
            <div className="meta-item__label">Expires</div>
            <div className="meta-item__value">
              {remaining !== null ? `${remaining}h remaining` : new Date(token.expiresAt).toLocaleString()}
            </div>
          </div>
        </div>

        {/* QR code */}
        {!disabled && token.qrDataUrl && (
          <div style={{ textAlign: 'center', margin: '12px 0' }}>
            <img
              src={token.qrDataUrl}
              alt={`QR code for credential ${token.credentialId}`}
              width={120}
              height={120}
              style={{ borderRadius: 8, background: '#fff', padding: 4 }}
            />
          </div>
        )}

        {!disabled && (
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              className="btn btn--sm btn--ghost"
              onClick={onCopy}
              aria-label="Copy share link"
            >
              {copied ? '✅ Copied' : '📋 Copy link'}
            </button>
            <button
              className="btn btn--sm btn--ghost"
              onClick={onRevoke}
              style={{ color: '#ef4444' }}
              aria-label="Revoke share token"
            >
              🚫 Revoke
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
