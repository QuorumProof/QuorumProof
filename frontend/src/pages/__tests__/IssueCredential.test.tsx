import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import IssueCredential from '../IssueCredential';
import { useWallet } from '../../hooks';

vi.mock('../../hooks', () => ({
  useWallet: vi.fn(),
}));

vi.mock('../../components/IssueCredentialForm', () => ({
  IssueCredentialForm: ({ issuerAddress }: { issuerAddress: string }) => (
    <div data-testid="issue-credential-form" data-issuer-address={issuerAddress}>
      IssueCredentialForm
    </div>
  ),
}));

describe('IssueCredential page (#237)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes issuerAddress from wallet to IssueCredentialForm', () => {
    const testAddress = 'GBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFSNQB37HNU7F5V4Z5SHEOSVBQ';

    vi.mocked(useWallet).mockReturnValue({
      address: testAddress,
      isInitializing: false,
    } as ReturnType<typeof useWallet>);

    render(
      <BrowserRouter>
        <IssueCredential />
      </BrowserRouter>
    );

    const form = screen.getByTestId('issue-credential-form');
    expect(form).toHaveAttribute('data-issuer-address', testAddress);
  });
});
