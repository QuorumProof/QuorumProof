/**
 * GdprRequest.tsx
 *
 * Issue #1447 — Require a wallet-signed proof of ownership before a GDPR
 *   anonymization request is submitted.  The connected wallet must match the
 *   credential's subject address; an off-chain challenge string is signed via
 *   Freighter / hardware wallet before the request is sent to the server.
 *
 * Issue #1448 — All HTTP calls now go through the shared typed apiClient
 *   (src/lib/apiClient.ts) with AbortController-based cancellation on unmount
 *   or re-submit, normalised error handling, and runtime shape guards instead
 *   of unchecked `as GdprRequestRecord` casts.
 */
import { useState, useEffect, useRef } from 'react';
import { Navbar } from '../components/Navbar';
import { useWallet } from '../hooks';
import { apiGet, apiPost, ApiError, type ShapeGuard } from '../lib/apiClient';
import { getCredential } from '../stellar';

// ── Types ─────────────────────────────────────────────────────────────────────

type RequestStatus = 'pending_consent' | 'anonymized' | 'rejected';

interface GdprRequestRecord {
  requestId: string;
  credentialId: number;
  requestedAt: string;
  status: RequestStatus;
  attestorConsents: string[];
  requiredConsents: number;
}

// ── Runtime shape guard ───────────────────────────────────────────────────────

const isGdprRequestRecord: ShapeGuard<GdprRequestRecord> = (v): v is GdprRequestRecord =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as GdprRequestRecord).requestId === 'string' &&
  typeof (v as GdprRequestRecord).credentialId === 'number' &&
  typeof (v as GdprRequestRecord).status === 'string' &&
  Array.isArray((v as GdprRequestRecord).attestorConsents);

// ── Challenge signing helper ──────────────────────────────────────────────────

/**
 * Build a deterministic challenge string for a GDPR request.
 * The challenge encodes enough context to prevent replay across different
 * credentials or wallet addresses.
 */
function buildChallenge(credentialId: number, walletAddress: string): string {
  return `QuorumProof GDPR erasure request\ncredentialId=${credentialId}\nsubject=${walletAddress}\ntimestamp=${Math.floor(Date.now() / 60_000)}`; // 60-second window
}

/**
 * Sign the challenge string using the connected wallet (Freighter API).
 * Returns the base-64 encoded signature, or throws on failure.
 */
async function signChallenge(challenge: string): Promise<string> {
  const { signMessage } = await import('@stellar/freighter-api');
  // signMessage encodes the message as UTF-8 and signs with the active key.
  const result = await (signMessage as (msg: string) => Promise<{ signedMessage?: string; error?: string }>)(challenge);
  if ('error' in result && result.error) {
    throw new Error(`Wallet signing failed: ${result.error}`);
  }
  if (!result.signedMessage) {
    throw new Error('Wallet returned no signature');
  }
  return result.signedMessage;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function GdprRequest() {
  const { address: walletAddress } = useWallet();

  // ── Submit section ──────────────────────────────────────────────────────────
  const [credentialId, setCredentialId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [createdRequest, setCreatedRequest] = useState<GdprRequestRecord | null>(null);

  // ── Lookup section ──────────────────────────────────────────────────────────
  const [lookupId, setLookupId] = useState('');
  const [lookupResult, setLookupResult] = useState<GdprRequestRecord | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  // ── Consent section ─────────────────────────────────────────────────────────
  const [consentRequestId, setConsentRequestId] = useState('');
  const [consentAddress, setConsentAddress] = useState('');
  const [consentSubmitting, setConsentSubmitting] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [consentResult, setConsentResult] = useState<GdprRequestRecord | null>(null);

  // AbortController refs to cancel in-flight requests on unmount / re-submit
  const submitAbortRef = useRef<AbortController | null>(null);
  const lookupAbortRef = useRef<AbortController | null>(null);
  const consentAbortRef = useRef<AbortController | null>(null);

  // Cancel all in-flight requests when the component unmounts
  useEffect(() => {
    return () => {
      submitAbortRef.current?.abort();
      lookupAbortRef.current?.abort();
      consentAbortRef.current?.abort();
    };
  }, []);

  // ── Handlers ────────────────────────────────────────────────────────────────

  const handleSubmitRequest = async (e: React.FormEvent) => {
    e.preventDefault();

    const id = parseInt(credentialId.trim(), 10);
    if (!Number.isInteger(id) || id <= 0) {
      setSubmitError('Enter a valid credential ID (positive integer).');
      return;
    }

    // Issue #1447: wallet must be connected
    if (!walletAddress) {
      setSubmitError('Connect your wallet before submitting a GDPR request.');
      return;
    }

    // Issue #1447: verify that the connected wallet matches the credential subject
    try {
      const credential = await getCredential(id);
      if (credential.subject !== walletAddress) {
        setSubmitError(
          'The connected wallet does not match the credential subject. ' +
          'You can only request erasure of your own credentials.',
        );
        return;
      }
    } catch {
      setSubmitError('Could not verify credential ownership. Check the credential ID and try again.');
      return;
    }

    // Issue #1447: sign a challenge to prove ownership of the wallet
    let signature: string;
    try {
      const challenge = buildChallenge(id, walletAddress);
      signature = await signChallenge(challenge);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Wallet signing failed.');
      return;
    }

    // Cancel any previous in-flight submit request
    submitAbortRef.current?.abort();
    submitAbortRef.current = new AbortController();

    setSubmitting(true);
    setSubmitError(null);
    setCreatedRequest(null);

    try {
      const record = await apiPost(
        '/api/gdpr/request',
        { credentialId: id, subjectAddress: walletAddress, signature },
        isGdprRequestRecord,
        { signal: submitAbortRef.current.signal },
      );
      setCreatedRequest(record);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setSubmitError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
          ? err.message
          : 'Request failed.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleLookup = async (e: React.FormEvent) => {
    e.preventDefault();
    const id = lookupId.trim();
    if (!id) {
      setLookupError('Enter a request ID.');
      return;
    }

    // Cancel any previous in-flight lookup
    lookupAbortRef.current?.abort();
    lookupAbortRef.current = new AbortController();

    setLookupError(null);
    setLookupResult(null);

    try {
      const record = await apiGet(
        `/api/gdpr/request/${encodeURIComponent(id)}`,
        isGdprRequestRecord,
        { signal: lookupAbortRef.current.signal },
      );
      setLookupResult(record);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setLookupError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
          ? err.message
          : 'Lookup failed.',
      );
    }
  };

  const handleConsent = async (e: React.FormEvent) => {
    e.preventDefault();
    const reqId = consentRequestId.trim();
    const addr = consentAddress.trim();
    if (!reqId || !addr) {
      setConsentError('Both request ID and attestor address are required.');
      return;
    }

    // Cancel any previous in-flight consent request
    consentAbortRef.current?.abort();
    consentAbortRef.current = new AbortController();

    setConsentSubmitting(true);
    setConsentError(null);
    setConsentResult(null);

    try {
      const record = await apiPost(
        '/api/gdpr/consent',
        { requestId: reqId, attestorAddress: addr },
        isGdprRequestRecord,
        { signal: consentAbortRef.current.signal },
      );
      setConsentResult(record);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setConsentError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
          ? err.message
          : 'Consent failed.',
      );
    } finally {
      setConsentSubmitting(false);
    }
  };

  // ── Render helpers ──────────────────────────────────────────────────────────

  const statusBadge = (status: RequestStatus) => {
    if (status === 'anonymized') return <span className="badge badge--green">Anonymized</span>;
    if (status === 'rejected') return <span className="badge badge--red">Rejected</span>;
    return <span className="badge badge--gray">Pending Consent</span>;
  };

  // ── JSX ─────────────────────────────────────────────────────────────────────

  return (
    <>
      <Navbar />
      <main className="container" style={{ paddingBottom: 64 }}>
        <div className="verify-hero">
          <div className="verify-hero__eyebrow">Privacy &amp; Compliance</div>
          <h1 className="verify-hero__title">GDPR Right to be Forgotten</h1>
          <p className="verify-hero__subtitle">
            Request anonymization of a credential. Deletion requires consent from all
            attestors linked to the credential.
          </p>
        </div>

        {/* Issue #1447: wallet-connection notice */}
        {!walletAddress && (
          <div
            className="error-card"
            role="alert"
            aria-live="polite"
            style={{ marginBottom: 24 }}
          >
            <div className="error-card__icon">!</div>
            <div>
              <div className="error-card__title">Wallet not connected</div>
              <div className="error-card__msg">
                Connect your Stellar wallet to prove ownership before submitting an
                anonymization request.
              </div>
            </div>
          </div>
        )}

        {/* Submit request */}
        <section className="search-card" style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>
            Submit Anonymization Request
          </h2>
          <form onSubmit={handleSubmitRequest}>
            <div className="form-group" style={{ marginBottom: 12 }}>
              <label
                htmlFor="gdpr-cred-id"
                style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, display: 'block' }}
              >
                Credential ID *
              </label>
              <input
                id="gdpr-cred-id"
                type="number"
                min="1"
                placeholder="e.g. 42"
                value={credentialId}
                onChange={(e) => setCredentialId(e.target.value)}
                aria-label="Credential ID"
              />
            </div>
            {submitError && (
              <p
                role="alert"
                data-testid="submit-error"
                style={{ color: 'var(--color-red, #f87171)', fontSize: 13, marginBottom: 8 }}
              >
                {submitError}
              </p>
            )}
            <button
              type="submit"
              className="btn btn--primary"
              disabled={submitting || !walletAddress}
              aria-disabled={submitting || !walletAddress}
            >
              {submitting ? 'Signing & Submitting…' : 'Submit Request'}
            </button>
          </form>

          {createdRequest && (
            <div
              style={{
                marginTop: 16,
                padding: 12,
                background: 'var(--color-surface-2, #1e293b)',
                borderRadius: 8,
              }}
            >
              <div style={{ marginBottom: 4, fontSize: 13 }}>
                Request created: <strong>{createdRequest.requestId}</strong>{' '}
                {statusBadge(createdRequest.status)}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Credential #{createdRequest.credentialId} &mdash; requires{' '}
                {createdRequest.requiredConsents} attestor consent(s)
              </div>
            </div>
          )}
        </section>

        {/* Lookup request */}
        <section className="search-card" style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>
            Check Request Status
          </h2>
          <form onSubmit={handleLookup}>
            <div className="form-group" style={{ marginBottom: 12 }}>
              <label
                htmlFor="gdpr-lookup-id"
                style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, display: 'block' }}
              >
                Request ID *
              </label>
              <input
                id="gdpr-lookup-id"
                type="text"
                placeholder="e.g. gdpr_1"
                value={lookupId}
                onChange={(e) => setLookupId(e.target.value)}
                aria-label="GDPR request ID"
              />
            </div>
            {lookupError && (
              <p
                role="alert"
                data-testid="lookup-error"
                style={{ color: 'var(--color-red, #f87171)', fontSize: 13, marginBottom: 8 }}
              >
                {lookupError}
              </p>
            )}
            <button type="submit" className="btn btn--ghost">
              Check Status
            </button>
          </form>

          {lookupResult && (
            <div
              style={{
                marginTop: 16,
                padding: 12,
                background: 'var(--color-surface-2, #1e293b)',
                borderRadius: 8,
              }}
            >
              <div style={{ marginBottom: 4, fontSize: 13 }}>
                {lookupResult.requestId} {statusBadge(lookupResult.status)}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Credential #{lookupResult.credentialId} &mdash; consents:{' '}
                {lookupResult.attestorConsents.length} / {lookupResult.requiredConsents}
              </div>
            </div>
          )}
        </section>

        {/* Attestor consent */}
        <section className="search-card">
          <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>
            Attestor Consent
          </h2>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
            If you are an attestor for a credential under a GDPR request, submit your
            consent here.
          </p>
          <form onSubmit={handleConsent}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                gap: 12,
                marginBottom: 12,
              }}
            >
              <div className="form-group">
                <label
                  htmlFor="gdpr-consent-req"
                  style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, display: 'block' }}
                >
                  Request ID *
                </label>
                <input
                  id="gdpr-consent-req"
                  type="text"
                  placeholder="e.g. gdpr_1"
                  value={consentRequestId}
                  onChange={(e) => setConsentRequestId(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label
                  htmlFor="gdpr-consent-addr"
                  style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, display: 'block' }}
                >
                  Your Attestor Address *
                </label>
                <input
                  id="gdpr-consent-addr"
                  type="text"
                  placeholder="G…"
                  value={consentAddress}
                  onChange={(e) => setConsentAddress(e.target.value)}
                  spellCheck={false}
                />
              </div>
            </div>
            {consentError && (
              <p
                role="alert"
                data-testid="consent-error"
                style={{ color: 'var(--color-red, #f87171)', fontSize: 13, marginBottom: 8 }}
              >
                {consentError}
              </p>
            )}
            <button type="submit" className="btn btn--primary" disabled={consentSubmitting}>
              {consentSubmitting ? 'Submitting…' : 'Submit Consent'}
            </button>
          </form>

          {consentResult && (
            <div
              style={{
                marginTop: 16,
                padding: 12,
                background: 'var(--color-surface-2, #1e293b)',
                borderRadius: 8,
              }}
            >
              <div style={{ marginBottom: 4, fontSize: 13 }}>
                {consentResult.requestId} {statusBadge(consentResult.status)}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Consents: {consentResult.attestorConsents.length} /{' '}
                {consentResult.requiredConsents}
              </div>
            </div>
          )}
        </section>
      </main>

      <footer className="footer">
        <div className="container">
          Powered by{' '}
          <a href="https://stellar.org" target="_blank" rel="noopener">
            Stellar Soroban
          </a>{' '}
          &middot;{' '}
          <a
            href="https://github.com/Phantomcall/QuorumProof"
            target="_blank"
            rel="noopener"
          >
            QuorumProof
          </a>
        </div>
      </footer>
    </>
  );
}
