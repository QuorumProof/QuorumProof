/**
 * Tests for Issue #1446 — account-index support in Ledger/Trezor adapters.
 *
 * We mock the heavy hardware-wallet SDK imports so these run in jsdom without
 * any actual USB device.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Ledger transport / app mocks ──────────────────────────────────────────────

const mockStellarGetPublicKey = vi.fn();
const mockStellarSignTransaction = vi.fn();

// MockStellarApp must be a class / constructor that vitest can `new`
class MockStellarApp {
  constructor(_transport: unknown) {}
  getPublicKey = mockStellarGetPublicKey;
  signTransaction = mockStellarSignTransaction;
}

const mockTransportCreate = vi.fn();
const mockTransportClose = vi.fn();
const MockTransportWebUSB = {
  isSupported: vi.fn().mockResolvedValue(true),
  create: vi.fn().mockResolvedValue({ close: mockTransportClose }),
};

vi.mock('@ledgerhq/hw-transport-webusb', () => ({ default: MockTransportWebUSB }));
vi.mock('@ledgerhq/hw-app-str', () => ({ default: MockStellarApp }));

// ── Trezor connect mock ───────────────────────────────────────────────────────

const mockTrezorGetPublicKey = vi.fn();
const mockTrezorSignTransaction = vi.fn();
const MockTrezorConnect = {
  init: vi.fn().mockResolvedValue(true),
  stellarGetPublicKey: mockTrezorGetPublicKey,
  stellarSignTransaction: mockTrezorSignTransaction,
};

vi.mock('@trezor/connect', () => ({ default: MockTrezorConnect }));

// ── Tests ─────────────────────────────────────────────────────────────────────

import { LedgerAdapter } from '../wallets/LedgerAdapter';
import { TrezorAdapter } from '../wallets/TrezorAdapter';

describe('LedgerAdapter — account index (#1446)', () => {
  let adapter: LedgerAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTransportClose.mockResolvedValue(undefined);
    adapter = new LedgerAdapter();
  });

  it('uses account index 0 by default on connect()', async () => {
    mockStellarGetPublicKey.mockResolvedValue({ publicKey: 'GPUBKEY0' });

    const address = await adapter.connect();

    expect(mockStellarGetPublicKey).toHaveBeenCalledWith("44'/148'/0'");
    expect(address).toBe('GPUBKEY0');
    expect(adapter.getAccountIndex()).toBe(0);
  });

  it('uses the supplied accountIndex on connect()', async () => {
    mockStellarGetPublicKey.mockResolvedValue({ publicKey: 'GPUBKEY3' });

    const address = await adapter.connect(3);

    expect(mockStellarGetPublicKey).toHaveBeenCalledWith("44'/148'/3'");
    expect(address).toBe('GPUBKEY3');
    expect(adapter.getAccountIndex()).toBe(3);
  });

  it('uses account index 0 by default on signTransaction()', async () => {
    mockStellarSignTransaction.mockResolvedValue({ signature: Buffer.from('sig0') });
    // Connect first so _accountIndex is set
    mockStellarGetPublicKey.mockResolvedValue({ publicKey: 'GPUBKEY0' });
    await adapter.connect(0);

    await adapter.signTransaction('dGVzdA==');

    expect(mockStellarSignTransaction).toHaveBeenCalledWith("44'/148'/0'", expect.any(Buffer));
  });

  it('uses a non-zero accountIndex on signTransaction()', async () => {
    mockStellarGetPublicKey.mockResolvedValue({ publicKey: 'GPUBKEY5' });
    mockStellarSignTransaction.mockResolvedValue({ signature: Buffer.from('sig5') });
    await adapter.connect(5);

    await adapter.signTransaction('dGVzdA==');

    expect(mockStellarSignTransaction).toHaveBeenCalledWith("44'/148'/5'", expect.any(Buffer));
  });

  it('allows overriding accountIndex at sign time', async () => {
    mockStellarGetPublicKey.mockResolvedValue({ publicKey: 'GPUBKEY0' });
    mockStellarSignTransaction.mockResolvedValue({ signature: Buffer.from('override') });
    await adapter.connect(0);

    await adapter.signTransaction('dGVzdA==', 7);

    expect(mockStellarSignTransaction).toHaveBeenCalledWith("44'/148'/7'", expect.any(Buffer));
  });

  it('resets accountIndex to 0 on disconnect()', async () => {
    mockStellarGetPublicKey.mockResolvedValue({ publicKey: 'GPUBKEY2' });
    await adapter.connect(2);
    expect(adapter.getAccountIndex()).toBe(2);

    adapter.disconnect();
    expect(adapter.getAccountIndex()).toBe(0);
    expect(adapter.getAddress()).toBeNull();
  });
});

describe('TrezorAdapter — account index (#1446)', () => {
  let adapter: TrezorAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new TrezorAdapter();
  });

  it('uses account index 0 by default on connect()', async () => {
    mockTrezorGetPublicKey.mockResolvedValue({
      success: true,
      payload: { publicKey: 'GTPUBKEY0' },
    });

    const address = await adapter.connect();

    expect(mockTrezorGetPublicKey).toHaveBeenCalledWith({ path: "m/44'/148'/0'" });
    expect(address).toBe('GTPUBKEY0');
    expect(adapter.getAccountIndex()).toBe(0);
  });

  it('uses the supplied accountIndex on connect()', async () => {
    mockTrezorGetPublicKey.mockResolvedValue({
      success: true,
      payload: { publicKey: 'GTPUBKEY4' },
    });

    const address = await adapter.connect(4);

    expect(mockTrezorGetPublicKey).toHaveBeenCalledWith({ path: "m/44'/148'/4'" });
    expect(address).toBe('GTPUBKEY4');
    expect(adapter.getAccountIndex()).toBe(4);
  });

  it('throws when Trezor returns success: false', async () => {
    mockTrezorGetPublicKey.mockResolvedValue({
      success: false,
      payload: { error: 'User cancelled' },
    });

    await expect(adapter.connect(1)).rejects.toThrow('User cancelled');
  });

  it('uses account index from connect() when signing', async () => {
    mockTrezorGetPublicKey.mockResolvedValue({
      success: true,
      payload: { publicKey: 'GTPUBKEY6' },
    });
    mockTrezorSignTransaction.mockResolvedValue({
      success: true,
      payload: { signature: 'sig6' },
    });
    await adapter.connect(6);

    await adapter.signTransaction('some-xdr');

    expect(mockTrezorSignTransaction).toHaveBeenCalledWith({
      path: "m/44'/148'/6'",
      transaction: 'some-xdr',
    });
  });

  it('allows overriding accountIndex at sign time', async () => {
    mockTrezorGetPublicKey.mockResolvedValue({
      success: true,
      payload: { publicKey: 'GTPUBKEY0' },
    });
    mockTrezorSignTransaction.mockResolvedValue({
      success: true,
      payload: { signature: 'sigoverride' },
    });
    await adapter.connect(0);

    await adapter.signTransaction('some-xdr', 9);

    expect(mockTrezorSignTransaction).toHaveBeenCalledWith({
      path: "m/44'/148'/9'",
      transaction: 'some-xdr',
    });
  });

  it('resets accountIndex to 0 on disconnect()', async () => {
    mockTrezorGetPublicKey.mockResolvedValue({
      success: true,
      payload: { publicKey: 'GTPUBKEY3' },
    });
    await adapter.connect(3);
    expect(adapter.getAccountIndex()).toBe(3);

    adapter.disconnect();
    expect(adapter.getAccountIndex()).toBe(0);
    expect(adapter.getAddress()).toBeNull();
  });
});
