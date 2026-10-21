import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import IssueCredentialWizardPage from '../IssueCredentialWizard';
import { useWallet } from '../../hooks';
import type { WalletState } from '../../context/WalletContextValue';
import type { WizardSeed } from '../../components/CredentialWizard';

vi.mock('../../hooks', () => ({
  useWallet: vi.fn(),
}));

vi.mock('../../components/Navbar', () => ({
  Navbar: () => <div>Navbar</div>,
}));

vi.mock('../../components/CredentialWizard', () => ({
  CredentialWizard: ({ issuerAddress, seed }: { issuerAddress: string; seed?: WizardSeed }) => (
    <div
      data-testid="credential-wizard"
      data-issuer-address={issuerAddress}
      data-seed={JSON.stringify(seed)}
    />
  ),
}));

const ADDRESS = 'GBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFSNQB37HNU7F5V4Z5SHEOSVBQ';

function createWalletState(address: string | null): WalletState {
  return {
    address,
    wallets: address ? [address] : [],
    walletType: address ? 'freighter' : null,
    accountIndex: 0,
    activeIndex: 0,
    isConnected: Boolean(address),
    hasFreighter: Boolean(address),
    isInitializing: false,
    network: 'testnet',
    error: null,
    availableWallets: address ? ['freighter'] : [],
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    switchWallet: vi.fn(),
    setAccountIndexForWallet: vi.fn(),
  };
}

describe('IssueCredentialWizard page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useWallet).mockReturnValue(createWalletState(ADDRESS));
  });

  it('passes the issuer and route seed to the credential wizard', () => {
    const seed: WizardSeed = {
      credentialType: 2,
      subject: 'G'.padEnd(56, 'A'),
      metadataHash: 'QmSeed123',
      attestors: [],
      threshold: 1,
    };

    render(
      <MemoryRouter initialEntries={[{ pathname: '/issue', state: { seed } }]}>
        <IssueCredentialWizardPage />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('credential-wizard')).toHaveAttribute('data-issuer-address', ADDRESS);
    expect(screen.getByTestId('credential-wizard')).toHaveAttribute('data-seed', JSON.stringify(seed));
  });

  it('shows the wallet-required state when disconnected', () => {
    vi.mocked(useWallet).mockReturnValue(createWalletState(null));

    render(
      <MemoryRouter>
        <IssueCredentialWizardPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'Wallet Required' })).toBeInTheDocument();
    expect(screen.queryByTestId('credential-wizard')).not.toBeInTheDocument();
  });
});
