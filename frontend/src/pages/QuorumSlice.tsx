import { QuorumSliceBuilder } from '../components/QuorumSliceBuilder';
import { SliceBackupRestore } from '../components/SliceBackupRestore';
import { useWallet } from '../hooks';
import type { SliceBackupData } from '../lib/sliceBackup';
import { useState } from 'react';

function formatAddress(addr: string) {
  if (!addr || addr.length < 10) return addr;
  return addr.slice(0, 8) + '…' + addr.slice(-6);
}

export default function QuorumSlice() {
  const { address } = useWallet();
  const [restoredSlice, setRestoredSlice] = useState<SliceBackupData | null>(null);

  // Build backup data from localStorage slice if available
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

  return (
    <div id="app">
      <main className="dashboard-main">
        <div className="container" style={{ maxWidth: 600 }}>
          <div className="dashboard-header" style={{ marginBottom: 32 }}>
            <div>
              <h1 className="dashboard-title">Quorum Slice Builder</h1>
              <p className="dashboard-subtitle">
                Compose your attestor quorum, set the threshold, and deploy the slice on-chain.
              </p>
            </div>
          </div>

          <div className="search-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
              <span className="detail-card__title">Building as</span>
              <span className="wallet-pill" title={address!}>
                <span className="wallet-pill__dot" aria-hidden="true" />
                {formatAddress(address!)}
              </span>
            </div>
            <QuorumSliceBuilder
              creatorAddress={address!}
              initialAttestors={restoredSlice?.attestors}
              initialThreshold={restoredSlice?.threshold}
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
