import { useState, useEffect } from 'react';
import { useWallet } from '../context/WalletContextValue';
import { Navbar } from '../components/Navbar';
import { createSignedGdprRequest } from '../lib/gdprSigning';
import { apiClient, ApiError } from '../lib/apiClient';

type RequestStatus = 'pending_consent' | 'anonymized' | 'rejected';

interface GdprRequestRecord {
  requestId: string;
  credentialId: number;
  requestedAt: string;
  status: RequestStatus;
  attestorConsents: string[];
  requiredConsents: number;
}

// Type validators for responses
const isGdprRequestRecord = (data: any): data is GdprRequestRecord => {
  return (
    typeof data === 'object' &&
    typeof data.requestId === 'string' &&
    typeof data.credentialId === 'number' &&
    typeof data.status === 'string' &&
    Array.isArray(data.attestorConsents) &&
    typeof data.requiredConsents === 'number'
  );
};

export default function GdprRequest() {
  const { address: walletAddress, isConnected } = useWallet();

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

  const [walletMismatch, setWalletMismatch] = useState<string | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      apiClient.cancelRequest('gdpr-submit');
      apiClient.cancelRequest('gdpr-lookup');
      apiClient.cancelRequest('gdpr-consent');
    };
  }, []);

  const handleSubmitRequest = async (e: React.FormEvent) => {
    e.preventDefault();

    const id = parseInt(credentialId.trim(), 10);
    if (!Number.isInteger(id) || id <= 0) {
      setSubmitError('Enter a valid credential ID (positive integer).');
      return;
    }

    if (!isConnected || !walletAddress) {
      setSubmitError('Please connect your wallet first to prove ownership.');
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    setCreatedRequest(null);
    setWalletMismatch(null);

    try {
      // Sign the GDPR request with the wallet to prove ownership
      const signedPayload = await createSignedGdprRequest(id, walletAddress);

      const data = await apiClient.post<GdprRequestRecord>(
        '/api/gdpr/request',
        signedPayload,
        { validator: isGdprRequestRecord, requestKey: 'gdpr-submit' }
      );
      setCreatedRequest(data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setWalletMismatch(err.message);
      }
      const message = err instanceof Error ? err.message : 'Request failed.';
      if (message.includes('signature') || message.includes('User denied')) {
        setSubmitError('Signature request cancelled. Please sign with your wallet to proceed.');
      } else {
        setSubmitError(message);
      }
      }
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
      const data = await apiClient.get<GdprRequestRecord>(
        `/api/gdpr/request/${encodeURIComponent(id)}`,
        { validator: isGdprRequestRecord, requestKey: 'gdpr-lookup' }
      );
      setLookupResult(data);
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
      const data = await apiClient.post<GdprRequestRecord>(
        '/api/gdpr/consent',
        { requestId: reqId, attestorAddress: addr },
        { validator: isGdprRequestRecord, requestKey: 'gdpr-consent' }
      );
      setConsentResult(data);
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
            attestors linked to the credential. Your wallet signature proves ownership.
          </p>
        </div>

        {/* Wallet connection notice */}
        {!isConnected && (
          <div
            style={{
              padding: 12,
              background: 'rgba(249, 115, 22, 0.1)',
              border: '1px solid var(--color-amber, #f59e0b)',
              borderRadius: 8,
              marginBottom: 24,
              fontSize: 13,
              color: 'var(--text-muted)',
            }}
          >
            ⚠️ <strong>Wallet Required:</strong> Connect your wallet to sign GDPR requests and prove you control the credential.
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
            {isConnected && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, padding: 8, background: 'var(--color-surface-2, #1e293b)', borderRadius: 4 }}>
                Connected: <code>{walletAddress?.slice(0, 10)}...{walletAddress?.slice(-6)}</code>
              </div>
            )}
            {walletMismatch && (
              <p style={{ color: 'var(--color-red, #f87171)', fontSize: 13, marginBottom: 8 }}>
                ❌ {walletMismatch}
              </p>
            )}
            {submitError && (
              <p
                role="alert"
                data-testid="submit-error"
                style={{ color: 'var(--color-red, #f87171)', fontSize: 13, marginBottom: 8 }}
              >
                {submitError}
              </p>
            )}
            <button type="submit" className="btn btn--primary" disabled={submitting || !isConnected}>
              {submitting ? 'Signing & Submitting...' : isConnected ? 'Submit Request' : 'Connect Wallet First'}
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
