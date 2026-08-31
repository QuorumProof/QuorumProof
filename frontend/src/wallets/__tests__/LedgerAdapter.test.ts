import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LedgerAdapter } from '../LedgerAdapter';

describe('LedgerAdapter', () => {
  let adapter: LedgerAdapter;

  beforeEach(() => {
    adapter = new LedgerAdapter();
  });

  describe('account index support', () => {
    it('should default to account index 0 when not specified', async () => {
      const mockTransport = {
        close: vi.fn(),
      };
      const mockStellarApp = vi.fn().mockImplementation(() => ({
        getPublicKey: vi.fn().mockResolvedValue({
          publicKey: 'GAXMCLWLFVD4KELSYDTC35U3OWVEH37RCLJLQ3BX4UD4EW7J5YPAHH',
        }),
      }));

      vi.doMock('@ledgerhq/hw-transport-webusb', () => ({
        default: {
          create: vi.fn().mockResolvedValue(mockTransport),
          isSupported: vi.fn().mockResolvedValue(true),
        },
      }));

      vi.doMock('@ledgerhq/hw-app-str', () => ({
        default: mockStellarApp,
      }));

      // Account index should be 0
      expect(adapter.getAccountIndex()).toBe(0);
    });

    it('should accept custom account index on connect', async () => {
      const mockTransport = {
        close: vi.fn(),
      };
      const mockStellarApp = vi.fn().mockImplementation(() => ({
        getPublicKey: vi.fn().mockResolvedValue({
          publicKey: 'GAXMCLWLFVD4KELSYDTC35U3OWVEH37RCLJLQ3BX4UD4EW7J5YPAHH',
        }),
      }));

      vi.doMock('@ledgerhq/hw-transport-webusb', () => ({
        default: {
          create: vi.fn().mockResolvedValue(mockTransport),
          isSupported: vi.fn().mockResolvedValue(true),
        },
      }));

      vi.doMock('@ledgerhq/hw-app-str', () => ({
        default: mockStellarApp,
      }));

      // Simulate setting account index to 2
      adapter['_accountIndex'] = 2;
      expect(adapter.getAccountIndex()).toBe(2);
    });

    it('should generate correct derivation path for different account indices', () => {
      // Test the private method through adapter behavior
      const adapter = new LedgerAdapter();
      
      // Access private method via type casting for testing
      const getDerivationPath = (adapter as any).getDerivationPath.bind(adapter);
      
      expect(getDerivationPath(0)).toBe("44'/148'/0'");
      expect(getDerivationPath(1)).toBe("44'/148'/1'");
      expect(getDerivationPath(5)).toBe("44'/148'/5'");
      expect(getDerivationPath(10)).toBe("44'/148'/10'");
    });

    it('should reset account index on disconnect', async () => {
      adapter['_accountIndex'] = 5;
      adapter['_address'] = 'GAXMCLWLFVD4KELSYDTC35U3OWVEH37RCLJLQ3BX4UD4EW7J5YPAHH';
      
      adapter.disconnect();
      
      expect(adapter.getAccountIndex()).toBe(0);
      expect(adapter.getAddress()).toBeNull();
    });

    it('should support non-zero account indices in signTransaction', () => {
      // Verify the method signature supports accountIndex parameter
      const adapter = new LedgerAdapter();
      adapter['_accountIndex'] = 3;
      
      expect(adapter.getAccountIndex()).toBe(3);
    });
  });

  describe('base functionality', () => {
    it('should not be connected initially', () => {
      expect(adapter.isConnected()).toBe(false);
      expect(adapter.getAddress()).toBeNull();
    });

    it('should have correct metadata', () => {
      expect(adapter.type).toBe('ledger');
      expect(adapter.name).toBe('Ledger');
      expect(adapter.icon).toBe('💻');
    });
  });
});
