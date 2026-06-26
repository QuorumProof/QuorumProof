import React, { useState, useRef, useEffect } from "react";

interface AppLayoutProps {
  currentPath: string;
  walletAddress?: string;
  wallets?: string[];
  activeIndex?: number;
  onConnectWallet?: () => void;
  onSwitchWallet?: (index: number) => void;
  network?: string;
  children: React.ReactNode;
}

function truncateAddress(addr: string): string {
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

export function AppLayout({
  currentPath,
  walletAddress,
  wallets = [],
  activeIndex = 0,
  onConnectWallet,
  onSwitchWallet,
  network = "Testnet",
  children
}: AppLayoutProps) {
  const isActive = (href: string) => currentPath === href;
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
    <div className="flex flex-col h-screen bg-slate-900 text-slate-100">
      <header className="flex items-center justify-between h-14 px-4 border-b border-slate-700 bg-slate-800">
        <div className="text-base font-bold tracking-tight text-white">
          ⬡ QuorumProof
        </div>

        <nav className="hidden md:flex space-x-4">
          <a href="/dashboard" className={`px-3 py-2 rounded ${isActive('/dashboard') ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}>
            Dashboard
          </a>
          <a href="/verify" className={`px-3 py-2 rounded ${isActive('/verify') ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}>
            Verify
          </a>
          <a href="/verifier" className={`px-3 py-2 rounded ${isActive('/verifier') ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}>
            Verifier
          </a>
          <a href="/verifier/dashboard" className={`px-3 py-2 rounded ${isActive('/verifier/dashboard') ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}>
            Verification
          </a>
          <a href="/issuer" className={`px-3 py-2 rounded ${isActive('/issuer') ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}>
            Issuer
          </a>
          <a href="/search" className={`px-3 py-2 rounded ${isActive('/search') ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}>
            Search
          </a>
          <a href="/slice/new" className={`px-3 py-2 rounded ${isActive('/slice/new') ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}>
            New Slice
          </a>
          <a href="/profile" className={`px-3 py-2 rounded ${isActive('/profile') ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}>
            Profile
          </a>
          <a href="/compare" className={`px-3 py-2 rounded ${isActive('/compare') ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}>
            Compare
          </a>
        </nav>

        <div className="flex items-center space-x-4">
          <span className="text-sm text-slate-400">{network}</span>
          {walletAddress ? (
            <div style={{ position: 'relative' }} ref={menuRef}>
              <button
                onClick={() => setShowWalletMenu(prev => !prev)}
                className="text-sm font-mono text-slate-300 hover:text-white flex items-center gap-1"
              >
                {truncateAddress(walletAddress)}
                {wallets.length > 1 && <span style={{ fontSize: 10 }}>▼</span>}
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
                        fontFamily: 'monospace',
                        textAlign: 'left',
                        background: i === activeIndex ? '#334155' : 'transparent',
                        color: '#e2e8f0',
                        border: 'none',
                        cursor: 'pointer',
                      }}
                      onClick={() => { onSwitchWallet?.(i); setShowWalletMenu(false); }}
                      onMouseEnter={(e) => { if (i !== activeIndex) e.currentTarget.style.background = '#2d3748'; }}
                      onMouseLeave={(e) => { if (i !== activeIndex) e.currentTarget.style.background = 'transparent'; }}
                    >
                      {truncateAddress(w)} {i === activeIndex ? ' ✓' : ''}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <button
              onClick={onConnectWallet}
              className="px-3 py-1 bg-indigo-600 text-white rounded hover:bg-indigo-700"
            >
              Connect Wallet
            </button>
          )}
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-4">
        {children}
      </main>
    </div>
  );
}
