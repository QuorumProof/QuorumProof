import { useState, useEffect, useRef } from 'react';
import { Navbar } from '../components/Navbar';

const API_BASE = import.meta.env.VITE_API_URL ?? '';

const STELLAR_RE = /^G[A-Z2-7]{55}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[1-9]\d{7,14}$/;

type Step = 1 | 2 | 3 | 4;
type ContactType = 'email' | 'phone';

interface RecoveryStatusData {
  id: string;
  credentialId: string;
  lostWallet: string;
  newWallet: string;
  contactType: ContactType;
  status: 'pending_verification' | 'verified' | 'pending_approval' | 'approved' | 'rejected' | 'executed';
  createdAt: string;
  verifiedAt?: string;
  resolvedAt?: string;
  rejectionReason?: string;
}

function StepIndicator({ step, current }: { step: number; current: Step }) {
  const done = current > step;
  const active = current === step;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 13,
          fontWeight: 600,
          background: done ? 'var(--green)' : active ? 'var(--accent-primary)' : 'var(--bg-input)',
          color: done || active ? '#fff' : 'var(--text-muted)',
          border: `2px solid ${done ? 'var(--green)' : active ? 'var(--accent-primary)' : 'var(--border)'}`,
          transition: 'all 0.2s',
        }}
      >
        {done ? '✓' : step}
      </div>
    </div>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <span style={{ color: 'var(--red)', fontSize: 12, marginTop: 4 }}>{message}</span>;
}

const STATUS_LABELS: Record<RecoveryStatusData['status'], string> = {
  pending_verification: 'Pending Verification',
  verified: 'Identity Verified',
  pending_approval: 'Awaiting Attestor Approval',
  approved: 'Approved',
  rejected: 'Rejected',
  executed: 'Credential Re-issued',
};

const STATUS_COLORS: Record<RecoveryStatusData['status'], string> = {
  pending_verification: 'var(--yellow)',
  verified: 'var(--blue)',
  pending_approval: 'var(--yellow)',
  approved: 'var(--green)',
  rejected: 'var(--red)',
  executed: 'var(--green)',
};

export default function CredentialRecovery() {
  const [step, setStep] = useState<Step>(1);

  // Step 1 fields
  const [lostWallet, setLostWallet] = useState('');
  const [credentialId, setCredentialId] = useState('');
  const [s1Errors, setS1Errors] = useState<{ lostWallet?: string; credentialId?: string }>({});

  // Step 2 fields
  const [newWallet, setNewWallet] = useState('');
  const [contactType, setContactType] = useState<ContactType>('email');
  const [contactValue, setContactValue] = useState('');
  const [s2Errors, setS2Errors] = useState<{ newWallet?: string; contactValue?: string }>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Step 3 OTP
  const [requestId, setRequestId] = useState<string | null>(null);
  const [otp, setOtp] = useState('');
  const [otpError, setOtpError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendMsg, setResendMsg] = useState<string | null>(null);
  const [resendCooldown, setResendCooldown] = useState(0);
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Step 4 status
  const [statusData, setStatusData] = useState<RecoveryStatusData | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (cooldownRef.current) clearInterval(cooldownRef.current);
    };
  }, []);

  // Poll status on step 4
  useEffect(() => {
    if (step !== 4 || !requestId) return;

    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/recovery/status/${requestId}`);
        if (!res.ok) return;
        const data: RecoveryStatusData = await res.json();
        setStatusData(data);
        if (data.status === 'approved' || data.status === 'rejected' || data.status === 'executed') {
          if (pollRef.current) clearInterval(pollRef.current);
        }
      } catch {
        setStatusError('Could not refresh status. Will retry.');
      }
    };

    poll();
    pollRef.current = setInterval(poll, 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [step, requestId]);

  function validateStep1() {
    const errors: typeof s1Errors = {};
    if (!STELLAR_RE.test(lostWallet.trim())) errors.lostWallet = 'Enter a valid Stellar address (starts with G, 56 chars)';
    if (!credentialId.trim()) errors.credentialId = 'Credential ID is required';
    setS1Errors(errors);
    return Object.keys(errors).length === 0;
  }

  function validateStep2() {
    const errors: typeof s2Errors = {};
    if (!STELLAR_RE.test(newWallet.trim())) errors.newWallet = 'Enter a valid Stellar address (starts with G, 56 chars)';
    if (newWallet.trim() === lostWallet.trim()) errors.newWallet = 'New wallet must differ from the lost wallet';
    if (contactType === 'email' && !EMAIL_RE.test(contactValue.trim())) errors.contactValue = 'Enter a valid email address';
    if (contactType === 'phone' && !PHONE_RE.test(contactValue.trim())) errors.contactValue = 'Enter a valid phone number with country code (e.g. +1234567890)';
    setS2Errors(errors);
    return Object.keys(errors).length === 0;
  }

  function startResendCooldown() {
    setResendCooldown(60);
    cooldownRef.current = setInterval(() => {
      setResendCooldown((c) => {
        if (c <= 1) {
          if (cooldownRef.current) clearInterval(cooldownRef.current);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
  }

  async function handleStep2Submit() {
    if (!validateStep2()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`${API_BASE}/api/recovery/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credentialId: credentialId.trim(),
          lostWallet: lostWallet.trim(),
          newWallet: newWallet.trim(),
          contactType,
          contactValue: contactValue.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSubmitError(data.error ?? 'Failed to submit request');
        return;
      }
      setRequestId(data.requestId);
      startResendCooldown();
      setStep(3);
    } catch {
      setSubmitError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVerifyOtp() {
    if (!otp.trim() || !requestId) return;
    setVerifying(true);
    setOtpError(null);
    try {
      const res = await fetch(`${API_BASE}/api/recovery/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, code: otp.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setOtpError(data.error ?? 'Verification failed');
        return;
      }
      setStep(4);
    } catch {
      setOtpError('Network error. Please try again.');
    } finally {
      setVerifying(false);
    }
  }

  async function handleResend() {
    if (!requestId || resendCooldown > 0) return;
    setResending(true);
    setResendMsg(null);
    try {
      const res = await fetch(`${API_BASE}/api/recovery/resend-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setResendMsg(data.error ?? 'Failed to resend');
        return;
      }
      setResendMsg(data.message);
      startResendCooldown();
    } catch {
      setResendMsg('Network error. Please try again.');
    } finally {
      setResending(false);
    }
  }

  const cardStyle: React.CSSProperties = {
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-lg)',
    padding: '32px',
    maxWidth: 560,
    margin: '0 auto',
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '10px 14px',
    background: 'var(--bg-input)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text-primary)',
    fontSize: 14,
    fontFamily: 'var(--font-sans)',
    outline: 'none',
    boxSizing: 'border-box',
  };

  const labelStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    fontSize: 13,
    color: 'var(--text-secondary)',
    fontWeight: 500,
  };

  return (
    <>
      <Navbar />
      <main className="container" style={{ padding: '48px 24px' }}>
        <div style={{ textAlign: 'center', marginBottom: 40 }}>
          <h1 style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
            Credential Recovery
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: 8, fontSize: 15 }}>
            Recover credentials from a lost wallet via identity verification and attestor approval.
          </p>
        </div>

        {/* Step indicator */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0, marginBottom: 40 }}>
          {([1, 2, 3, 4] as const).map((s, i) => (
            <div key={s} style={{ display: 'flex', alignItems: 'center' }}>
              <StepIndicator step={s} current={step} />
              {i < 3 && (
                <div style={{ width: 48, height: 2, background: step > s ? 'var(--green)' : 'var(--border)', margin: '0 4px' }} />
              )}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 0, marginBottom: 32, marginTop: -24 }}>
          {(['Lost Wallet', 'New Wallet', 'Verify', 'Status'] as const).map((label, i) => (
            <div key={label} style={{ width: i < 3 ? 'calc(48px + 48px)' : '48px', textAlign: 'center', fontSize: 11, color: step === i + 1 ? 'var(--accent-primary)' : 'var(--text-muted)', fontWeight: step === i + 1 ? 600 : 400 }}>
              {label}
            </div>
          ))}
        </div>

        {/* Step 1: Lost wallet info */}
        {step === 1 && (
          <div style={cardStyle}>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
              Lost Wallet Information
            </h2>
            <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 24 }}>
              Enter the wallet address you no longer have access to and the credential you want to recover.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <label style={labelStyle}>
                Lost Wallet Address
                <input
                  style={{ ...inputStyle, borderColor: s1Errors.lostWallet ? 'var(--red)' : 'var(--border)', fontFamily: 'var(--font-mono)', fontSize: 12 }}
                  placeholder="GABC...XYZ (56-character Stellar address)"
                  value={lostWallet}
                  onChange={(e) => { setLostWallet(e.target.value); setS1Errors((p) => ({ ...p, lostWallet: undefined })); }}
                  aria-invalid={!!s1Errors.lostWallet}
                  autoComplete="off"
                  spellCheck={false}
                />
                <FieldError message={s1Errors.lostWallet} />
              </label>
              <label style={labelStyle}>
                Credential ID
                <input
                  style={{ ...inputStyle, borderColor: s1Errors.credentialId ? 'var(--red)' : 'var(--border)' }}
                  placeholder="e.g. 42 or abc123"
                  value={credentialId}
                  onChange={(e) => { setCredentialId(e.target.value); setS1Errors((p) => ({ ...p, credentialId: undefined })); }}
                  aria-invalid={!!s1Errors.credentialId}
                />
                <FieldError message={s1Errors.credentialId} />
              </label>
              <div style={{ background: 'var(--blue-subtle)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', fontSize: 13, color: 'var(--text-secondary)' }}>
                You can find your Credential ID in any previous export, share link, or by asking the original issuer.
              </div>
              <button
                className="btn btn--primary"
                onClick={() => { if (validateStep1()) setStep(2); }}
                style={{ marginTop: 8 }}
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {/* Step 2: New wallet + contact */}
        {step === 2 && (
          <div style={cardStyle}>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
              New Wallet & Contact Details
            </h2>
            <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 24 }}>
              The recovered credential will be re-issued to your new wallet after verification.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <label style={labelStyle}>
                New Wallet Address
                <input
                  style={{ ...inputStyle, borderColor: s2Errors.newWallet ? 'var(--red)' : 'var(--border)', fontFamily: 'var(--font-mono)', fontSize: 12 }}
                  placeholder="GABC...XYZ (56-character Stellar address)"
                  value={newWallet}
                  onChange={(e) => { setNewWallet(e.target.value); setS2Errors((p) => ({ ...p, newWallet: undefined })); }}
                  aria-invalid={!!s2Errors.newWallet}
                  autoComplete="off"
                  spellCheck={false}
                />
                <FieldError message={s2Errors.newWallet} />
              </label>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)', fontWeight: 500 }}>Verification Method</span>
                <div style={{ display: 'flex', gap: 12 }}>
                  {(['email', 'phone'] as ContactType[]).map((t) => (
                    <button
                      key={t}
                      onClick={() => { setContactType(t); setContactValue(''); setS2Errors((p) => ({ ...p, contactValue: undefined })); }}
                      style={{
                        flex: 1,
                        padding: '10px',
                        background: contactType === t ? 'var(--accent-primary)' : 'var(--bg-input)',
                        border: `1px solid ${contactType === t ? 'var(--accent-primary)' : 'var(--border)'}`,
                        borderRadius: 'var(--radius-sm)',
                        color: contactType === t ? '#fff' : 'var(--text-secondary)',
                        fontSize: 13,
                        fontWeight: 500,
                        cursor: 'pointer',
                        transition: 'all 0.15s',
                      }}
                    >
                      {t === 'email' ? 'Email' : 'Phone (SMS)'}
                    </button>
                  ))}
                </div>
              </div>

              <label style={labelStyle}>
                {contactType === 'email' ? 'Email Address' : 'Phone Number'}
                <input
                  style={{ ...inputStyle, borderColor: s2Errors.contactValue ? 'var(--red)' : 'var(--border)' }}
                  type={contactType === 'email' ? 'email' : 'tel'}
                  placeholder={contactType === 'email' ? 'you@example.com' : '+1234567890'}
                  value={contactValue}
                  onChange={(e) => { setContactValue(e.target.value); setS2Errors((p) => ({ ...p, contactValue: undefined })); }}
                  aria-invalid={!!s2Errors.contactValue}
                />
                <FieldError message={s2Errors.contactValue} />
              </label>

              {submitError && (
                <div style={{ color: 'var(--red)', fontSize: 13, padding: '10px 14px', background: 'var(--red-subtle)', borderRadius: 'var(--radius-sm)' }}>
                  {submitError}
                </div>
              )}

              <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                <button className="btn btn--ghost" onClick={() => setStep(1)} style={{ flex: 1 }}>
                  Back
                </button>
                <button
                  className="btn btn--primary"
                  onClick={handleStep2Submit}
                  disabled={submitting}
                  style={{ flex: 2 }}
                >
                  {submitting ? 'Sending code…' : 'Send Verification Code'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Step 3: OTP verification */}
        {step === 3 && (
          <div style={cardStyle}>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
              Verify Your Identity
            </h2>
            <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 24 }}>
              Enter the 6-digit code sent to your {contactType === 'email' ? 'email' : 'phone'}.
              The code expires in 10 minutes.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <label style={labelStyle}>
                Verification Code
                <input
                  style={{ ...inputStyle, textAlign: 'center', letterSpacing: '0.3em', fontSize: 24, fontFamily: 'var(--font-mono)', borderColor: otpError ? 'var(--red)' : 'var(--border)' }}
                  maxLength={6}
                  placeholder="______"
                  value={otp}
                  onChange={(e) => { setOtp(e.target.value.replace(/\D/g, '')); setOtpError(null); }}
                  aria-invalid={!!otpError}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                />
                {otpError && <span style={{ color: 'var(--red)', fontSize: 12 }}>{otpError}</span>}
              </label>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13 }}>
                <span style={{ color: 'var(--text-muted)' }}>Didn't receive it?</span>
                <button
                  onClick={handleResend}
                  disabled={resending || resendCooldown > 0}
                  style={{ background: 'none', border: 'none', cursor: resendCooldown > 0 ? 'default' : 'pointer', color: resendCooldown > 0 ? 'var(--text-muted)' : 'var(--accent-primary)', fontSize: 13, padding: 0 }}
                >
                  {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : resending ? 'Sending…' : 'Resend code'}
                </button>
              </div>

              {resendMsg && (
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', padding: '8px 12px', background: 'var(--bg-input)', borderRadius: 'var(--radius-sm)' }}>
                  {resendMsg}
                </div>
              )}

              <button
                className="btn btn--primary"
                onClick={handleVerifyOtp}
                disabled={verifying || otp.length < 6}
                style={{ marginTop: 8 }}
              >
                {verifying ? 'Verifying…' : 'Verify Code'}
              </button>
            </div>
          </div>
        )}

        {/* Step 4: Status */}
        {step === 4 && (
          <div style={cardStyle}>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
              Recovery Request Submitted
            </h2>

            {!statusData ? (
              <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>Loading status…</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px', background: 'var(--bg-input)', borderRadius: 'var(--radius-md)' }}>
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: STATUS_COLORS[statusData.status], flexShrink: 0 }} />
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>{STATUS_LABELS[statusData.status]}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>Request ID: {statusData.id}</div>
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Credential ID</span>
                    <span style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>{statusData.credentialId}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                    <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>Lost Wallet</span>
                    <span style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 11, wordBreak: 'break-all', textAlign: 'right' }}>{statusData.lostWallet}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                    <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>New Wallet</span>
                    <span style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 11, wordBreak: 'break-all', textAlign: 'right' }}>{statusData.newWallet}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Submitted</span>
                    <span style={{ color: 'var(--text-primary)' }}>{new Date(statusData.createdAt).toLocaleString()}</span>
                  </div>
                  {statusData.verifiedAt && (
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--text-muted)' }}>Verified</span>
                      <span style={{ color: 'var(--green)' }}>{new Date(statusData.verifiedAt).toLocaleString()}</span>
                    </div>
                  )}
                  {statusData.resolvedAt && (
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--text-muted)' }}>Resolved</span>
                      <span style={{ color: 'var(--text-primary)' }}>{new Date(statusData.resolvedAt).toLocaleString()}</span>
                    </div>
                  )}
                </div>

                {statusData.status === 'pending_approval' && (
                  <div style={{ background: 'var(--yellow-subtle)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', fontSize: 13, color: 'var(--text-secondary)' }}>
                    Your identity has been verified. An attestor is reviewing your request. This page refreshes automatically every 5 seconds.
                  </div>
                )}

                {statusData.status === 'approved' && (
                  <div style={{ background: 'var(--green-subtle)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', fontSize: 13, color: 'var(--text-secondary)' }}>
                    Your recovery request was approved. The credential will be re-issued to your new wallet shortly.
                  </div>
                )}

                {statusData.status === 'rejected' && (
                  <div style={{ background: 'var(--red-subtle)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', fontSize: 13, color: 'var(--text-secondary)' }}>
                    <strong style={{ color: 'var(--red)' }}>Request rejected.</strong>{' '}
                    {statusData.rejectionReason ?? 'No reason provided.'} Please contact the original credential issuer for assistance.
                  </div>
                )}

                {statusError && (
                  <div style={{ color: 'var(--red)', fontSize: 13 }}>{statusError}</div>
                )}
              </div>
            )}
          </div>
        )}
      </main>
    </>
  );
}
