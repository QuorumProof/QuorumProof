/**
 * SliceBackup.test.tsx — issue #469
 * Tests for encrypted slice backup and recovery.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { encryptBackup, decryptBackup, downloadBackupFile } from '../../lib/sliceBackup';
import type { SliceBackupData } from '../../lib/sliceBackup';
import { SliceBackupRestore } from '../../components/SliceBackupRestore';

const MOCK_SLICE: SliceBackupData = {
  version: 1,
  creator: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNN',
  attestors: [
    { address: 'GBAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNN', role: 'University' },
  ],
  threshold: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
};

// ── sliceBackup utility ───────────────────────────────────────────────────────

describe('encryptBackup / decryptBackup', () => {
  it('round-trips data with correct password', async () => {
    const blob = await encryptBackup(MOCK_SLICE, 'secret123');
    const result = await decryptBackup(blob, 'secret123');
    expect(result.creator).toBe(MOCK_SLICE.creator);
    expect(result.threshold).toBe(1);
    expect(result.attestors).toHaveLength(1);
  });

  it('throws on wrong password', async () => {
    const blob = await encryptBackup(MOCK_SLICE, 'correct');
    await expect(decryptBackup(blob, 'wrong')).rejects.toThrow('Decryption failed');
  });

  it('produces different blobs for same data (random IV)', async () => {
    const b1 = await encryptBackup(MOCK_SLICE, 'pw');
    const b2 = await encryptBackup(MOCK_SLICE, 'pw');
    expect(b1).not.toBe(b2);
  });
});

describe('downloadBackupFile', () => {
  it('creates and removes an anchor element', () => {
    const appendSpy = vi.spyOn(document.body, 'appendChild');
    const removeSpy = vi.spyOn(document.body, 'removeChild');
    downloadBackupFile('abc123');
    expect(appendSpy).toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalled();
  });
});

// ── SliceBackupRestore component ──────────────────────────────────────────────

describe('SliceBackupRestore', () => {
  const onRestore = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders backup and restore sections', () => {
    render(<SliceBackupRestore sliceData={MOCK_SLICE} onRestore={onRestore} />);
    expect(screen.getByText(/Backup Slice/)).toBeInTheDocument();
    expect(screen.getByText(/Restore Slice/)).toBeInTheDocument();
  });

  it('shows error when backup attempted without password', async () => {
    render(<SliceBackupRestore sliceData={MOCK_SLICE} onRestore={onRestore} />);
    fireEvent.click(screen.getByTestId('backup-btn'));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Password is required');
    });
  });

  it('disables backup button when no slice data', () => {
    render(<SliceBackupRestore sliceData={null} onRestore={onRestore} />);
    expect(screen.getByTestId('backup-btn')).toBeDisabled();
  });

  it('shows error when restore attempted without password', async () => {
    render(<SliceBackupRestore sliceData={null} onRestore={onRestore} />);
    const fileInput = screen.getByTestId('restore-file-input');
    const file = new File(['dummy'], 'backup.qpb', { type: 'text/plain' });
    fireEvent.change(fileInput, { target: { files: [file] } });
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Enter a password');
    });
  });

  it('calls onRestore with decrypted data on valid restore', async () => {
    const blob = await encryptBackup(MOCK_SLICE, 'testpw');
    render(<SliceBackupRestore sliceData={null} onRestore={onRestore} />);

    fireEvent.change(screen.getByLabelText('Decryption Password'), {
      target: { value: 'testpw' },
    });

    const file = new File([blob], 'backup.qpb', { type: 'text/plain' });
    fireEvent.change(screen.getByTestId('restore-file-input'), {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(screen.getByTestId('restore-success')).toBeInTheDocument();
    });
    expect(onRestore).toHaveBeenCalledWith(expect.objectContaining({ creator: MOCK_SLICE.creator }));
  });
});
