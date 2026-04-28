import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { parseJSON, parseCSV, parseImportFile } from '../lib/importUtils';
import { ImportCredentialsDialog } from '../components/ImportCredentialsDialog';
import type { Credential } from '../lib/contracts/quorumProof';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SUBJECT = 'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2EURIDVXL6B';
const ISSUER  = 'GCZXWX4J3CKPF35VQ4XYVNIS7QQ5QEPL7SZLW5QJSTW2QC4QFSXZJWF';

const validJSON = JSON.stringify([
  {
    id: '1',
    subject: SUBJECT,
    issuer: ISSUER,
    credential_type: 1,
    metadataHash: '0102030405',
    revoked: false,
    expiresAt: '1704067200',
  },
]);

const validCSV = [
  'ID,Subject,Issuer,Credential_Type,Metadata Hash,Revoked,Expires At',
  `"1","${SUBJECT}","${ISSUER}","1","0102030405","No","1704067200"`,
].join('\n');

// ── parseJSON ─────────────────────────────────────────────────────────────────

describe('parseJSON', () => {
  it('parses a valid JSON array', () => {
    const { credentials, errors } = parseJSON(validJSON);
    expect(errors).toHaveLength(0);
    expect(credentials).toHaveLength(1);
    expect(credentials[0].id).toBe(BigInt(1));
    expect(credentials[0].subject).toBe(SUBJECT);
    expect(credentials[0].revoked).toBe(false);
  });

  it('returns error for invalid JSON', () => {
    const { credentials, errors } = parseJSON('not json');
    expect(credentials).toHaveLength(0);
    expect(errors[0]).toMatch(/Invalid JSON/);
  });

  it('returns error when root is not an array', () => {
    const { credentials, errors } = parseJSON('{"id":"1"}');
    expect(credentials).toHaveLength(0);
    expect(errors[0]).toMatch(/expected an array/);
  });

  it('collects per-row errors and still returns valid rows', () => {
    const mixed = JSON.stringify([
      { id: '1', subject: SUBJECT, issuer: ISSUER, credential_type: 1, metadataHash: '0102' },
      { subject: SUBJECT, issuer: ISSUER, credential_type: 1 }, // missing id
    ]);
    const { credentials, errors } = parseJSON(mixed);
    expect(credentials).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/missing "id"/);
  });

  it('handles null expires_at', () => {
    const json = JSON.stringify([
      { id: '2', subject: SUBJECT, issuer: ISSUER, credential_type: 2, metadataHash: '', expiresAt: null },
    ]);
    const { credentials } = parseJSON(json);
    expect(credentials[0].expires_at).toBeNull();
  });

  it('returns error for invalid metadataHash hex', () => {
    const json = JSON.stringify([
      { id: '1', subject: SUBJECT, issuer: ISSUER, credential_type: 1, metadataHash: 'xyz' },
    ]);
    const { errors } = parseJSON(json);
    expect(errors[0]).toMatch(/invalid "metadataHash"/i);
  });
});

// ── parseCSV ──────────────────────────────────────────────────────────────────

describe('parseCSV', () => {
  it('parses a valid CSV', () => {
    const { credentials, errors } = parseCSV(validCSV);
    expect(errors).toHaveLength(0);
    expect(credentials).toHaveLength(1);
    expect(credentials[0].id).toBe(BigInt(1));
    expect(credentials[0].issuer).toBe(ISSUER);
  });

  it('returns error for header-only CSV', () => {
    const { credentials, errors } = parseCSV('ID,Subject,Issuer');
    expect(credentials).toHaveLength(0);
    expect(errors[0]).toMatch(/header row/);
  });

  it('marks revoked=true for "Yes"', () => {
    const csv = [
      'ID,Subject,Issuer,Credential_Type,Metadata Hash,Revoked,Expires At',
      `"1","${SUBJECT}","${ISSUER}","1","","Yes","Never"`,
    ].join('\n');
    const { credentials } = parseCSV(csv);
    expect(credentials[0].revoked).toBe(true);
  });

  it('sets expires_at to null for "Never"', () => {
    const csv = [
      'ID,Subject,Issuer,Credential_Type,Metadata Hash,Revoked,Expires At',
      `"1","${SUBJECT}","${ISSUER}","1","","No","Never"`,
    ].join('\n');
    const { credentials } = parseCSV(csv);
    expect(credentials[0].expires_at).toBeNull();
  });
});

// ── parseImportFile ───────────────────────────────────────────────────────────

describe('parseImportFile', () => {
  it('delegates to parseJSON for json format', () => {
    const { credentials } = parseImportFile(validJSON, 'json');
    expect(credentials).toHaveLength(1);
  });

  it('delegates to parseCSV for csv format', () => {
    const { credentials } = parseImportFile(validCSV, 'csv');
    expect(credentials).toHaveLength(1);
  });
});

// ── ImportCredentialsDialog ───────────────────────────────────────────────────

function makeFile(content: string, name: string): File {
  return new File([content], name, { type: 'text/plain' });
}

describe('ImportCredentialsDialog', () => {
  const onImport = vi.fn();
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the dialog', () => {
    render(<ImportCredentialsDialog onImport={onImport} onClose={onClose} />);
    expect(screen.getByText('Import Credentials')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /import/i })).toBeDisabled();
  });

  it('calls onClose when Cancel is clicked', () => {
    render(<ImportCredentialsDialog onImport={onImport} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when overlay is clicked', () => {
    render(<ImportCredentialsDialog onImport={onImport} onClose={onClose} />);
    fireEvent.click(document.querySelector('.modal-overlay')!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('enables Import button after a valid JSON file is loaded', async () => {
    render(<ImportCredentialsDialog onImport={onImport} onClose={onClose} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makeFile(validJSON, 'creds.json')] } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^import$/i })).not.toBeDisabled();
    });
    expect(screen.getByText(/1 credential\(s\) ready/)).toBeInTheDocument();
  });

  it('calls onImport with parsed credentials on confirm', async () => {
    render(<ImportCredentialsDialog onImport={onImport} onClose={onClose} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makeFile(validJSON, 'creds.json')] } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^import$/i })).not.toBeDisabled();
    });

    fireEvent.click(screen.getByRole('button', { name: /^import$/i }));
    expect(onImport).toHaveBeenCalledOnce();
    const imported = onImport.mock.calls[0][0] as Credential[];
    expect(imported).toHaveLength(1);
    expect(imported[0].id).toBe(BigInt(1));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows validation errors for a bad JSON file', async () => {
    render(<ImportCredentialsDialog onImport={onImport} onClose={onClose} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makeFile('not json', 'bad.json')] } });

    await waitFor(() => {
      expect(screen.getByText(/Validation errors/)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /^import$/i })).toBeDisabled();
  });

  it('auto-detects CSV format from file extension', async () => {
    render(<ImportCredentialsDialog onImport={onImport} onClose={onClose} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makeFile(validCSV, 'creds.csv')] } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^import$/i })).not.toBeDisabled();
    });
    expect(screen.getByText(/1 credential\(s\) ready/)).toBeInTheDocument();
  });
});
