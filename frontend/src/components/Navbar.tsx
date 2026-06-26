import { useState, useRef, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useFreighter } from '../lib/hooks/useFreighter';
import { NotificationCenter } from './NotificationCenter';

const NETWORK = import.meta.env.VITE_STELLAR_NETWORK || 'testnet';

function formatAddress(addr: string) {
  if (!addr || addr.length < 10) return addr;
  return addr.slice(0, 8) + '…' + addr.slice(-6);
}

export function Navbar() {
  const location = useLocation();
  const { address, isInitializing, connect, disconnect, wallets, activeIndex, switchWallet } = useFreighter();
  const [showWalletMenu, setShowWalletMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowWalletMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <nav className="navbar">
      <div className="container navbar__inner">
        <Link to="/dashboard" className="navbar__logo">
          <div className="navbar__logo-icon">⬡</div>
          QuorumProof
        </Link>

        <div className="navbar__links">
          <Link
            to="/dashboard"
            className={`nav-link${location.pathname === '/dashboard' ? ' active' : ''}`}
          >
            Dashboard
          </Link>
          <Link
            to="/verify"
            className={`nav-link${location.pathname === '/verify' ? ' active' : ''}`}
          >
            Verify
          </Link>
          <Link
            to="/slice"
            className={`nav-link${location.pathname === '/slice' ? ' active' : ''}`}
          >
            Slice Builder
          </Link>
          <Link
            to="/help"
            className={`nav-link${location.pathname === '/help' ? ' active' : ''}`}
          >
            Help
          </Link>
        </div>

        <div className="navbar__right">
          <span className="navbar__badge">{NETWORK}</span>
          <NotificationCenter />
          {isInitializing ? (
            <span className="navbar__badge" style={{ opacity: 0.5 }}>Connecting…</span>
          ) : address ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }} ref={menuRef}>
              <div style={{ position: 'relative' }}>
                <button
                  className="navbar__badge"
                  title={address}
                  style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', cursor: 'pointer' }}
                  onClick={() => setShowWalletMenu(prev => !prev)}
                >
                  {formatAddress(address)}
                  {wallets.length > 1 && (
                    <span style={{ marginLeft: 4, fontSize: 10 }}>▼</span>
                  )}
                </button>
                {showWalletMenu && wallets.length > 0 && (
                  <div
                    style={{
                      position: 'absolute',
                      top: '100%',
                      right: 0,
                      marginTop: 4,
                      background: '#1e293b',
                      border: '1px solid #334155',
                      borderRadius: 8,
                      padding: '4px 0',
                      minWidth: 200,
                      zIndex: 50,
                      boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                    }}
                  >
                    {wallets.map((w, i) => (
                      <button
                        key={w}
                        style={{
                          display: 'block',
                          width: '100%',
                          padding: '8px 12px',
                          fontSize: 12,
                          fontFamily: 'var(--font-mono)',
                          textAlign: 'left',
                          background: i === activeIndex ? '#334155' : 'transparent',
                          color: '#e2e8f0',
                          border: 'none',
                          cursor: 'pointer',
                        }}
                        onClick={() => { switchWallet(i); setShowWalletMenu(false); }}
                        onMouseEnter={(e) => { if (i !== activeIndex) e.currentTarget.style.background = '#2d3748'; }}
                        onMouseLeave={(e) => { if (i !== activeIndex) e.currentTarget.style.background = 'transparent'; }}
                      >
                        {formatAddress(w)} {i === activeIndex ? ' ✓' : ''}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button className="btn btn--ghost" style={{ padding: '4px 10px', fontSize: '12px' }} onClick={() => { disconnect(); setShowWalletMenu(false); }}>
                Disconnect
              </button>
            </div>
          ) : (
            <button className="btn btn--primary" style={{ padding: '6px 14px', fontSize: '13px' }} onClick={connect}>
              Connect Wallet
            </button>
          )}
        </div>
      </div>
    </nav>
  );
}
