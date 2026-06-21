import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import { CredentialWizard } from '../CredentialWizard';
import { ToastProvider } from '../../context/ToastContext';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../lib/contracts/quorumProof', () => ({
  issueCredential: vi.fn(),
  createSlice: vi.fn(),
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => vi.fn() };
});

const ISSUER = 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZQE3GGQMJYQMVAMLEGO';
const VALID_SUBJECT = 'GW674PTN7IWEZ6AE6OWW3NBULKVCCJUZOGMUSG6HFG6ZOLSL56XCAMBX';
// 56-char G… Stellar address
const VALID_ATTESTOR = 'GBVZZ2NKZZ2NKZZ2NKZZ2NKZZ2NKZZ2NKZZ2NKZZ2NKZZ2NKZZ2NKZAB';

function renderWizard() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <CredentialWizard issuerAddress={ISSUER} />
      </ToastProvider>
    </MemoryRouter>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function clickNext() {
  fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
}

async function advanceToStep2() {
  // Step 1: credential type already selected by default
  clickNext();
  await waitFor(() => expect(screen.getByLabelText(/Subject Stellar address/i)).toBeInTheDocument());
}

async function advanceToStep3() {
  await advanceToStep2();
  fireEvent.change(screen.getByLabelText(/Subject Stellar address/i), { target: { value: VALID_SUBJECT } });
  fireEvent.change(screen.getByLabelText(/Metadata hash/i), { target: { value: 'QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco' } });
  clickNext();
  await waitFor(() => expect(screen.getByLabelText(/Stellar address/i)).toBeInTheDocument());
}

async function advanceToStep4() {
  await advanceToStep3();
  fireEvent.change(screen.getByLabelText(/Stellar address/i), { target: { value: VALID_ATTESTOR } });
  fireEvent.click(screen.getByRole('button', { name: /Add attestor to slice/i }));
  // Wait for attestor to appear in list
  await waitFor(() => expect(screen.getByText(/GBVZZ2NK/)).toBeInTheDocument());
  clickNext();
  await waitFor(() => expect(screen.getByRole('region', { name: /Credential preview/i })).toBeInTheDocument());
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CredentialWizard — Step 1 (Type selection)', () => {
  beforeEach(() => sessionStorage.clear());

  it('renders all 5 credential type cards', () => {
    renderWizard();
    expect(screen.getByText('Degree')).toBeInTheDocument();
    expect(screen.getByText('License')).toBeInTheDocument();
    expect(screen.getByText('Employment')).toBeInTheDocument();
    expect(screen.getByText('Certification')).toBeInTheDocument();
    expect(screen.getByText('Research')).toBeInTheDocument();
  });

  it('advances to step 2 when a type is selected', async () => {
    renderWizard();
    await advanceToStep2();
    expect(screen.getByLabelText(/Subject Stellar address/i)).toBeInTheDocument();
  });

  it('selecting a card marks it as selected', () => {
    renderWizard();
    const licenseCard = screen.getByText('License').closest('label')!;
    fireEvent.click(licenseCard);
    expect(licenseCard).toHaveClass('wizard-type-card--selected');
  });
});

describe('CredentialWizard — Step 2 (Metadata input)', () => {
  beforeEach(() => sessionStorage.clear());

  it('shows subject and metadata fields', async () => {
    renderWizard();
    await advanceToStep2();
    expect(screen.getByLabelText(/Subject Stellar address/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Metadata hash/i)).toBeInTheDocument();
  });

  it('shows error when subject is empty', async () => {
    renderWizard();
    await advanceToStep2();
    clickNext();
    await waitFor(() =>
      expect(screen.getAllByRole('alert')[0]).toHaveTextContent(/required/i)
    );
  });

  it('shows error for invalid Stellar address', async () => {
    renderWizard();
    await advanceToStep2();
    fireEvent.change(screen.getByLabelText(/Subject Stellar address/i), { target: { value: 'notanaddress' } });
    fireEvent.change(screen.getByLabelText(/Metadata hash/i), { target: { value: 'QmHash' } });
    clickNext();
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/valid Stellar address/i)
    );
  });

  it('shows error when metadata hash is too short', async () => {
    renderWizard();
    await advanceToStep2();
    fireEvent.change(screen.getByLabelText(/Subject Stellar address/i), { target: { value: VALID_SUBJECT } });
    fireEvent.change(screen.getByLabelText(/Metadata hash/i), { target: { value: 'ab' } });
    clickNext();
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/at least 4 characters/i)
    );
  });

  it('shows error when metadata hash exceeds 256 bytes', async () => {
    renderWizard();
    await advanceToStep2();
    fireEvent.change(screen.getByLabelText(/Subject Stellar address/i), { target: { value: VALID_SUBJECT } });
    const longHash = 'a'.repeat(257);
    fireEvent.change(screen.getByLabelText(/Metadata hash/i), { target: { value: longHash } });
    clickNext();
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/256 bytes/i)
    );
  });

  it('shows issuer address as read-only', async () => {
    renderWizard();
    await advanceToStep2();
    const issuerInput = screen.getByLabelText(/Issuer address/i) as HTMLInputElement;
    expect(issuerInput.value).toBe(ISSUER);
    expect(issuerInput).toHaveAttribute('readonly');
  });

  it('displays live byte counter', async () => {
    renderWizard();
    await advanceToStep2();
    fireEvent.change(screen.getByLabelText(/Metadata hash/i), { target: { value: 'QmHash12345' } });
    expect(screen.getByText(/\d+ \/ 256 bytes/i)).toBeInTheDocument();
  });
});

describe('CredentialWizard — Step 3 (Attestor config)', () => {
  beforeEach(() => sessionStorage.clear());

  it('shows empty state with no attestors', async () => {
    renderWizard();
    await advanceToStep3();
    expect(screen.getByText(/No attestors added yet/i)).toBeInTheDocument();
  });

  it('blocks advancing with no attestors', async () => {
    renderWizard();
    await advanceToStep3();
    clickNext();
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/at least one attestor/i)
    );
  });

  it('shows error for invalid attestor address', async () => {
    renderWizard();
    await advanceToStep3();
    fireEvent.change(screen.getByLabelText(/Stellar address/i), { target: { value: 'bad_address' } });
    fireEvent.click(screen.getByRole('button', { name: /Add attestor to slice/i }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/Invalid Stellar address/i)
    );
  });

  it('adds a valid attestor to the list', async () => {
    renderWizard();
    await advanceToStep3();
    fireEvent.change(screen.getByLabelText(/Stellar address/i), { target: { value: VALID_ATTESTOR } });
    fireEvent.click(screen.getByRole('button', { name: /Add attestor to slice/i }));
    await waitFor(() =>
      expect(screen.getByText(/GBVZZ2NK/)).toBeInTheDocument()
    );
  });

  it('shows error for duplicate attestor address', async () => {
    renderWizard();
    await advanceToStep3();
    // Add once
    fireEvent.change(screen.getByLabelText(/Stellar address/i), { target: { value: VALID_ATTESTOR } });
    fireEvent.click(screen.getByRole('button', { name: /Add attestor to slice/i }));
    await waitFor(() => screen.getByText(/GBVZZ2NK/));
    // Try to add again
    fireEvent.change(screen.getByLabelText(/Stellar address/i), { target: { value: VALID_ATTESTOR } });
    fireEvent.click(screen.getByRole('button', { name: /Add attestor to slice/i }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/already in the slice/i)
    );
  });

  it('removes an attestor from the list', async () => {
    renderWizard();
    await advanceToStep3();
    fireEvent.change(screen.getByLabelText(/Stellar address/i), { target: { value: VALID_ATTESTOR } });
    fireEvent.click(screen.getByRole('button', { name: /Add attestor to slice/i }));
    await waitFor(() => screen.getByText(/GBVZZ2NK/));
    // Remove button aria-label contains "Remove attestor"
    fireEvent.click(screen.getByRole('button', { name: /Remove attestor/i }));
    await waitFor(() =>
      expect(screen.queryByText(/GBVZZ2NK/)).not.toBeInTheDocument()
    );
  });

  it('shows threshold field after adding an attestor', async () => {
    renderWizard();
    await advanceToStep3();
    fireEvent.change(screen.getByLabelText(/Stellar address/i), { target: { value: VALID_ATTESTOR } });
    fireEvent.click(screen.getByRole('button', { name: /Add attestor to slice/i }));
    await waitFor(() =>
      expect(screen.getByLabelText(/Attestation threshold/i)).toBeInTheDocument()
    );
  });

  it('shows error if threshold exceeds attestor count', async () => {
    renderWizard();
    await advanceToStep3();
    fireEvent.change(screen.getByLabelText(/Stellar address/i), { target: { value: VALID_ATTESTOR } });
    fireEvent.click(screen.getByRole('button', { name: /Add attestor to slice/i }));
    await waitFor(() => screen.getByLabelText(/Attestation threshold/i));
    fireEvent.change(screen.getByLabelText(/Attestation threshold/i), { target: { value: '5' } });
    clickNext();
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/cannot exceed/i)
    );
  });
});

describe('CredentialWizard — Step 4 (Preview)', () => {
  beforeEach(() => sessionStorage.clear());

  it('displays credential type in preview', async () => {
    renderWizard();
    await advanceToStep4();
    expect(screen.getByText(/Degree/)).toBeInTheDocument();
  });

  it('displays truncated subject address in preview', async () => {
    renderWizard();
    await advanceToStep4();
    // Subject: GW674PTN…XCAMBX
    expect(screen.getByText('GW674PTN…XCAMBX')).toBeInTheDocument();
  });

  it('displays threshold info in preview', async () => {
    renderWizard();
    await advanceToStep4();
    expect(screen.getByText(/1 of 1 attestors/i)).toBeInTheDocument();
  });

  it('shows submit button on step 4', async () => {
    renderWizard();
    await advanceToStep4();
    expect(screen.getByRole('button', { name: /Submit to Blockchain/i })).toBeInTheDocument();
  });
});

describe('CredentialWizard — Submission', () => {
  beforeEach(() => sessionStorage.clear());

  it('calls issueCredential and createSlice on submit', async () => {
    const { issueCredential, createSlice } = await import('../../lib/contracts/quorumProof');
    (issueCredential as ReturnType<typeof vi.fn>).mockResolvedValue(BigInt(42));
    (createSlice as ReturnType<typeof vi.fn>).mockResolvedValue(BigInt(1));

    renderWizard();
    await advanceToStep4();
    fireEvent.click(screen.getByRole('button', { name: /Submit to Blockchain/i }));

    await waitFor(() => expect(issueCredential).toHaveBeenCalledOnce());
    await waitFor(() => expect(createSlice).toHaveBeenCalledOnce());
  });

  it('shows submission error on failure', async () => {
    const { issueCredential } = await import('../../lib/contracts/quorumProof');
    (issueCredential as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Contract error'));

    renderWizard();
    await advanceToStep4();
    fireEvent.click(screen.getByRole('button', { name: /Submit to Blockchain/i }));

    await waitFor(() =>
      expect(screen.getByText(/Contract error/i)).toBeInTheDocument()
    );
  });
});

describe('CredentialWizard — Navigation and state', () => {
  beforeEach(() => sessionStorage.clear());

  it('back button returns to previous step', async () => {
    renderWizard();
    await advanceToStep2();
    fireEvent.click(screen.getByRole('button', { name: /← Back/i }));
    expect(screen.getByText(/Select credential type/i)).toBeInTheDocument();
  });

  it('reset button clears the form and returns to step 1', async () => {
    renderWizard();
    await advanceToStep2();
    fireEvent.change(screen.getByLabelText(/Subject Stellar address/i), { target: { value: VALID_SUBJECT } });
    fireEvent.click(screen.getByRole('button', { name: /Reset/i }));
    expect(screen.getByText(/Select credential type/i)).toBeInTheDocument();
  });

  it('persists draft to sessionStorage on change', async () => {
    renderWizard();
    await advanceToStep2();
    fireEvent.change(screen.getByLabelText(/Subject Stellar address/i), { target: { value: VALID_SUBJECT } });
    const draft = JSON.parse(sessionStorage.getItem('credential-wizard-draft') ?? '{}');
    expect(draft.subject).toBe(VALID_SUBJECT);
  });
});

describe('CredentialWizard — Accessibility', () => {
  beforeEach(() => sessionStorage.clear());

  it('step indicator has aria-current="step" on current step', () => {
    renderWizard();
    const nav = screen.getByRole('navigation', { name: /Credential wizard steps/i });
    const current = nav.querySelector('[aria-current="step"]');
    expect(current).not.toBeNull();
  });

  it('error messages are announced with role="alert"', async () => {
    renderWizard();
    await advanceToStep2();
    clickNext();
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
  });

  it('credential type radios are keyboard navigable', () => {
    renderWizard();
    const radioGroup = screen.getByRole('radiogroup', { name: /Credential type/i });
    expect(radioGroup).toBeInTheDocument();
    const radios = screen.getAllByRole('radio');
    expect(radios.length).toBe(5);
  });

  it('submit button is disabled while submitting', async () => {
    const { issueCredential } = await import('../../lib/contracts/quorumProof');
    let resolve!: (v: bigint) => void;
    (issueCredential as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<bigint>((r) => { resolve = r; })
    );

    renderWizard();
    await advanceToStep4();
    const btn = screen.getByRole('button', { name: /Submit to Blockchain/i });
    fireEvent.click(btn);
    await waitFor(() => expect(btn).toBeDisabled());
    resolve(BigInt(1));
  });
});

describe('CredentialWizard — seed (duplicate-from-template)', () => {
  beforeEach(() => sessionStorage.clear());

  it('pre-fills subject from seed', () => {
    render(
      <MemoryRouter>
        <ToastProvider>
          <CredentialWizard
            issuerAddress={ISSUER}
            seed={{ credentialType: 2, subject: VALID_SUBJECT, metadataHash: 'QmDup123', attestors: [], threshold: 1 }}
          />
        </ToastProvider>
      </MemoryRouter>
    );
    // Advance past step 1 to see the subject field
    clickNext();
    const subjectInput = screen.getByLabelText(/Subject Stellar address/i) as HTMLInputElement;
    expect(subjectInput.value).toBe(VALID_SUBJECT);
  });

  it('pre-selects credential type from seed', () => {
    render(
      <MemoryRouter>
        <ToastProvider>
          <CredentialWizard
            issuerAddress={ISSUER}
            seed={{ credentialType: 3 }}
          />
        </ToastProvider>
      </MemoryRouter>
    );
    const employmentCard = screen.getByText('Employment').closest('label')!;
    expect(employmentCard).toHaveClass('wizard-type-card--selected');
  });

  it('seed takes priority over sessionStorage draft', () => {
    sessionStorage.setItem('credential-wizard-draft', JSON.stringify({ credentialType: 5, subject: 'stale' }));
    render(
      <MemoryRouter>
        <ToastProvider>
          <CredentialWizard
            issuerAddress={ISSUER}
            seed={{ credentialType: 2, subject: VALID_SUBJECT, metadataHash: 'QmSeed', attestors: [], threshold: 1 }}
          />
        </ToastProvider>
      </MemoryRouter>
    );
    // License (type 2) card should be selected, not Research (type 5)
    expect(screen.getByText('License').closest('label')).toHaveClass('wizard-type-card--selected');
    expect(screen.queryByText('Research')?.closest('label')).not.toHaveClass('wizard-type-card--selected');
  });

  it('pre-fills attestors from seed and shows them on step 3', async () => {
    render(
      <MemoryRouter>
        <ToastProvider>
          <CredentialWizard
            issuerAddress={ISSUER}
            seed={{
              credentialType: 1,
              subject: VALID_SUBJECT,
              metadataHash: 'QmDup123456',
              attestors: [{ id: 'seed-0', address: VALID_ATTESTOR, role: 'University Registrar' }],
              threshold: 1,
            }}
          />
        </ToastProvider>
      </MemoryRouter>
    );
    // Step 1 → 2 → 3
    clickNext();
    await waitFor(() => screen.getByLabelText(/Subject Stellar address/i));
    clickNext();
    await waitFor(() => screen.getByLabelText(/Stellar address/i));
    expect(screen.getByText(/GBVZZ2NK/)).toBeInTheDocument();
    expect(screen.getByText('University Registrar')).toBeInTheDocument();
  });
});
