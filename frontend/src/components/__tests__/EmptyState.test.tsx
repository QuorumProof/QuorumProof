import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, expect, it } from 'vitest';
import { EmptyState } from '../EmptyState';

describe('EmptyState', () => {
  it('links the issuance action to the credential issuance page', () => {
    render(<EmptyState address="GTESTADDRESS" />);

    const link = screen.getByRole('link', { name: /Request Credential Issuance/i });
    expect(link).toHaveAttribute('href', '/credential/issue');
  });

  it('does not advertise the issuance flow as coming soon', () => {
    render(<EmptyState address="GTESTADDRESS" />);

    expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument();
  });
});
