import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { BulkRevokeDialog } from '../BulkRevokeDialog';
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
    revoked: true,
    expires_at: null,
  },
];

describe('BulkRevokeDialog', () => {
  it('only shows completion after the revoke callback succeeds', async () => {
    let completeRevoke!: () => void;
    const onConfirm = vi.fn(
      () => new Promise<void>((resolve) => { completeRevoke = resolve; })
    );
    render(<BulkRevokeDialog credentials={credentials} onConfirm={onConfirm} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Revoke 1 Credential' }));

    expect(onConfirm).toHaveBeenCalledWith([1n]);
    expect(screen.queryByText('Revocation Complete')).not.toBeInTheDocument();
    completeRevoke();

    expect(await screen.findByText('Revocation Complete')).toBeInTheDocument();
    expect(screen.getByText('1 credential marked as revoked.')).toBeInTheDocument();
  });

  it('shows an error and does not show completion when revocation fails', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('revoke failed'));
    render(<BulkRevokeDialog credentials={credentials} onConfirm={onConfirm} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Revoke 1 Credential' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to revoke credentials. Please try again.'
    );
    expect(screen.queryByText('Revocation Complete')).not.toBeInTheDocument();
  });

  it('does not allow confirming when all credentials are already revoked', () => {
    render(
      <BulkRevokeDialog
        credentials={[credentials[1]]}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Revoke 0 Credentials' })).toBeDisabled();
  });
});
