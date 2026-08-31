import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TrezorAdapter } from '../TrezorAdapter';

describe('TrezorAdapter', () => {
  let adapter: TrezorAdapter;

  beforeEach(() => {
    adapter = new TrezorAdapter();
  });

  describe('account index support', () => {
    it('should default to account index 0 when not specified', () => {
      expect(adapter.getAccountIndex()).toBe(0);
    });

    it('should accept custom account index on connect', async () => {
      adapter['_accountIndex'] = 3;
      expect(adapter.getAccountIndex()).toBe(3);
    });

    it('should generate correct derivation path for different account indices', () => {
      const getDerivationPath = (adapter as any).getDerivationPath.bind(adapter);
      
      expect(getDerivationPath(0)).toBe("m/44'/148'/0'");
      expect(getDerivationPath(1)).toBe("m/44'/148'/1'");
      expect(getDerivationPath(5)).toBe("m/44'/148'/5'");
      expect(getDerivationPath(10)).toBe("m/44'/148'/10'");
    });

    it('should reset account index on disconnect', async () => {
      adapter['_accountIndex'] = 5;
      adapter['_address'] = 'GAXMCLWLFVD4KELSYDTC35U3OWVEH37RCLJLQ3BX4UD4EW7J5YPAHH';
      
      adapter.disconnect();
      
      expect(adapter.getAccountIndex()).toBe(0);
      expect(adapter.getAddress()).toBeNull();
    });

    it('should support non-zero account indices in signTransaction', () => {
      adapter['_accountIndex'] = 2;
      expect(adapter.getAccountIndex()).toBe(2);
    });
  });

  describe('base functionality', () => {
    it('should not be connected initially', () => {
      expect(adapter.isConnected()).toBe(false);
      expect(adapter.getAddress()).toBeNull();
    });

    it('should have correct metadata', () => {
      expect(adapter.type).toBe('trezor');
      expect(adapter.name).toBe('Trezor');
      expect(adapter.icon).toBe('🔒');
    });
  });
});
