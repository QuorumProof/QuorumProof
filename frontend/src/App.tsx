import { NetworkIndicator } from './components/NetworkIndicator';
import { WalletConnector } from './components/WalletConnector';

function App() {
  return (
    <>
      <header className="app-header">
        <span className="app-logo">⬡ QuorumProof</span>
        <NetworkIndicator />
        <WalletConnector />
      </header>
      <main>{/* future route content */}</main>
    </>
  );
}

export default App;
