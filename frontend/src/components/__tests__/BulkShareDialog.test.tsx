import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { BulkShareDialog } from '../BulkShareDialog';
import type { Credential } from '../../lib/contracts/quorumProof';

const credentials: Credential[] = [
  {
    id: 1n,
    subject: 'subject',
    issuer: 'issuer',
    credential_type: 1,
    metadata_hash: new Uint8Array(),
    revoked: false,
    expires_at: null,
  },
  {
    id: 2n,
    subject: 'subject',
    issuer: 'issuer',
    credential_type: 2,
    metadata_hash: new Uint8Array(),
    revoked: false,
    expires_at: null,
  },
];

describe('BulkShareDialog', () => {
  const writeText = vi.fn();

  beforeEach(() => {
    writeText.mockReset().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
  });

  it('copies a single credential link and shows success after copy resolves', async () => {
    render(<BulkShareDialog credentials={credentials} onClose={vi.fn()} />);

    fireEvent.click(screen.getAllByRole('button', { name: '📋' })[0]);

    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/verify?id=1`);
    expect(await screen.findByRole('button', { name: '✅' })).toBeInTheDocument();
  });

  it('copies every selected credential link', async () => {
    render(<BulkShareDialog credentials={credentials} onClose={vi.fn()} />);
    const links = credentials
      .map((credential) => `${window.location.origin}/verify?id=${credential.id}`)
      .join('\n');

    fireEvent.click(screen.getByRole('button', { name: '📋 Copy All 2 Links' }));

    expect(writeText).toHaveBeenCalledWith(links);
    expect(await screen.findByRole('button', { name: '✅ Copied All' })).toBeInTheDocument();
  });

  it('does not show success and reports an error when copying fails', async () => {
    writeText.mockRejectedValueOnce(new Error('clipboard unavailable'));
    render(<BulkShareDialog credentials={credentials} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '📋 Copy All 2 Links' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to copy the verification links. Please try again.'
    );
    expect(screen.getByRole('button', { name: '📋 Copy All 2 Links' })).toBeInTheDocument();
  });

  it('clears the previous success state when a later copy fails', async () => {
    render(<BulkShareDialog credentials={credentials} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '📋 Copy All 2 Links' }));
    expect(await screen.findByRole('button', { name: '✅ Copied All' })).toBeInTheDocument();

    writeText.mockRejectedValueOnce(new Error('clipboard unavailable'));
    fireEvent.click(screen.getByRole('button', { name: '✅ Copied All' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '📋 Copy All 2 Links' })).toBeInTheDocument();
  });
});
