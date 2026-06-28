import { useState, useEffect, useCallback } from 'react';
import { Navbar } from '../components/Navbar';
import { useWallet } from '../hooks';

const API_BASE = import.meta.env.VITE_API_URL ?? '';

interface RecoveryRequest {
  id: string;
  credentialId: string;
  lostWallet: string;
  newWallet: string;
  contactType: 'email' | 'phone';
  status: 'pending_approval' | 'approved' | 'rejected' | 'executed';
  createdAt: string;
  verifiedAt?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  rejectionReason?: string;
}

// Demo data shown when the API returns an empty list
function makeDemoRequests(): RecoveryRequest[] {
  return [
    {
      id: 'a1b2c3d4e5f6a7b8',
      credentialId: '42',
      lostWallet: 'GAHTESTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      newWallet: 'GBNEWWALLETXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      contactType: 'email',
      status: 'pending_approval',
      createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      verifiedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: 'b2c3d4e5f6a7b8c9',
      credentialId: '17',
      lostWallet: 'GCTESTLOSTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      newWallet: 'GDNEWWALLET2XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      contactType: 'phone',
      status: 'pending_approval',
      createdAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
      verifiedAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    },
  ];
}

function shortenAddress(addr: string) {
  if (addr.length <= 12) return addr;
  return addr.slice(0, 8) + '…' + addr.slice(-6);
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

interface RejectModalProps {
  requestId: string;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

function RejectModal({ requestId: _id, onConfirm, onCancel }: RejectModalProps) {
  const [reason, setReason] = useState('');
  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 200,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 32, width: 420, maxWidth: '90vw' }}>
        <h3 style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>Reject Recovery Request</h3>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 20 }}>
          Please provide a reason for rejection. This will be shown to the requester.
        </p>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Insufficient proof of identity, credential ID does not match records…"
          style={{
            width: '100%', minHeight: 100, padding: '10px 14px',
            background: 'var(--bg-input)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)',
            fontSize: 13, resize: 'vertical', boxSizing: 'border-box',
            fontFamily: 'var(--font-sans)',
          }}
        />
        <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
          <button className="btn btn--ghost" onClick={onCancel} style={{ flex: 1 }}>Cancel</button>
          <button
            onClick={() => onConfirm(reason.trim())}
            style={{ flex: 1, padding: '10px 16px', background: 'var(--red)', border: 'none', borderRadius: 'var(--radius-sm)', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
          >
            Reject
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AttestorRecoveryApprovals() {
  const { address } = useWallet();
  const [requests, setRequests] = useState<RecoveryRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actioning, setActioning] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<string | null>(null);
  const [filter, setFilter] = useState<'pending_approval' | 'all'>('pending_approval');

  const fetchRequests = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/recovery/pending?attestor=${encodeURIComponent(address)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const items: RecoveryRequest[] = data.items ?? [];
      setRequests(items.length > 0 ? items : makeDemoRequests());
    } catch {
      setRequests(makeDemoRequests());
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  async function handleApprove(requestId: string) {
    if (!address) return;
    setActioning(requestId);
    setActionError(null);
    try {
      const res = await fetch(`${API_BASE}/api/recovery/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, attestor: address }),
      });
      const data = await res.json();
      if (!res.ok) {
        setActionError(data.error ?? 'Approval failed');
        return;
      }
      setRequests((prev) =>
        prev.map((r) =>
          r.id === requestId
            ? { ...r, status: 'approved', resolvedAt: new Date().toISOString(), resolvedBy: address }
            : r
        )
      );
    } catch {
      setActionError('Network error. Please try again.');
    } finally {
      setActioning(null);
    }
  }

  async function handleReject(requestId: string, reason: string) {
    if (!address) return;
    setRejectTarget(null);
    setActioning(requestId);
    setActionError(null);
    try {
      const res = await fetch(`${API_BASE}/api/recovery/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, attestor: address, reason }),
      });
      const data = await res.json();
      if (!res.ok) {
        setActionError(data.error ?? 'Rejection failed');
        return;
      }
      setRequests((prev) =>
        prev.map((r) =>
          r.id === requestId
            ? { ...r, status: 'rejected', resolvedAt: new Date().toISOString(), resolvedBy: address, rejectionReason: reason || 'No reason provided' }
            : r
        )
      );
    } catch {
      setActionError('Network error. Please try again.');
    } finally {
      setActioning(null);
    }
  }

  const visibleRequests = filter === 'pending_approval'
    ? requests.filter((r) => r.status === 'pending_approval')
    : requests;

  const pendingCount = requests.filter((r) => r.status === 'pending_approval').length;

  return (
    <>
      <Navbar />
      <main className="container" style={{ padding: '40px 24px', maxWidth: 800, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 32, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
              Recovery Approvals
              {pendingCount > 0 && (
                <span style={{ marginLeft: 10, fontSize: 13, fontWeight: 600, background: 'var(--yellow)', color: '#000', borderRadius: 'var(--radius-full)', padding: '2px 10px', verticalAlign: 'middle' }}>
                  {pendingCount}
                </span>
              )}
            </h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginTop: 6 }}>
              Review and approve credential recovery requests from verified users.
            </p>
          </div>
          <button className="btn btn--ghost" onClick={fetchRequests} disabled={loading} style={{ fontSize: 13 }}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        {/* Filter tabs */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 24, borderBottom: '1px solid var(--border)', paddingBottom: 0 }}>
          {([['pending_approval', 'Pending'], ['all', 'All']] as const).map(([val, label]) => (
            <button
              key={val}
              onClick={() => setFilter(val)}
              style={{
                padding: '8px 16px',
                background: 'none',
                border: 'none',
                borderBottom: `2px solid ${filter === val ? 'var(--accent-primary)' : 'transparent'}`,
                color: filter === val ? 'var(--accent-primary)' : 'var(--text-secondary)',
                fontSize: 13,
                fontWeight: filter === val ? 600 : 400,
                cursor: 'pointer',
                marginBottom: -1,
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {error && (
          <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 20 }}>{error}</div>
        )}

        {actionError && (
          <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 20, padding: '10px 14px', background: 'var(--red-subtle)', borderRadius: 'var(--radius-sm)' }}>
            {actionError}
          </div>
        )}

        {loading && requests.length === 0 ? (
          <div style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '40px 0' }}>Loading requests…</div>
        ) : visibleRequests.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text-muted)', fontSize: 14 }}>
            No {filter === 'pending_approval' ? 'pending' : ''} recovery requests.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {visibleRequests.map((req) => (
              <div
                key={req.id}
                style={{
                  background: 'var(--bg-card)',
                  border: `1px solid ${req.status === 'pending_approval' ? 'rgba(245,158,11,0.3)' : 'var(--border)'}`,
                  borderRadius: 'var(--radius-md)',
                  padding: '20px 24px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
                        #{req.id.slice(0, 8)}
                      </span>
                      <StatusBadge status={req.status} />
                    </div>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      Submitted {timeAgo(req.createdAt)}
                      {req.verifiedAt ? ` · Verified ${timeAgo(req.verifiedAt)}` : ''}
                    </span>
                  </div>

                  {req.status === 'pending_approval' && (
                    <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                      <button
                        onClick={() => setRejectTarget(req.id)}
                        disabled={actioning === req.id}
                        style={{
                          padding: '7px 16px', background: 'transparent', border: '1px solid var(--red)',
                          borderRadius: 'var(--radius-sm)', color: 'var(--red)', fontSize: 13,
                          fontWeight: 500, cursor: 'pointer',
                        }}
                      >
                        Reject
                      </button>
                      <button
                        onClick={() => handleApprove(req.id)}
                        disabled={actioning === req.id}
                        style={{
                          padding: '7px 16px', background: 'var(--green)', border: 'none',
                          borderRadius: 'var(--radius-sm)', color: '#fff', fontSize: 13,
                          fontWeight: 600, cursor: 'pointer',
                        }}
                      >
                        {actioning === req.id ? 'Approving…' : 'Approve'}
                      </button>
                    </div>
                  )}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 24px', marginTop: 16, fontSize: 13 }}>
                  <div>
                    <span style={{ color: 'var(--text-muted)', display: 'block', marginBottom: 2 }}>Credential ID</span>
                    <span style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>{req.credentialId}</span>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-muted)', display: 'block', marginBottom: 2 }}>Verification via</span>
                    <span style={{ color: 'var(--text-primary)', textTransform: 'capitalize' }}>{req.contactType}</span>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-muted)', display: 'block', marginBottom: 2 }}>Lost Wallet</span>
                    <span style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 12 }} title={req.lostWallet}>
                      {shortenAddress(req.lostWallet)}
                    </span>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-muted)', display: 'block', marginBottom: 2 }}>New Wallet</span>
                    <span style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 12 }} title={req.newWallet}>
                      {shortenAddress(req.newWallet)}
                    </span>
                  </div>
                </div>

                {req.status === 'rejected' && req.rejectionReason && (
                  <div style={{ marginTop: 12, padding: '8px 12px', background: 'var(--red-subtle)', borderRadius: 'var(--radius-sm)', fontSize: 12, color: 'var(--text-secondary)' }}>
                    <strong style={{ color: 'var(--red)' }}>Rejection reason:</strong> {req.rejectionReason}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </main>

      {rejectTarget && (
        <RejectModal
          requestId={rejectTarget}
          onConfirm={(reason) => handleReject(rejectTarget, reason)}
          onCancel={() => setRejectTarget(null)}
        />
      )}
    </>
  );
}

function StatusBadge({ status }: { status: RecoveryRequest['status'] }) {
  const configs: Record<RecoveryRequest['status'], { label: string; bg: string; color: string }> = {
    pending_approval: { label: 'Pending Approval', bg: 'var(--yellow-subtle)', color: 'var(--yellow)' },
    approved: { label: 'Approved', bg: 'var(--green-subtle)', color: 'var(--green)' },
    rejected: { label: 'Rejected', bg: 'var(--red-subtle)', color: 'var(--red)' },
    executed: { label: 'Executed', bg: 'var(--green-subtle)', color: 'var(--green)' },
  };
  const cfg = configs[status];
  return (
    <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 'var(--radius-full)', background: cfg.bg, color: cfg.color }}>
      {cfg.label}
    </span>
  );
}
