import { useState } from 'react';
import { Navbar } from '../components/Navbar';

type RequestStatus = 'pending_consent' | 'anonymized' | 'rejected';

interface GdprRequestRecord {
  requestId: string;
  credentialId: number;
  requestedAt: string;
  status: RequestStatus;
  attestorConsents: string[];
  requiredConsents: number;
}

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export default function GdprRequest() {
  const [credentialId, setCredentialId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [createdRequest, setCreatedRequest] = useState<GdprRequestRecord | null>(null);

  const [lookupId, setLookupId] = useState('');
  const [lookupResult, setLookupResult] = useState<GdprRequestRecord | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const [consentRequestId, setConsentRequestId] = useState('');
  const [consentAddress, setConsentAddress] = useState('');
  const [consentSubmitting, setConsentSubmitting] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [consentResult, setConsentResult] = useState<GdprRequestRecord | null>(null);

  const handleSubmitRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    const id = parseInt(credentialId.trim(), 10);
    if (!Number.isInteger(id) || id <= 0) {
      setSubmitError('Enter a valid credential ID (positive integer).');
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    setCreatedRequest(null);

    try {
      const res = await fetch(`${API_BASE}/api/gdpr/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credentialId: id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Request failed');
      setCreatedRequest(data as GdprRequestRecord);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Request failed.');
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
    setLookupError(null);
    setLookupResult(null);
    try {
      const res = await fetch(`${API_BASE}/api/gdpr/request/${encodeURIComponent(id)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Not found');
      setLookupResult(data as GdprRequestRecord);
    } catch (err) {
      setLookupError(err instanceof Error ? err.message : 'Lookup failed.');
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

    setConsentSubmitting(true);
    setConsentError(null);
    setConsentResult(null);

    try {
      const res = await fetch(`${API_BASE}/api/gdpr/consent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: reqId, attestorAddress: addr }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Consent failed');
      setConsentResult(data as GdprRequestRecord);
    } catch (err) {
      setConsentError(err instanceof Error ? err.message : 'Consent failed.');
    } finally {
      setConsentSubmitting(false);
    }
  };

  const statusBadge = (status: RequestStatus) => {
    if (status === 'anonymized') return <span className="badge badge--green">Anonymized</span>;
    if (status === 'rejected') return <span className="badge badge--red">Rejected</span>;
    return <span className="badge badge--gray">Pending Consent</span>;
  };

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
              <p style={{ color: 'var(--color-red, #f87171)', fontSize: 13, marginBottom: 8 }}>
                {submitError}
              </p>
            )}
            <button type="submit" className="btn btn--primary" disabled={submitting}>
              {submitting ? 'Submitting...' : 'Submit Request'}
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
              <p style={{ color: 'var(--color-red, #f87171)', fontSize: 13, marginBottom: 8 }}>
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
              <p style={{ color: 'var(--color-red, #f87171)', fontSize: 13, marginBottom: 8 }}>
                {consentError}
              </p>
            )}
            <button type="submit" className="btn btn--primary" disabled={consentSubmitting}>
              {consentSubmitting ? 'Submitting...' : 'Submit Consent'}
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
