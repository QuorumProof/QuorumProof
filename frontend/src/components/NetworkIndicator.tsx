import { useNetwork } from '../context/NetworkContext';

export function NetworkIndicator() {
  const { config } = useNetwork();
  const labels: Record<string, string> = {
    testnet: 'Testnet',
    mainnet: 'Mainnet',
    futurenet: 'Futurenet',
    standalone: 'Standalone',
  };

  return (
    <span className={`network-badge network-badge--${config.network}`}>
      {labels[config.network] || config.network}
    </span>
  );
}
