import { useState } from 'react';
import { AppLayout } from './AppLayout';

/**
 * AppLayoutExample — demonstrates AppLayout wrapping a sample page.
 */
export function AppLayoutExample() {
  const [currentPath, setCurrentPath] = useState('/dashboard');

  const DEMO_WALLET = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCXYZ';

  return (
    <AppLayout>
      <div className="container container--wide dashboard-main">
        <div className="max-w-2xl space-y-6">
          <h1 className="dashboard-title">Dashboard</h1>
          <p className="dashboard-subtitle">
            Welcome to QuorumProof. Use the navigation to verify credentials,
            manage your quorum slice, or adjust settings.
          </p>

          <div className="card" style={{ padding: 16 }}>
            <p className="meta-label">Demo: switch active route</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
              {['/dashboard', '/verify', '/slice/new', '/help'].map((path) => (
                <button
                  key={path}
                  type="button"
                  onClick={() => setCurrentPath(path)}
                  className={`btn btn--sm ${currentPath === path ? 'btn--primary' : 'btn--ghost'}`}
                >
                  {path}
                </button>
              ))}
            </div>
            <p style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
              Active: <code>{currentPath}</code> · Wallet: <code>{DEMO_WALLET.slice(0, 8)}…</code>
            </p>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
