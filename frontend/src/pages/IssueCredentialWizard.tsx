import { Navbar } from '../components/Navbar';
import { WalletGuard } from '../components/WalletGate';
import { CredentialWizard } from '../components/CredentialWizard';
import type { WizardSeed } from '../components/CredentialWizard';
import { useWallet } from '../hooks';
import { useLocation } from 'react-router-dom';

export default function IssueCredentialWizard() {
  const { address } = useWallet();
  const location = useLocation();
  const seed = (location.state as { seed?: WizardSeed } | null)?.seed;

  return (
    <div id="app">
      <Navbar />
      <main className="dashboard-main">
        <div className="container" style={{ maxWidth: 720 }}>
          <div className="dashboard-header" style={{ marginBottom: 32 }}>
            <div>
              <h1 className="dashboard-title">Issue Credential</h1>
              <p className="dashboard-subtitle">
                Multi-step wizard to create a verifiable on-chain credential with a quorum slice.
              </p>
            </div>
          </div>
          <div className="search-card">
            <CredentialWizard issuerAddress={address!} seed={seed} />
          </div>
        </div>
      </main>
    </div>
  );
}

export function IssueCredentialWizardPage() {
  return (
    <WalletGuard>
      <IssueCredentialWizard />
    </WalletGuard>
  );
}
