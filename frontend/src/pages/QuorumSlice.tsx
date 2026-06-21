import { useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { Navbar } from '../components/Navbar';
import { QuorumSliceBuilder } from '../components/QuorumSliceBuilder';
import { useFreighter } from '../lib/hooks/useFreighter';
import { decodeSliceFromSearch } from '../lib/sliceBuilderUtils';

function formatAddress(addr: string) {
  if (!addr || addr.length < 10) return addr;
  return addr.slice(0, 8) + '…' + addr.slice(-6);
}

export default function QuorumSlice() {
  const { address, isInitializing, connect, hasFreighter } = useFreighter();
  const { search } = useLocation();
  const urlSlice = useMemo(() => decodeSliceFromSearch(search), [search]);

  return (
    <div id="app">
      <Navbar />
      <main className="dashboard-main">
        <div className="container" style={{ maxWidth: 640 }}>
          <div className="dashboard-header" style={{ marginBottom: 32 }}>
            <h1 className="dashboard-title">Quorum Slice Builder</h1>
            <p className="dashboard-subtitle">
              Compose your attestor quorum, set trust weights, and configure the consensus threshold.
            </p>
          </div>

          {isInitializing ? (
            <div className="search-card" style={{ textAlign: 'center', padding: 32 }}>
              <span className="spinner" aria-hidden="true" style={{ width: 24, height: 24, borderWidth: 3, display: 'inline-block' }} />
              <p style={{ marginTop: 12, color: 'var(--text-secondary)' }}>Connecting wallet…</p>
            </div>
          ) : !address ? (
            <div className="search-card" style={{ textAlign: 'center', padding: 40 }}>
              <div style={{ fontSize: 40, marginBottom: 16 }}>🔒</div>
              <h2 className="detail-card__title" style={{ marginBottom: 8 }}>Connect Your Wallet</h2>
              <p style={{ color: 'var(--text-secondary)', marginBottom: 24 }}>
                You need a connected Freighter wallet to build a quorum slice.
              </p>
              <button className="btn btn--primary" onClick={connect}>
                {hasFreighter ? 'Connect Wallet' : 'Install Freighter'}
              </button>
            </div>
          ) : (
            <div className="search-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
                <span className="detail-card__title">Building as</span>
                <span className="wallet-pill" title={address}>
                  <span className="wallet-pill__dot" aria-hidden="true" />
                  {formatAddress(address)}
                </span>
              </div>

              {urlSlice && (
                <div className="status-banner status-banner--info" style={{ marginBottom: 20 }} role="status">
                  <span className="status-banner__icon">🔗</span>
                  <span>Slice configuration loaded from shared URL.</span>
                </div>
              )}

              <QuorumSliceBuilder
                creatorAddress={address}
                initialAttestors={urlSlice?.attestors}
                initialThreshold={urlSlice?.threshold}
              />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
