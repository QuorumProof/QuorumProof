import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CredentialCard } from '../components/CredentialCard'
import type { Credential } from '../types/credential'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCredential(overrides: Partial<Credential> = {}): Credential {
  return {
    id: '0x1234567890ABCDEF1234567890ABCDEF',
    type: 'degree',
    title: 'Bachelor of Science',
    subjectAddress: '0xSUBJECT0000000000000000000000000000000000',
    issuanceDate: new Date('2022-06-01'),
    status: 'attested',
    issuer: { name: 'MIT' },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CredentialCard', () => {
  describe('status badge rendering', () => {
    it('renders "Attested" badge for attested status', () => {
      render(<CredentialCard credential={makeCredential({ status: 'attested' })} />)
      expect(screen.getByText('Attested')).toBeInTheDocument()
    })

    it('renders "Pending" badge for pending status', () => {
      render(<CredentialCard credential={makeCredential({ status: 'pending' })} />)
      expect(screen.getByText('Pending')).toBeInTheDocument()
    })

    it('renders "Revoked" badge for revoked status', () => {
      render(<CredentialCard credential={makeCredential({ status: 'revoked' })} />)
      expect(screen.getByText('Revoked')).toBeInTheDocument()
    })

    it('applies attested CSS class for attested status', () => {
      render(<CredentialCard credential={makeCredential({ status: 'attested' })} />)
      const badge = screen.getByLabelText(/credential status: attested/i)
      expect(badge).toHaveClass('credential-card__status-badge--attested')
    })

    it('applies revoked CSS class for revoked status', () => {
      render(<CredentialCard credential={makeCredential({ status: 'revoked' })} />)
      const badge = screen.getByLabelText(/credential status: revoked/i)
      expect(badge).toHaveClass('credential-card__status-badge--revoked')
    })
  })

  describe('revoked styling', () => {
    it('applies credential-card--revoked class to the card when revoked', () => {
      const { container } = render(
        <CredentialCard credential={makeCredential({ status: 'revoked' })} />
      )
      const card = container.firstChild as HTMLElement
      expect(card).toHaveClass('credential-card--revoked')
    })

    it('does not apply credential-card--revoked class for attested', () => {
      const { container } = render(
        <CredentialCard credential={makeCredential({ status: 'attested' })} />
      )
      const card = container.firstChild as HTMLElement
      expect(card).not.toHaveClass('credential-card--revoked')
    })

    it('shows revocation reason when provided', () => {
      render(
        <CredentialCard
          credential={makeCredential({
            status: 'revoked',
            revocationReason: 'Issued in error',
          })}
        />
      )
      expect(screen.getByText('Issued in error')).toBeInTheDocument()
    })

    it('does not navigate when card is revoked', () => {
      const onNavigate = vi.fn()
      render(
        <CredentialCard
          credential={makeCredential({ status: 'revoked' })}
          onNavigate={onNavigate}
        />
      )
      fireEvent.click(screen.getByRole('button'))
      expect(onNavigate).not.toHaveBeenCalled()
    })
  })

  describe('keyboard activation', () => {
    it('calls onNavigate when Enter is pressed on an attested card', () => {
      const onNavigate = vi.fn()
      render(
        <CredentialCard
          credential={makeCredential({ status: 'attested' })}
          onNavigate={onNavigate}
        />
      )
      const card = screen.getByRole('button')
      fireEvent.keyDown(card, { key: 'Enter' })
      expect(onNavigate).toHaveBeenCalledWith(makeCredential().id)
    })

    it('calls onNavigate when Space is pressed on an attested card', () => {
      const onNavigate = vi.fn()
      render(
        <CredentialCard
          credential={makeCredential({ status: 'attested' })}
          onNavigate={onNavigate}
        />
      )
      const card = screen.getByRole('button')
      fireEvent.keyDown(card, { key: ' ' })
      expect(onNavigate).toHaveBeenCalledWith(makeCredential().id)
    })

    it('does not call onNavigate on other keys', () => {
      const onNavigate = vi.fn()
      render(
        <CredentialCard
          credential={makeCredential({ status: 'attested' })}
          onNavigate={onNavigate}
        />
      )
      fireEvent.keyDown(screen.getByRole('button'), { key: 'Escape' })
      expect(onNavigate).not.toHaveBeenCalled()
    })

    it('is not interactive when isInteractive is false', () => {
      render(
        <CredentialCard
          credential={makeCredential()}
          isInteractive={false}
        />
      )
      // Role should be article, not button
      expect(screen.queryByRole('button')).not.toBeInTheDocument()
      expect(screen.getByRole('article')).toBeInTheDocument()
    })
  })

  describe('credential content', () => {
    it('renders the credential title', () => {
      render(<CredentialCard credential={makeCredential()} />)
      expect(screen.getByText('Bachelor of Science')).toBeInTheDocument()
    })

    it('renders the issuer name', () => {
      render(<CredentialCard credential={makeCredential()} />)
      expect(screen.getByText('MIT')).toBeInTheDocument()
    })

    it('renders expiration date when provided', () => {
      render(
        <CredentialCard
          credential={makeCredential({ expirationDate: new Date('2030-12-31') })}
        />
      )
      expect(screen.getByText('Dec 31, 2030')).toBeInTheDocument()
    })

    it('does not render expiry section when no expiration date', () => {
      render(<CredentialCard credential={makeCredential()} />)
      expect(screen.queryByText('Expires')).not.toBeInTheDocument()
    })
  })
})
