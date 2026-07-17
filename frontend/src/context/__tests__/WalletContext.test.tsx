import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WalletProvider, useWallet } from '../WalletContext';

jest.mock('@stellar/freighter-api', () => ({
  isConnected: jest.fn().mockResolvedValue({ isConnected: true }),
  isAllowed: jest.fn().mockResolvedValue({ isAllowed: true }),
  getAddress: jest.fn().mockResolvedValue({ address: 'GTEST123' }),
  setAllowed: jest.fn().mockResolvedValue(undefined),
}));

const TestComponent = () => {
  const { address, isConnected, error, disconnect } = useWallet();
  return (
    <div>
      <div data-testid="address">{address || 'Not connected'}</div>
      <div data-testid="is-connected">{isConnected ? 'Connected' : 'Disconnected'}</div>
      <div data-testid="error">{error || 'No error'}</div>
      <button onClick={disconnect}>Disconnect</button>
    </div>
  );
};

describe('WalletContext', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  it('should detect wallet and show address', async () => {
    render(
      <WalletProvider>
        <TestComponent />
      </WalletProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('address')).toHaveTextContent('GTEST123');
    });
  });

  it('should disconnect and clear error state', async () => {
    render(
      <WalletProvider>
        <TestComponent />
      </WalletProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('address')).toHaveTextContent('GTEST123');
    });

    const disconnectBtn = screen.getByText('Disconnect');
    await userEvent.click(disconnectBtn);

    await waitFor(() => {
      expect(screen.getByTestId('is-connected')).toHaveTextContent('Disconnected');
      expect(screen.getByTestId('error')).toHaveTextContent('No error');
    });
  });

  it('should surface connection errors', async () => {
    jest.isolateModules(() => {
      jest.mock('@stellar/freighter-api', () => ({
        isConnected: jest.fn().mockRejectedValue(new Error('Connection failed')),
      }));
    });

    render(
      <WalletProvider>
        <TestComponent />
      </WalletProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('error')).toHaveTextContent('Connection failed');
    });
  });
});
