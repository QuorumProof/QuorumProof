import { useState, useEffect, useCallback } from 'react';
import { useWallet } from '../hooks';
import {
  getCredential,
  getCredentialsBySubject,
  getAttestors,
} from '../lib/contracts/quorumProof';
import type { Credential } from '../lib/contracts/quorumProof';
import { credTypeLabel, formatTimestamp, formatAddress } from '../lib/credentialUtils';

interface ManagedCredential {
  credential: Credential;
  attestors: string[];
  selected: boolean;
}

interface AttestorEntry {
  address: string;
  credentialCount: number;
}

export default function IssuerManagement() {
  const { address } = useWallet();
  const [credentials, setCredentials] = useState<ManagedCredential[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'credentials' | 'attestors'>('credentials');
  const [bulkRevoking, setBulkRevoking] = useState(false);
  const [revokeMsg, setRevokeMsg] = useState<string | null>(null);
  const [newAttestor, setNewAttestor] = useState('');
  const [attestorMsg, setAttestorMsg] = useState<string | null>(null);

  const fetchCredentials = useCallback(async (issuerAddress: string) => {
    setLoading(true);
    setError(null);
    try {
      const ids: bigint[] = await getCredentialsBySubject(issuerAddress);
      const results = await Promise.all(
        ids.map(async (id): Promise<ManagedCredential> => {
          const [credential, attestors] = await Promise.all([
            getCredential(id),
            getAttestors(id).catch(() => [] as string[]),
          ]);
          return { credential, attestors, selected: false };
        })
      );
      setCredentials(results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load credentials.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!address) return;
    fetchCredentials(address);
  }, [address, fetchCredentials]);

  const toggleSelect = (id: bigint) => {
    setCredentials((prev) =>
      prev.map((c) =>
        c.credential.id === id ? { ...c, selected: !c.selected } : c
      )
    );
  };

  const toggleSelectAll = () => {
    const allSelected = credentials.every((c) => c.selected);
    setCredentials((prev) => prev.map((c) => ({ ...c, selected: !allSelected })));
  };

  const selectedCount = credentials.filter((c) => c.selected).length;

  const handleBulkRevoke = async () => {
    const selected = credentials.filter((c) => c.selected && !c.credential.revoked);
    if (selected.length === 0) {
      setRevokeMsg('No active credentials selected.');
      return;
    }
    setBulkRevoking(true);
    setRevokeMsg(null);
    try {
      // Optimistic UI update — actual revocation requires wallet signing (not implemented in read-only mode)
      setCredentials((prev) =>
        prev.map((c) =>
          c.selected ? { ...c, credential: { ...c.credential, revoked: true }, selected: false } : c
        )
      );
      setRevokeMsg(`✅ Marked ${selected.length} credential${selected.length !== 1 ? 's' : ''} as revoked. (Requires on-chain transaction to finalize.)`);
    } catch (err) {
      setRevokeMsg(`❌ ${err instanceof Error ? err.message : 'Revocation failed.'}`);
    } finally {
      setBulkRevoking(false);
    }
  };

  const handleAddAttestor = () => {
    const addr = newAttestor.trim();
    if (!addr.startsWith('G') || addr.length < 56) {
      setAttestorMsg('❌ Invalid Stellar address.');
      return;
    }
    setAttestorMsg(`✅ Attestor ${formatAddress(addr)} added. (Requires on-chain transaction to finalize.)`);
    setNewAttestor('');
  };

  // Derive unique attestors across all credentials
  const attestorMap = new Map<string, AttestorEntry>();
  for (const { attestors } of credentials) {
    for (const addr of attestors) {
      const entry = attestorMap.get(addr) ?? { address: addr, credentialCount: 0 };
      entry.credentialCount += 1;
      attestorMap.set(addr, entry);
    }
  }
  const attestorList = Array.from(attestorMap.values());

  if (!address) {
    return (
      <>
        <main className="container">
          <div className="empty-state">
            <div className="empty-state__icon">🔒</div>
            <div className="empty-state__title">Wallet Required</div>
            <p>Connect your wallet to manage issued credentials.</p>
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <main className="container" style={{ paddingBottom: 64 }}>
        <header className="dashboard-header">
          <div>
            <h1 className="dashboard-title">Issuer Management</h1>
            <p className="dashboard-subtitle">Manage credentials you have issued and their attestors</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => fetchCredentials(address)}
              disabled={loading}
            >
              🔄 Refresh
            </button>
          </div>
        </header>

        {/* Tabs */}
        <div className="search-card__tabs" role="tablist" style={{ marginBottom: 24 }}>
          <button
            className={`tab-btn${activeTab === 'credentials' ? ' active' : ''}`}
            role="tab"
            aria-selected={activeTab === 'credentials'}
            onClick={() => setActiveTab('credentials')}
          >
            📋 Credentials ({credentials.length})
          </button>
          <button
            className={`tab-btn${activeTab === 'attestors' ? ' active' : ''}`}
            role="tab"
            aria-selected={activeTab === 'attestors'}
            onClick={() => setActiveTab('attestors')}
          >
            🏛️ Attestors ({attestorList.length})
          </button>
        </div>

        {loading && (
          <div className="loading-state">
            <div className="spinner" />
            <p>Loading credentials…</p>
          </div>
        )}

        {error && (
          <div className="error-card">
            <div className="error-card__icon">⚠️</div>
            <div>
              <div className="error-card__title">Error</div>
              <div className="error-card__msg">{error}</div>
            </div>
          </div>
        )}

        {/* Credentials Tab */}
        {!loading && activeTab === 'credentials' && (
          <>
            {credentials.length > 0 && (
              <div className="detail-card" style={{ marginBottom: 16 }}>
                <div className="detail-card__body" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 14 }}>
                    <input
                      type="checkbox"
                      checked={credentials.length > 0 && credentials.every((c) => c.selected)}
                      onChange={toggleSelectAll}
                      aria-label="Select all credentials"
                    />
                    Select All
                  </label>
                  <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                    {selectedCount} selected
                  </span>
                  <button
                    className="btn btn--primary btn--sm"
                    onClick={handleBulkRevoke}
                    disabled={bulkRevoking || selectedCount === 0}
                    aria-label="Bulk revoke selected credentials"
                  >
                    {bulkRevoking ? '⏳ Revoking…' : '🚫 Bulk Revoke'}
                  </button>
                  {revokeMsg && (
                    <span style={{ fontSize: 13, color: revokeMsg.startsWith('✅') ? 'var(--color-success, #22c55e)' : 'var(--color-error, #ef4444)' }}>
                      {revokeMsg}
                    </span>
                  )}
                </div>
              </div>
            )}

            {credentials.length === 0 && !loading && !error && (
              <div className="empty-state">
                <div className="empty-state__icon">📋</div>
                <div className="empty-state__title">No credentials issued</div>
                <p>You have not issued any credentials yet.</p>
              </div>
            )}

            <div className="dashboard-grid">
              {credentials.map(({ credential, attestors, selected }) => (
                <div
                  key={credential.id.toString()}
                  className="detail-card"
                  style={{ outline: selected ? '2px solid var(--color-indigo, #6366f1)' : 'none', cursor: 'pointer' }}
                  onClick={() => toggleSelect(credential.id)}
                  role="checkbox"
                  aria-checked={selected}
                  tabIndex={0}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && toggleSelect(credential.id)}
                >
                  <div className="detail-card__header">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleSelect(credential.id)}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Select credential ${credential.id}`}
                      />
                      <span className="detail-card__title">#{credential.id.toString()}</span>
                    </div>
                    <span className={`badge badge--${credential.revoked ? 'red' : 'green'}`}>
                      {credential.revoked ? '⛔ Revoked' : '✓ Active'}
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
                        <div className="meta-item__label">Subject</div>
                        <div className="meta-item__value meta-item__value--mono" style={{ fontSize: 11 }}>
                          {formatAddress(credential.subject)}
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
          </>
        )}

        {/* Attestors Tab */}
        {!loading && activeTab === 'attestors' && (
          <>
            <div className="detail-card" style={{ marginBottom: 24 }}>
              <div className="detail-card__header">
                <span className="detail-card__title">ADD ATTESTOR</span>
              </div>
              <div className="detail-card__body">
                <div className="input-group">
                  <div className="input-wrap">
                    <span className="input-icon">G</span>
                    <input
                      type="text"
                      placeholder="Attestor Stellar address (GABC…)"
                      value={newAttestor}
                      onChange={(e) => setNewAttestor(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleAddAttestor()}
                      aria-label="New attestor address"
                      spellCheck={false}
                    />
                  </div>
                  <button className="btn btn--primary" onClick={handleAddAttestor}>
                    Add Attestor
                  </button>
                </div>
                {attestorMsg && (
                  <div style={{ marginTop: 8, fontSize: 13, color: attestorMsg.startsWith('✅') ? 'var(--color-success, #22c55e)' : 'var(--color-error, #ef4444)' }}>
                    {attestorMsg}
                  </div>
                )}
              </div>
            </div>

            {attestorList.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state__icon">🏛️</div>
                <div className="empty-state__title">No attestors</div>
                <p>None of your credentials have attestors yet.</p>
              </div>
            ) : (
              <div className="detail-card">
                <div className="detail-card__header">
                  <span className="detail-card__title">ATTESTORS</span>
                  <span className="badge badge--blue">{attestorList.length} total</span>
                </div>
                <div className="detail-card__body">
                  <div className="attestor-list">
                    {attestorList.map((entry) => (
                      <div key={entry.address} className="attestor-item">
                        <div className="attestor-item__avatar">🏛️</div>
                        <div>
                          <div className="attestor-item__addr" title={entry.address}>{entry.address}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                            {entry.credentialCount} credential{entry.credentialCount !== 1 ? 's' : ''} attested
                          </div>
                        </div>
                        <span className="attestor-item__badge">✓ Active</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </>
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
