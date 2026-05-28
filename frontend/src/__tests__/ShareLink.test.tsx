/**
 * ShareLink.test.tsx
 * Tests for expiring share link generation and expiry — issue #share-links
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ShareCredentialDialog } from '../components/ShareCredentialDialog';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VALID_SUBJECT = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNN';
const CRED_ID = '7';

// 16-byte token returned by the contract
const MOCK_TOKEN = new Uint8Array(16).fill(0xab);
const MOCK_TOKEN_HEX = Array.from(MOCK_TOKEN).map(b => b.toString(16).padStart(2, '0')).join('');

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../stellar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stellar')>();
  return {
    ...actual,
    generateShareLink: vi.fn(),
    bytesToHex: actual.bytesToHex ?? ((arr: Uint8Array) =>
      Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('')
    ),
    hexToUint8Array: actual.hexToUint8Array ?? ((hex: string) => {
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
      return bytes;
    }),
  };
});

import { generateShareLink } from '../stellar';

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderDialog(subjectAddress?: string) {
  return render(
    <ShareCredentialDialog
      credentialId={CRED_ID}
      subjectAddress={subjectAddress}
      onClose={vi.fn()}
    />
  );
}

// ── Unit: bytesToHex / hexToUint8Array round-trip ─────────────────────────────

describe('bytesToHex / hexToUint8Array round-trip', () => {
  it('converts bytes to hex and back', async () => {
    const { bytesToHex, hexToUint8Array } = await import('../stellar');
    const original = new Uint8Array([0x00, 0xab, 0xff, 0x10]);
    const hex = bytesToHex(original);
    expect(hex).toBe('00abff10');
    const back = hexToUint8Array(hex);
    expect(Array.from(back)).toEqual(Array.from(original));
  });

  it('produces a 32-char hex string for a 16-byte token', async () => {
    const { bytesToHex } = await import('../stellar');
    const token = new Uint8Array(16).fill(0xcd);
    expect(bytesToHex(token)).toHaveLength(32);
  });
});

// ── Rendering ─────────────────────────────────────────────────────────────────

describe('ShareCredentialDialog — expiring link section', () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    vi.mocked(generateShareLink).mockResolvedValue(MOCK_TOKEN);
  });

  afterEach(() => vi.clearAllMocks());

  it('renders the expiry duration selector', () => {
    renderDialog(VALID_SUBJECT);
    expect(screen.getByLabelText('Link expiry duration')).toBeInTheDocument();
  });

  it('renders the Generate link button', () => {
    renderDialog(VALID_SUBJECT);
    expect(screen.getByLabelText('Generate expiring share link')).toBeInTheDocument();
  });

  it('shows an error when no wallet is connected', async () => {
    renderDialog(/* no subjectAddress */);
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Generate expiring share link'));
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/connect your wallet/i);
    expect(generateShareLink).not.toHaveBeenCalled();
  });
});

// ── Generate link flow ────────────────────────────────────────────────────────

describe('ShareCredentialDialog — generate link flow', () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    vi.mocked(generateShareLink).mockResolvedValue(MOCK_TOKEN);
  });

  afterEach(() => vi.clearAllMocks());

  it('calls generateShareLink with correct args on click', async () => {
    renderDialog(VALID_SUBJECT);
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Generate expiring share link'));
    });
    expect(generateShareLink).toHaveBeenCalledWith(VALID_SUBJECT, CRED_ID, 24);
  });

  it('displays the generated link containing the token hex', async () => {
    renderDialog(VALID_SUBJECT);
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Generate expiring share link'));
    });
    await waitFor(() => {
      expect(screen.getByTitle(expect.stringContaining(MOCK_TOKEN_HEX))).toBeInTheDocument();
    });
  });

  it('generated link contains ?token= param', async () => {
    renderDialog(VALID_SUBJECT);
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Generate expiring share link'));
    });
    await waitFor(() => {
      expect(screen.getByTitle(expect.stringContaining('?token='))).toBeInTheDocument();
    });
  });

  it('copies the generated link to clipboard', async () => {
    renderDialog(VALID_SUBJECT);
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Generate expiring share link'));
    });
    await waitFor(() => screen.getByLabelText('Copy expiring share link'));
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Copy expiring share link'));
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining(MOCK_TOKEN_HEX)
    );
  });

  it('uses the selected expiry duration', async () => {
    renderDialog(VALID_SUBJECT);
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Link expiry duration'), { target: { value: '1' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Generate expiring share link'));
    });
    expect(generateShareLink).toHaveBeenCalledWith(VALID_SUBJECT, CRED_ID, 1);
  });

  it('shows an error when generateShareLink rejects', async () => {
    vi.mocked(generateShareLink).mockRejectedValue(new Error('Token generation failed'));
    renderDialog(VALID_SUBJECT);
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Generate expiring share link'));
    });
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Token generation failed/i);
    });
  });

  it('clears the previous link when expiry changes', async () => {
    renderDialog(VALID_SUBJECT);
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Generate expiring share link'));
    });
    await waitFor(() => screen.getByLabelText('Copy expiring share link'));

    // Change expiry — link should disappear
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Link expiry duration'), { target: { value: '72' } });
    });
    expect(screen.queryByLabelText('Copy expiring share link')).not.toBeInTheDocument();
  });
});

// ── Verify page: token param handling ────────────────────────────────────────

describe('parseIdFromUrl — token param is not an id param', () => {
  it('returns null when only ?token= is present (no ?id=)', async () => {
    const { parseIdFromUrl } = await import('../pages/Verify');
    expect(parseIdFromUrl('https://app.example.com/verify?token=abcd1234')).toBeNull();
  });
});
