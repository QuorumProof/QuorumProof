import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import * as WalletGateModule from '../WalletGate';
import * as WalletGuardModule from '../WalletGuard';
import { WalletGuard } from '../WalletGuard';
import { WalletGate } from '../WalletGate';
import { useWallet } from '../../hooks';
import type { WalletState } from '../../context/WalletContextValue';

vi.mock('../../hooks', () => ({
  useWallet: vi.fn(),
}));

describe('WalletGuard and WalletGate Consolidation (#1444)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Single Source of Truth Export Assertion', () => {
    it('asserts only WalletGuard module exports WalletGuard, not WalletGate module', () => {
      // WalletGuardModule must export WalletGuard
      expect(WalletGuardModule).toHaveProperty('WalletGuard');
      expect(typeof (WalletGuardModule as any).WalletGuard).toBe('function');

      // WalletGateModule must NOT export WalletGuard (duplicate removed)
      expect(WalletGateModule).not.toHaveProperty('WalletGuard');

      // WalletGateModule must export WalletGate
      expect(WalletGateModule).toHaveProperty('WalletGate');
      expect(typeof (WalletGateModule as any).WalletGate).toBe('function');
    });
  });

  describe('WalletGuard Component Rendering & Accessibility', () => {
    it('renders loading state when initializing', () => {
      vi.mocked(useWallet).mockReturnValue({
        address: null,
        isInitializing: true,
        availableWallets: [],
        connect: vi.fn(),
        hasFreighter: false,
        disconnect: vi.fn(),
      } as unknown as WalletState);

      render(
        <WalletGuard>
          <div>Protected Content</div>
        </WalletGuard>
      );

      expect(screen.getByText('Checking wallet…')).toBeInTheDocument();
      expect(screen.queryByText('Protected Content')).not.toBeInTheDocument();
    });

    it('renders accessible region with role="region" and aria-label when no wallets are available', () => {
      vi.mocked(useWallet).mockReturnValue({
        address: null,
        isInitializing: false,
        availableWallets: [],
        connect: vi.fn(),
        hasFreighter: false,
        disconnect: vi.fn(),
      } as unknown as WalletState);

      render(
        <WalletGuard>
          <div>Protected Content</div>
        </WalletGuard>
      );

      const region = screen.getByRole('region', { name: 'Wallet connection required' });
      expect(region).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 2, name: 'Wallet Required' })).toBeInTheDocument();
      expect(
        screen.getByText(/No wallet detected\. Install Freighter or connect a Ledger\/Trezor hardware wallet\./)
      ).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Install Freighter' })).toHaveAttribute(
        'href',
        'https://freighter.app'
      );
      expect(screen.queryByText('Protected Content')).not.toBeInTheDocument();
    });

    it('renders accessible region and connect options when wallets are detected but user is not connected', () => {
      const mockConnect = vi.fn();
      vi.mocked(useWallet).mockReturnValue({
        address: null,
        isInitializing: false,
        availableWallets: ['freighter'],
        connect: mockConnect,
        hasFreighter: true,
        disconnect: vi.fn(),
      } as unknown as WalletState);

      render(
        <WalletGuard>
          <div>Protected Content</div>
        </WalletGuard>
      );

      const region = screen.getByRole('region', { name: 'Wallet connection required' });
      expect(region).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { level: 2, name: 'Connect your Stellar wallet to continue' })
      ).toBeInTheDocument();
      expect(screen.getByText('Select a wallet to connect:')).toBeInTheDocument();

      const freighterBtn = screen.getByRole('button', { name: /Freighter/i });
      expect(freighterBtn).toBeInTheDocument();

      fireEvent.click(freighterBtn);
      expect(mockConnect).toHaveBeenCalledWith('freighter');
      expect(screen.queryByText('Protected Content')).not.toBeInTheDocument();
    });

    it('renders children without wallet guard card when address is connected', () => {
      vi.mocked(useWallet).mockReturnValue({
        address: 'GBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFSNQB37HNU7F5V4Z5SHEOSVBQ',
        isInitializing: false,
        availableWallets: ['freighter'],
        connect: vi.fn(),
        hasFreighter: true,
        disconnect: vi.fn(),
      } as unknown as WalletState);

      render(
        <WalletGuard>
          <div data-testid="protected-content">Protected Content</div>
        </WalletGuard>
      );

      expect(screen.getByTestId('protected-content')).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Wallet connection required' })).not.toBeInTheDocument();
    });
  });

  describe('WalletGate Component Rendering & Accessibility', () => {
    it('renders accessible landmark with role="region" and aria-label', () => {
      const mockConnect = vi.fn();
      render(
        <WalletGate
          connect={mockConnect}
          availableWallets={['freighter']}
        />
      );

      const region = screen.getByRole('region', { name: 'Wallet connection required' });
      expect(region).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { level: 2, name: 'Connect your Stellar wallet to continue' })
      ).toBeInTheDocument();

      const freighterBtn = screen.getByRole('button', { name: /Freighter/i });
      fireEvent.click(freighterBtn);
      expect(mockConnect).toHaveBeenCalledWith('freighter');
    });

    it('renders install prompt when availableWallets is empty', () => {
      render(
        <WalletGate
          connect={vi.fn()}
          availableWallets={[]}
        />
      );

      const region = screen.getByRole('region', { name: 'Wallet connection required' });
      expect(region).toBeInTheDocument();
      expect(
        screen.getByText(/No wallet detected\. Install Freighter or connect a Ledger\/Trezor hardware wallet\./)
      ).toBeInTheDocument();
    });
  });
});
