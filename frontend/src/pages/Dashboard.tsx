import { useState, useEffect, useCallback, useMemo } from 'react';
import { Navbar } from '../components/Navbar';
import { CredentialCard } from '../components/CredentialCard';
import { CredentialCardSkeleton } from '../components/CredentialCardSkeleton';
import { EmptyState } from '../components/EmptyState';
import { ExportCredentialsDialog } from '../components/ExportCredentialsDialog';
import { ImportCredentialsDialog } from '../components/ImportCredentialsDialog';
import { useWallet, useRealtimeUpdates } from '../hooks';
import {
  getCredentialsBySubject,
  getCredential,
  isAttested,
  getAttestors,
  getSlice,
  isExpired,
} from '../stellar';
import { type CredCardData, filterAndSortCards } from '../lib/credentialUtils';

const DEFAULT_FILTERS: SearchFilters = {
  query: '',
  status: 'all',
  sortField: 'issued',
  sortOrder: 'desc',
};

export default function Dashboard() {
  const { address, disconnect } = useWallet();
  const [cards, setCards] = useState<CredCardData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [filters, setFilters] = useState<SearchFilters>(DEFAULT_FILTERS);

  const visibleCards = useMemo(() => filterAndSortCards(cards, filters), [cards, filters]);

  const fetchCredentials = useCallback(async (walletAddress: string) => {
    setLoading(true);
    setError(null);
    setCards([]);

    const sliceIdRaw = localStorage.getItem('qp-slice-id');
    const sliceId = sliceIdRaw ? BigInt(sliceIdRaw) : null;

    try {
      const ids: bigint[] = await getCredentialsBySubject(walletAddress);

      if (!ids || ids.length === 0) {
        setCards([]);
        return;
      }

      const results = await Promise.all(
        ids.map(async (id): Promise<CredCardData> => {
          try {
            const [credential, expired] = await Promise.all([
              getCredential(id),
              isExpired(id).catch(() => false),
            ]);

            let attested = false;
            let slice = null;
            let sliceError = false;

            if (sliceId !== null) {
              attested = await isAttested(id, sliceId).catch((err) => {
                console.error(`isAttested failed for credential ${id}:`, err);
                return false;
              });
              try {
                slice = await getSlice(sliceId);
              } catch (err) {
                console.error(`getSlice failed for slice ${sliceId}:`, err);
                sliceError = true;
              }
            } else {
              const attestors: string[] = await getAttestors(id).catch(() => []);
              attested = attestors.length > 0;
            }

            return { credential, attested, slice, expired, sliceError, credError: null };
          } catch (err) {
            // Per-card error — return a placeholder so the grid still renders
            const msg = err instanceof Error ? err.message : 'Failed to load credential';
            return {
              credential: {
                id,
                subject: '',
                issuer: '',
                credential_type: 0,
                metadata_hash: new Uint8Array(),
                revoked: false,
                expires_at: null,
              },
              attested: false,
              slice: null,
              expired: false,
              sliceError: false,
              credError: msg,
            };
          }
        })
      );

      setCards(results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load credentials.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!address) return;
    fetchCredentials(address);
  }, [address, retryKey, fetchCredentials]);

  // Real-time updates: WebSocket with polling fallback
  const { status: realtimeStatus } = useRealtimeUpdates({
    wsUrl: import.meta.env.VITE_WS_URL,
    pollIntervalMs: 15_000,
    onUpdate: () => {
      if (address) fetchCredentials(address);
    },
  });

  const sliceIdRaw = localStorage.getItem('qp-slice-id');
  const sliceId = sliceIdRaw ? BigInt(sliceIdRaw) : null;

  return (
    <>
      <Navbar />
      <main className="container container--wide dashboard-main">
        <header className="dashboard-header">
          <div>
            <h1 className="dashboard-title">Credential Dashboard</h1>
            <p className="dashboard-subtitle">Your verifiable credentials on Stellar Soroban</p>
          </div>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
            <span
              className={`badge badge--${realtimeStatus === 'connected' ? 'green' : realtimeStatus === 'polling' ? 'gray' : 'gray'}`}
              title={`Real-time status: ${realtimeStatus}`}
              style={{ alignSelf: 'center' }}
            >
              {realtimeStatus === 'connected' ? '🟢 Live' : realtimeStatus === 'polling' ? '🔄 Polling' : '⚪ Offline'}
            </span>
            {cards.length > 0 && (
              <button
                className="btn btn--primary btn--sm"
                onClick={() => setShowExportDialog(true)}
              >
                📥 Export
              </button>
            )}
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => setShowImportDialog(true)}
            >
              📤 Import
            </button>
            {address && (
              <div className="wallet-sim-card">
                <div className="wallet-sim__label">Connected Address</div>
                <div className="mono" style={{ fontSize: '12px', wordBreak: 'break-all' }}>
                  {address}
                </div>
                <button
                  className="btn btn--ghost btn--sm"
                  style={{ marginTop: '8px' }}
                  onClick={disconnect}
                >
                  Disconnect
                </button>
              </div>
            )}
          </div>
        </header>

        <div className="dashboard-content">
          {/* Search and filter bar */}
          {!error && (
            <CredentialSearchFilter onSearch={setFilters} loading={loading} />
          )}

          {/* Loading credentials */}
          {loading && (
            <div className="dashboard-grid">
              {[1, 2, 3].map((i) => (
                <CredentialCardSkeleton key={`skeleton-${i}`} />
              ))}
            </div>
          )}

          {/* Top-level fetch error */}
          {!loading && error && (
            <div className="error-card">
              <div className="error-card__icon">⚠️</div>
              <div>
                <div className="error-card__title">Could Not Load Credentials</div>
                <div className="error-card__msg">{error}</div>
                <button
                  className="btn btn--ghost btn--sm"
                  style={{ marginTop: '12px' }}
                  onClick={() => setRetryKey((k: number) => k + 1)}
                >
                  Retry
                </button>
              </div>
            </div>
          )}

          {/* Empty state */}
          {!loading && !error && cards.length === 0 && (
            <EmptyState address={address!} />
          )}

          {/* No results after filtering */}
          {!loading && !error && cards.length > 0 && visibleCards.length === 0 && (
            <div className="error-card" style={{ textAlign: 'center' }}>
              <div className="error-card__icon">🔍</div>
              <div className="error-card__title">No credentials match your filters</div>
            </div>
          )}

          {/* Credential grid */}
          {!loading && !error && visibleCards.length > 0 && (
            <div className="dashboard-grid">
              {visibleCards.map((card: CredCardData) => (
                <CredentialCard
                  key={card.credential.id.toString()}
                  data={card}
                  sliceId={sliceId}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      <footer className="footer">
        <div className="container">
          Powered by{' '}
          <a href="https://stellar.org" target="_blank" rel="noopener">
            Stellar Soroban
          </a>{' '}
          ·{' '}
          <a
            href="https://github.com/Phantomcall/QuorumProof"
            target="_blank"
            rel="noopener"
          >
            QuorumProof
          </a>
        </div>
      </footer>

      {showExportDialog && (
        <ExportCredentialsDialog
          credentials={cards.map(c => c.credential)}
          onClose={() => setShowExportDialog(false)}
        />
      )}

      {showImportDialog && (
        <ImportCredentialsDialog
          onImport={(imported) => {
            setCards(prev => [
              ...prev,
              ...imported.map(credential => ({
                credential,
                attested: false,
                slice: null,
                expired: false,
                sliceError: false,
                credError: null,
              })),
            ]);
          }}
          onClose={() => setShowImportDialog(false)}
        />
      )}
    </>
  );
}
