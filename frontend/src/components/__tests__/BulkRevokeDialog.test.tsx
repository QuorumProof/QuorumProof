import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BulkRevokeDialog } from '../BulkRevokeDialog';
import type { Credential } from '../../lib/contracts/quorumProof';

const credential: Credential = {
  id: 42n,
  subject: 'GABC',
  issuer: 'GDEF',
  credential_type: 1,
  metadata_hash: new Uint8Array(),
  revoked: false,
  expires_at: null,
};

describe('BulkRevokeDialog', () => {
  it('shows completion only after the confirmation callback resolves', async () => {
    let resolveConfirmation!: () => void;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConfirmation = resolve;
        }),
    );
    render(
      <BulkRevokeDialog
        credentials={[credential]}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Revoke 1 Credential' }));

    expect(onConfirm).toHaveBeenCalledWith([42n]);
    expect(screen.queryByText('Revocation Complete')).not.toBeInTheDocument();
    resolveConfirmation();

    await waitFor(() => expect(screen.getByText('Revocation Complete')).toBeInTheDocument());
  });

  it('reports callback failures without showing a success state', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('Transaction rejected'));
    render(
      <BulkRevokeDialog
        credentials={[credential]}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Revoke 1 Credential' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Transaction rejected');
    expect(screen.queryByText('Revocation Complete')).not.toBeInTheDocument();
  });
});
