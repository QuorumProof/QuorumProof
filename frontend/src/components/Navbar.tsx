import { Link, useLocation } from 'react-router-dom';
import { NotificationCenter } from './NotificationCenter';
import { WalletConnectButton } from './WalletConnectButton';
import { useWallet } from '../hooks';
import { formatNetworkLabel } from '../lib/wallet/display';

export function Navbar() {
  const location = useLocation();
  const { network, error } = useWallet();

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
            to="/slice/new"
            className={`nav-link${location.pathname.startsWith('/slice') ? ' active' : ''}`}
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
          <span className="navbar__badge navbar__badge--network">{formatNetworkLabel(network)}</span>
          <NotificationCenter />
          <WalletConnectButton />
        </div>
      </div>
      {error ? (
        <div className="navbar__error" role="alert">
          {error}
        </div>
      ) : null}
    </nav>
  );
}
