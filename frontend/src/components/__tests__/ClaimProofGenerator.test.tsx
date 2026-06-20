/**
 * ClaimProofGenerator.test.tsx
 * Tests for the privacy-preserving credential claim generator UI — issue #667
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ClaimProofGenerator } from '../ClaimProofGenerator';
import {
  CLAIM_TYPE_OPTIONS,
  findClaimTypeOption,
  encodeProofRequest,
  buildProofShareUrl,
} from '../../lib/claimDisclosure';
import { generateProofRequest } from '../../lib/contracts/zkVerifier';

vi.mock('../../lib/contracts/zkVerifier', () => ({
  generateProofRequest: vi.fn(),
}));

const CREDENTIAL_ID = 42n;

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe('findClaimTypeOption', () => {
  it('returns the matching option for a known claim type', () => {
    expect(findClaimTypeOption('HasLicense').label).toBe('License category');
  });

  it('covers degree, license and employer claim types per the issue requirements', () => {
    const labels = CLAIM_TYPE_OPTIONS.map((o) => o.label);
    expect(labels).toEqual(
      expect.arrayContaining(['Degree', 'License category', 'Employer'])
    );
  });
});

describe('encodeProofRequest', () => {
  it('serializes bigint fields as strings so the result is valid JSON', () => {
    const encoded = encodeProofRequest({
      credential_id: 42n,
      claim_type: 'HasDegree',
      nonce: 12345n,
    });
    expect(JSON.parse(encoded)).toEqual({
      credential_id: '42',
      claim_type: 'HasDegree',
      nonce: '12345',
    });
  });
});

describe('buildProofShareUrl', () => {
  it('builds a /verify URL carrying id, claimType and nonce', () => {
    const url = buildProofShareUrl({ credential_id: 7n, claim_type: 'HasLicense', nonce: 99n });
    expect(url).toContain('/verify?');
    expect(url).toContain('id=7');
    expect(url).toContain('claimType=HasLicense');
    expect(url).toContain('nonce=99');
  });
});

// ── Rendering ────────────────────────────────────────────────────────────────

describe('ClaimProofGenerator rendering', () => {
  it('renders the claim type selector with all options', () => {
    render(<ClaimProofGenerator credentialId={CREDENTIAL_ID} />);
    const select = screen.getByTestId('claim-type-select');
    expect(select).toBeInTheDocument();
    for (const opt of CLAIM_TYPE_OPTIONS) {
      expect(screen.getByText(new RegExp(opt.label))).toBeInTheDocument();
    }
  });

  it('shows a disclosure preview for the default claim type', () => {
    render(<ClaimProofGenerator credentialId={CREDENTIAL_ID} />);
    const preview = screen.getByTestId('disclosure-preview');
    expect(preview).toBeInTheDocument();
    expect(screen.getByText(/You hold a verified degree credential\./)).toBeInTheDocument();
    expect(screen.getByText('Institution name')).toBeInTheDocument();
  });

  it('updates the disclosure preview when a different claim type is selected', () => {
    render(<ClaimProofGenerator credentialId={CREDENTIAL_ID} />);
    fireEvent.change(screen.getByTestId('claim-type-select'), { target: { value: 'HasEmploymentHistory' } });
    expect(screen.getByText(/You hold a verified employment credential\./)).toBeInTheDocument();
    expect(screen.getByText('Employer name')).toBeInTheDocument();
  });

  it('references the credential ID so verifiers know what the proof applies to', () => {
    render(<ClaimProofGenerator credentialId={CREDENTIAL_ID} />);
    expect(screen.getByText(/Credential #42/)).toBeInTheDocument();
  });
});

// ── Proof generation ─────────────────────────────────────────────────────────

describe('ClaimProofGenerator proof generation', () => {
  it('calls generateProofRequest with the credential ID and selected claim type', async () => {
    (generateProofRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      credential_id: CREDENTIAL_ID,
      claim_type: 'HasDegree',
      nonce: 123n,
    });
    render(<ClaimProofGenerator credentialId={CREDENTIAL_ID} />);
    fireEvent.click(screen.getByTestId('generate-proof-btn'));
    await waitFor(() => expect(generateProofRequest).toHaveBeenCalledWith(CREDENTIAL_ID, 'HasDegree'));
  });

  it('shows the generated proof request and validity note on success', async () => {
    (generateProofRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      credential_id: CREDENTIAL_ID,
      claim_type: 'HasDegree',
      nonce: 123n,
    });
    render(<ClaimProofGenerator credentialId={CREDENTIAL_ID} />);
    fireEvent.click(screen.getByTestId('generate-proof-btn'));

    const result = await screen.findByTestId('proof-result');
    expect(result).toBeInTheDocument();
    expect(screen.getByLabelText('Generated proof request, JSON encoded')).toHaveValue(
      encodeProofRequest({ credential_id: CREDENTIAL_ID, claim_type: 'HasDegree', nonce: 123n })
    );
    expect(screen.getByText(/nonce 123/)).toBeInTheDocument();
  });

  it('shows an error message when proof generation fails', async () => {
    (generateProofRequest as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Simulation failed'));
    render(<ClaimProofGenerator credentialId={CREDENTIAL_ID} />);
    fireEvent.click(screen.getByTestId('generate-proof-btn'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Simulation failed');
  });

  it('resets prior results when the claim type changes', async () => {
    (generateProofRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      credential_id: CREDENTIAL_ID,
      claim_type: 'HasDegree',
      nonce: 123n,
    });
    render(<ClaimProofGenerator credentialId={CREDENTIAL_ID} />);
    fireEvent.click(screen.getByTestId('generate-proof-btn'));
    await screen.findByTestId('proof-result');

    fireEvent.change(screen.getByTestId('claim-type-select'), { target: { value: 'HasLicense' } });
    expect(screen.queryByTestId('proof-result')).not.toBeInTheDocument();
  });
});

// ── Clipboard copy ───────────────────────────────────────────────────────────

describe('ClaimProofGenerator clipboard copy', () => {
  async function generate() {
    (generateProofRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      credential_id: CREDENTIAL_ID,
      claim_type: 'HasDegree',
      nonce: 123n,
    });
    render(<ClaimProofGenerator credentialId={CREDENTIAL_ID} />);
    fireEvent.click(screen.getByTestId('generate-proof-btn'));
    await screen.findByTestId('proof-result');
  }

  it('copies the encoded proof request to the clipboard', async () => {
    await generate();
    fireEvent.click(screen.getByTestId('copy-proof-btn'));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        encodeProofRequest({ credential_id: CREDENTIAL_ID, claim_type: 'HasDegree', nonce: 123n })
      )
    );
    expect(await screen.findByText('✅ Copied')).toBeInTheDocument();
  });

  it('copies the shareable verification link to the clipboard', async () => {
    await generate();
    fireEvent.click(screen.getByTestId('copy-link-btn'));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        buildProofShareUrl({ credential_id: CREDENTIAL_ID, claim_type: 'HasDegree', nonce: 123n })
      )
    );
  });
});

// ── Accessibility ────────────────────────────────────────────────────────────

describe('ClaimProofGenerator accessibility', () => {
  it('labels the claim type select for assistive technology', () => {
    render(<ClaimProofGenerator credentialId={CREDENTIAL_ID} />);
    expect(screen.getByLabelText('Claim type')).toBeInTheDocument();
  });

  it('exposes the disclosure preview with a descriptive label', () => {
    render(<ClaimProofGenerator credentialId={CREDENTIAL_ID} />);
    expect(screen.getByLabelText('Disclosure preview for Degree claim')).toBeInTheDocument();
  });

  it('announces generation errors via role="alert"', async () => {
    (generateProofRequest as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    render(<ClaimProofGenerator credentialId={CREDENTIAL_ID} />);
    fireEvent.click(screen.getByTestId('generate-proof-btn'));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('announces a successful proof via role="status"', async () => {
    (generateProofRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      credential_id: CREDENTIAL_ID,
      claim_type: 'HasDegree',
      nonce: 1n,
    });
    render(<ClaimProofGenerator credentialId={CREDENTIAL_ID} />);
    fireEvent.click(screen.getByTestId('generate-proof-btn'));
    expect(await screen.findByRole('status')).toBeInTheDocument();
  });

  it('gives every copy button an accessible name', async () => {
    (generateProofRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      credential_id: CREDENTIAL_ID,
      claim_type: 'HasDegree',
      nonce: 1n,
    });
    render(<ClaimProofGenerator credentialId={CREDENTIAL_ID} />);
    fireEvent.click(screen.getByTestId('generate-proof-btn'));
    await screen.findByTestId('proof-result');
    expect(screen.getByLabelText('Copy proof request to clipboard')).toBeInTheDocument();
    expect(screen.getByLabelText('Copy shareable verification link to clipboard')).toBeInTheDocument();
  });
});
