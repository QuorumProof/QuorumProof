import { useState, useRef, useEffect } from 'react';
import { useNetwork } from '../context/NetworkContext';
import { type StellarNetwork, NETWORK_CONFIGS } from '../lib/networkConfig';

export function NetworkSwitcher() {
  const { config, setNetwork, availableNetworks } = useNetwork();
  const [showMenu, setShowMenu] = useState(false);
  const [showWarning, setShowWarning] = useState<StellarNetwork | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function handleSelect(network: StellarNetwork) {
    setShowMenu(false);
    if (network === config.network) return;
    if (network === 'mainnet') {
      setShowWarning(network);
    } else if (config.network === 'mainnet') {
      setShowWarning(network);
    } else {
      setNetwork(network);
    }
  }

  function confirmSwitch() {
    if (showWarning) {
      setNetwork(showWarning);
      setShowWarning(null);
    }
  }

  const colors: Record<string, string> = {
    testnet: '#f59e0b',
    mainnet: '#22c55e',
    futurenet: '#a855f7',
    standalone: '#64748b',
  };

  return (
    <>
      <div style={{ position: 'relative' }} ref={menuRef}>
        <button
          onClick={() => setShowMenu(prev => !prev)}
          className="btn btn--ghost"
          style={{
            padding: '4px 10px',
            fontSize: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            backgroundColor: colors[config.network] || '#64748b',
            display: 'inline-block',
          }} />
          {config.name}
          <span style={{ fontSize: 10, opacity: 0.6 }}>▼</span>
        </button>
        {showMenu && (
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
              minWidth: 160,
              zIndex: 50,
              boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            }}
          >
            {availableNetworks.map(net => {
              const cfg = NETWORK_CONFIGS[net];
              return (
                <button
                  key={net}
                  style={{
                    display: 'block',
                    width: '100%',
                    padding: '8px 12px',
                    fontSize: 12,
                    textAlign: 'left',
                    background: net === config.network ? '#334155' : 'transparent',
                    color: '#e2e8f0',
                    border: 'none',
                    cursor: 'pointer',
                  }}
                  onClick={() => handleSelect(net)}
                  onMouseEnter={(e) => { if (net !== config.network) e.currentTarget.style.background = '#2d3748'; }}
                  onMouseLeave={(e) => { if (net !== config.network) e.currentTarget.style.background = 'transparent'; }}
                >
                  <span style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    backgroundColor: colors[net] || '#64748b',
                    display: 'inline-block',
                    marginRight: 8,
                  }} />
                  {cfg.name}
                  {net === config.network ? ' ✓' : ''}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {showWarning && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
          }}
          onClick={() => setShowWarning(null)}
        >
          <div
            style={{
              background: '#1e293b',
              border: '1px solid #334155',
              borderRadius: 12,
              padding: 24,
              maxWidth: 420,
              width: '90%',
              boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: '0 0 8px', fontSize: 18, color: '#f1f5f9' }}>
              {showWarning === 'mainnet'
                ? '⚠️ Switch to Mainnet?'
                : '🔒 Switch to Testnet?'}
            </h3>
            <p style={{ margin: '0 0 16px', fontSize: 14, color: '#94a3b8', lineHeight: 1.5 }}>
              {showWarning === 'mainnet'
                ? 'You are about to switch to the Stellar Mainnet. This network uses real XLM assets. Please ensure you understand the risks before proceeding.'
                : 'You are about to switch from Mainnet to Testnet. This network uses test XLM with no real value. You will need to switch your Freighter wallet to the Testnet as well.'}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                className="btn btn--ghost"
                onClick={() => setShowWarning(null)}
              >
                Cancel
              </button>
              <button
                className="btn btn--primary"
                onClick={confirmSwitch}
                style={{ background: showWarning === 'mainnet' ? '#ef4444' : undefined }}
              >
                {showWarning === 'mainnet' ? 'Switch to Mainnet' : 'Switch to Testnet'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
