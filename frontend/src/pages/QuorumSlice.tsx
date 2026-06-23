import { useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { QuorumSliceBuilder } from '../components/QuorumSliceBuilder';
import { SliceBackupRestore } from '../components/SliceBackupRestore';
import { useWallet } from '../hooks';
import type { SliceBackupData } from '../lib/sliceBackup';
import { decodeSliceFromSearch } from '../lib/sliceBuilderUtils';

function formatAddress(addr: string) {
  if (!addr || addr.length < 10) return addr;
  return addr.slice(0, 8) + '…' + addr.slice(-6);
}

export default function QuorumSlice() {
  const { address } = useWallet();
  const { search } = useLocation();
  const urlSlice = useMemo(() => decodeSliceFromSearch(search), [search]);
  const [restoredSlice, setRestoredSlice] = useState<SliceBackupData | null>(null);

  const sliceIdRaw = localStorage.getItem('qp-slice-id');
  const currentSliceData: SliceBackupData | null = sliceIdRaw
    ? {
        version: 1,
        creator: address ?? '',
        attestors: [],
        threshold: 1,
        createdAt: new Date().toISOString(),
      }
    : null;

  const creatorAddress = address!;

  return (
    <div id="app">
      <main className="dashboard-main">
        <div className="container" style={{ maxWidth: 640 }}>
          <div className="dashboard-header" style={{ marginBottom: 32 }}>
            <h1 className="dashboard-title">Quorum Slice Builder</h1>
            <p className="dashboard-subtitle">
              Compose your attestor quorum, set trust weights, and configure the consensus threshold.
            </p>
          </div>

          <div className="search-card">
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 24,
              }}
            >
              <span className="detail-card__title">Building as</span>
              <span className="wallet-pill" title={creatorAddress}>
                <span className="wallet-pill__dot" aria-hidden="true" />
                {formatAddress(creatorAddress)}
              </span>
            </div>

            {urlSlice ? (
              <div
                className="status-banner status-banner--info"
                style={{ marginBottom: 20 }}
                role="status"
              >
                <span className="status-banner__icon">🔗</span>
                <span>Slice configuration loaded from shared URL.</span>
              </div>
            ) : null}

            <QuorumSliceBuilder
              creatorAddress={creatorAddress}
              initialAttestors={urlSlice?.attestors ?? restoredSlice?.attestors}
              initialThreshold={urlSlice?.threshold ?? restoredSlice?.threshold}
            />
          </div>

          <div className="search-card" style={{ marginTop: 24 }}>
            <SliceBackupRestore
              sliceData={currentSliceData}
              onRestore={(data) => setRestoredSlice(data)}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
