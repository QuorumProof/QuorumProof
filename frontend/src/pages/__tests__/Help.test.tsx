import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import Help from '../Help';

vi.mock('../components/Navbar', () => ({
  Navbar: () => <div data-testid="navbar">Navbar</div>,
}));

describe('Help Page', () => {
  const renderHelp = () => {
    return render(
      <BrowserRouter>
        <Help />
      </BrowserRouter>
    );
  };

  it('should render help page with title', () => {
    renderHelp();
    expect(screen.getByText('Help & FAQ')).toBeInTheDocument();
  });

  it('should display FAQ items', () => {
    renderHelp();
    expect(screen.getByText('What is QuorumProof?')).toBeInTheDocument();
    expect(screen.getByText('How do credentials work?')).toBeInTheDocument();
  });

  it('should expand FAQ item on click', () => {
    renderHelp();
    const question = screen.getByText('What is QuorumProof?');
    fireEvent.click(question);
    
    expect(screen.getByText(/decentralized professional credential verification/)).toBeInTheDocument();
  });

  it('should filter by category', () => {
    renderHelp();
    const credentialsCategory = screen.getByRole('button', { name: 'Credentials' });
    fireEvent.click(credentialsCategory);
    
    expect(screen.getByText('How do credentials work?')).toBeInTheDocument();
  });

  it('should display resource cards', () => {
    renderHelp();
    expect(screen.getByText('Documentation')).toBeInTheDocument();
    expect(screen.getByText('Community')).toBeInTheDocument();
    expect(screen.getByText('Report Issues')).toBeInTheDocument();
  });

  it('should have working external links', () => {
    renderHelp();
    const docLink = screen.getByRole('link', { name: 'View Docs' });
    expect(docLink).toHaveAttribute('href');
    expect(docLink).toHaveAttribute('target', '_blank');
  });
});
