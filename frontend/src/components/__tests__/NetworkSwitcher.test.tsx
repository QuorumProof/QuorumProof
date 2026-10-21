import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NetworkSwitcher } from '../NetworkSwitcher';
import { NetworkProvider } from '../../context/NetworkContext';
import { getNetwork, setNetwork } from '../../lib/networkConfig';
import { getRpcClient } from '../../lib/rpcClient';

describe('NetworkSwitcher', () => {
  beforeEach(() => {
    localStorage.clear();
    setNetwork('testnet');
  });

  it('switches to a selected network and replaces the cached RPC client', async () => {
    render(
      <NetworkProvider>
        <NetworkSwitcher />
      </NetworkProvider>,
    );
    const previousRpcClient = getRpcClient();

    fireEvent.click(screen.getByRole('button', { name: /Testnet/ }));
    fireEvent.click(screen.getByRole('button', { name: /Futurenet/ }));

    await waitFor(() => expect(screen.getByRole('button', { name: /Futurenet/ })).toBeInTheDocument());
    expect(getNetwork()).toBe('futurenet');
    expect(localStorage.getItem('quorum-proof-network')).toBe('futurenet');
    expect(getRpcClient()).not.toBe(previousRpcClient);
  });

  it('requires confirmation before switching to mainnet', () => {
    render(
      <NetworkProvider>
        <NetworkSwitcher />
      </NetworkProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Testnet/ }));
    fireEvent.click(screen.getByRole('button', { name: /Mainnet/ }));

    expect(screen.getByText(/Switch to Mainnet\?/)).toBeInTheDocument();
    expect(getNetwork()).toBe('testnet');

    fireEvent.click(screen.getByRole('button', { name: 'Switch to Mainnet' }));

    expect(getNetwork()).toBe('mainnet');
  });
});
