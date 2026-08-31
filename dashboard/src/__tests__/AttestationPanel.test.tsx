import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { AttestationPanel } from '../components/AttestationPanel'
import type { Credential } from '../types/credential'
import type { Attestor, AttestationThreshold } from '../types/attestor'

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const baseCredential: Credential = {
  id: '0xABCDEF1234567890ABCDEF1234567890',
  type: 'degree',
  title: 'Bachelor of Science in Computer Engineering',
  subjectAddress: '0xSUBJECT0000000000000000000000000000000000',
  issuanceDate: new Date('2023-01-15'),
  status: 'pending',
  issuer: { name: 'MIT' },
}

const attestorAlice: Attestor = {
  address: '0xALICE00000000000000000000000000000000000A',
  hasSigned: false,
}

const attestorBob: Attestor = {
  address: '0xBOB000000000000000000000000000000000000B',
  hasSigned: true,
  signedAt: new Date('2023-02-01'),
  name: 'Bob (Reviewer)',
}

const threshold: AttestationThreshold = { signed: 1, required: 2 }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderPanel(overrides: Partial<Parameters<typeof AttestationPanel>[0]> = {}) {
  return render(
    <AttestationPanel
      credential={baseCredential}
      attestors={[attestorAlice, attestorBob]}
      threshold={threshold}
      {...overrides}
    />
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AttestationPanel', () => {
  describe('quorum membership gating', () => {
    it('shows "Connect your wallet" when no wallet is connected', () => {
      renderPanel()
      expect(
        screen.getByText(/connect your wallet to submit an attestation/i)
      ).toBeInTheDocument()
    })

    it('shows "not in the quorum slice" when wallet is not an attestor', () => {
      renderPanel({ connectedWalletAddress: '0xSTRANGER000000000000000000000000000000' })
      expect(
        screen.getByText(/your wallet is not in the quorum slice/i)
      ).toBeInTheDocument()
    })

    it('shows the Attest button when wallet is in the quorum and has not signed', () => {
      renderPanel({ connectedWalletAddress: attestorAlice.address })
      expect(
        screen.getByRole('button', { name: /submit attestation/i })
      ).toBeInTheDocument()
    })

    it('does case-insensitive address matching', () => {
      renderPanel({ connectedWalletAddress: attestorAlice.address.toUpperCase() })
      // Should find the attestor and show the button
      expect(
        screen.getByRole('button', { name: /submit attestation/i })
      ).toBeInTheDocument()
    })
  })

  describe('already-signed state', () => {
    it('shows "already attested" message when connected wallet has signed', () => {
      renderPanel({ connectedWalletAddress: attestorBob.address })
      expect(
        screen.getByText(/you have already attested to this credential/i)
      ).toBeInTheDocument()
    })

    it('does not show the Attest button when wallet has already signed', () => {
      renderPanel({ connectedWalletAddress: attestorBob.address })
      expect(
        screen.queryByRole('button', { name: /submit attestation/i })
      ).not.toBeInTheDocument()
    })
  })

  describe('disabled-button states', () => {
    it('Attest button is enabled when wallet is eligible', () => {
      renderPanel({ connectedWalletAddress: attestorAlice.address })
      const btn = screen.getByRole('button', { name: /submit attestation/i })
      expect(btn).not.toBeDisabled()
    })

    it('does not render Attest button when no wallet connected', () => {
      renderPanel()
      expect(
        screen.queryByRole('button', { name: /submit attestation/i })
      ).not.toBeInTheDocument()
    })
  })

  describe('signing transitions', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('shows Signing… state while onAttest is pending', async () => {
      let resolve!: () => void
      const onAttest = vi.fn(
        () =>
          new Promise<void>((res) => {
            resolve = res
          })
      )

      renderPanel({ connectedWalletAddress: attestorAlice.address, onAttest })
      const btn = screen.getByRole('button', { name: /submit attestation/i })

      // Click — the promise is pending so state = 'signing'
      await act(async () => {
        fireEvent.click(btn)
      })

      expect(screen.getByText(/signing\.\.\./i)).toBeInTheDocument()

      // Resolve the promise to avoid unhandled rejection
      await act(async () => {
        resolve()
      })
    })

    it('transitions to success state after onAttest resolves', async () => {
      const onAttest = vi.fn().mockResolvedValue(undefined)

      renderPanel({ connectedWalletAddress: attestorAlice.address, onAttest })
      const btn = screen.getByRole('button', { name: /submit attestation/i })

      await act(async () => {
        fireEvent.click(btn)
      })

      expect(screen.getByText(/attestation submitted!/i)).toBeInTheDocument()
    })

    it('resets success state back to idle after 3 seconds', async () => {
      const onAttest = vi.fn().mockResolvedValue(undefined)

      renderPanel({ connectedWalletAddress: attestorAlice.address, onAttest })

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /submit attestation/i }))
      })

      expect(screen.getByText(/attestation submitted!/i)).toBeInTheDocument()

      act(() => {
        vi.advanceTimersByTime(3_100)
      })

      expect(
        screen.getByRole('button', { name: /submit attestation/i })
      ).toBeInTheDocument()
    })

    it('shows error message when onAttest rejects', async () => {
      const onAttest = vi.fn().mockRejectedValue(new Error('Blockchain timeout'))

      renderPanel({ connectedWalletAddress: attestorAlice.address, onAttest })

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /submit attestation/i }))
      })

      expect(screen.getByRole('alert')).toHaveTextContent(/blockchain timeout/i)
    })

    it('shows generic error message for non-Error rejections', async () => {
      const onAttest = vi.fn().mockRejectedValue('unexpected')

      renderPanel({ connectedWalletAddress: attestorAlice.address, onAttest })

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /submit attestation/i }))
      })

      expect(screen.getByRole('alert')).toHaveTextContent(
        /failed to submit attestation/i
      )
    })
  })

  describe('threshold progress', () => {
    it('renders threshold badge with correct counts', () => {
      renderPanel()
      expect(screen.getByText('1 of 2')).toBeInTheDocument()
    })

    it('shows threshold-met message when threshold is reached', () => {
      renderPanel({ threshold: { signed: 3, required: 3 } })
      expect(screen.getByText(/threshold reached/i)).toBeInTheDocument()
    })

    it('does not show threshold-met when threshold is not reached', () => {
      renderPanel({ threshold: { signed: 1, required: 3 } })
      expect(screen.queryByText(/threshold reached/i)).not.toBeInTheDocument()
    })
  })

  describe('attestors list', () => {
    it('renders signed and pending attestors', () => {
      renderPanel()
      // Bob is named and signed
      expect(screen.getByText('Bob (Reviewer)')).toBeInTheDocument()
      expect(screen.getAllByText(/signed/i).length).toBeGreaterThan(0)
      expect(screen.getAllByText(/pending/i).length).toBeGreaterThan(0)
    })
  })
})
