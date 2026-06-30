import { Navbar } from '../components/Navbar';
import { CredentialVerificationDashboard } from '../components/CredentialVerificationDashboard';

export default function VerificationDashboard() {
  return (
    <>
      <Navbar />
      <main className="container" style={{ paddingTop: 20, paddingBottom: 64 }}>
        <CredentialVerificationDashboard />
      </main>
      <footer className="footer">
        <div className="container">
          Powered by{' '}
          <a href="https://stellar.org" target="_blank" rel="noopener">Stellar Soroban</a>
          {' · '}
          <a href="https://github.com/Phantomcall/QuorumProof" target="_blank" rel="noopener">QuorumProof</a>
        </div>
      </footer>
    </>
  );
}
