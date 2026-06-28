import { useState, useRef } from 'react';
import { Navbar } from '../components/Navbar';
import { useWallet } from '../hooks';
import { formatAddress } from '../lib/credentialUtils';

interface StudentRow {
  studentId: string;
  stellarAddress: string;
  credentialType: string;
  valid: boolean;
}

const CREDENTIAL_TYPES = [
  { value: '1', label: 'Bachelor Degree' },
  { value: '2', label: 'Master Degree' },
  { value: '3', label: 'Doctorate' },
  { value: '4', label: 'Diploma' },
  { value: '5', label: 'Certificate' },
];

function parseCSV(text: string): StudentRow[] {
  const lines = text.trim().split('\n').filter(Boolean);
  const dataLines = lines[0]?.toLowerCase().includes('studentid') ? lines.slice(1) : lines;
  return dataLines.map((line) => {
    const [studentId = '', stellarAddress = '', credentialType = '1'] = line.split(',').map((s) => s.trim());
    const valid =
      studentId.length > 0 &&
      stellarAddress.startsWith('G') &&
      stellarAddress.length >= 56;
    return { studentId, stellarAddress, credentialType: credentialType || '1', valid };
  });
}

export default function UniversityRegistration() {
  const { address } = useWallet();

  // Registration form state
  const [universityName, setUniversityName] = useState('');
  const [country, setCountry] = useState('');
  const [accreditationBody, setAccreditationBody] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [registrationSubmitted, setRegistrationSubmitted] = useState(false);
  const [registrationMsg, setRegistrationMsg] = useState<string | null>(null);

  // Batch import state
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Manual row state
  const [manualId, setManualId] = useState('');
  const [manualAddr, setManualAddr] = useState('');
  const [manualType, setManualType] = useState('1');

  const [activeTab, setActiveTab] = useState<'register' | 'import'>('register');

  const handleRegister = () => {
    if (!universityName.trim()) {
      setRegistrationMsg('University name is required.');
      return;
    }
    if (!country.trim()) {
      setRegistrationMsg('Country is required.');
      return;
    }
    if (!accreditationBody.trim()) {
      setRegistrationMsg('Accreditation body is required.');
      return;
    }
    if (!contactEmail.trim() || !contactEmail.includes('@')) {
      setRegistrationMsg('A valid contact email is required.');
      return;
    }
    setRegistrationSubmitted(true);
    setRegistrationMsg(null);
  };

  const handleCSVUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCsvError(null);
    setImportMsg(null);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      if (!text) {
        setCsvError('File appears to be empty.');
        return;
      }
      const rows = parseCSV(text);
      if (rows.length === 0) {
        setCsvError('No rows found. Expected: studentId,stellarAddress,credentialType');
        return;
      }
      setStudents(rows);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleAddManual = () => {
    if (!manualId.trim()) return;
    if (!manualAddr.startsWith('G') || manualAddr.length < 56) {
      setCsvError('Invalid Stellar address.');
      return;
    }
    setCsvError(null);
    setStudents((prev) => [
      ...prev,
      { studentId: manualId.trim(), stellarAddress: manualAddr.trim(), credentialType: manualType, valid: true },
    ]);
    setManualId('');
    setManualAddr('');
    setManualType('1');
  };

  const handleRemoveRow = (idx: number) => {
    setStudents((prev) => prev.filter((_, i) => i !== idx));
  };

  const validRows = students.filter((s) => s.valid);

  const handleImport = async () => {
    if (validRows.length === 0) {
      setImportMsg('No valid student rows to import.');
      return;
    }
    setImporting(true);
    setImportMsg(null);
    // Simulate on-chain batch — actual issuance requires individual signed transactions per credential
    await new Promise((r) => setTimeout(r, 600));
    setImportMsg(
      `✅ ${validRows.length} credential issuance${validRows.length !== 1 ? 's' : ''} prepared. ` +
        `Each requires an on-chain transaction signed by the issuer (${formatAddress(address ?? '')}).`
    );
    setImporting(false);
  };

  if (!address) {
    return (
      <>
        <Navbar />
        <main className="container">
          <div className="empty-state">
            <div className="empty-state__icon">🔒</div>
            <div className="empty-state__title">Wallet Required</div>
            <p>Connect your wallet to register your university as an issuer.</p>
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <Navbar />
      <main className="container" style={{ paddingBottom: 64 }}>
        <header className="dashboard-header">
          <div>
            <h1 className="dashboard-title">University Registration</h1>
            <p className="dashboard-subtitle">
              Register your institution as a credential issuer and bulk-import student records
            </p>
          </div>
        </header>

        <div className="search-card__tabs" role="tablist" style={{ marginBottom: 24 }}>
          <button
            className={`tab-btn${activeTab === 'register' ? ' active' : ''}`}
            role="tab"
            aria-selected={activeTab === 'register'}
            onClick={() => setActiveTab('register')}
          >
            🏫 Register Institution
          </button>
          <button
            className={`tab-btn${activeTab === 'import' ? ' active' : ''}`}
            role="tab"
            aria-selected={activeTab === 'import'}
            onClick={() => setActiveTab('import')}
          >
            📥 Batch Student Import
          </button>
        </div>

        {/* Registration Tab */}
        {activeTab === 'register' && (
          <div className="detail-card">
            <div className="detail-card__header">
              <span className="detail-card__title">INSTITUTION DETAILS</span>
            </div>
            <div className="detail-card__body">
              {registrationSubmitted ? (
                <div style={{ padding: '16px 0' }}>
                  <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>
                    ✅ Registration Submitted
                  </div>
                  <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>
                    <strong>{universityName}</strong> has been registered as a credential issuer linked to{' '}
                    <code style={{ fontSize: 12 }}>{formatAddress(address)}</code>. To finalise on-chain,
                    call <code>register_issuer</code> via the Soroban CLI:
                  </p>
                  <pre
                    style={{
                      background: 'var(--bg-tertiary, #1e293b)',
                      padding: '12px 16px',
                      borderRadius: 6,
                      fontSize: 12,
                      overflowX: 'auto',
                      marginTop: 12,
                    }}
                  >
                    {`soroban contract invoke \\
  --id $CONTRACT_QUORUM_PROOF --network testnet \\
  --source-account admin_key.json \\
  -- register_issuer \\
  --admin $ADMIN_ADDRESS \\
  --issuer ${address} \\
  --issuer-type University`}
                  </pre>
                  <button
                    className="btn btn--ghost btn--sm"
                    style={{ marginTop: 12 }}
                    onClick={() => setRegistrationSubmitted(false)}
                  >
                    Edit details
                  </button>
                </div>
              ) : (
                <div style={{ display: 'grid', gap: 16 }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
                    University / Institution Name *
                    <input
                      className="input"
                      type="text"
                      placeholder="e.g. University of Cape Town"
                      value={universityName}
                      onChange={(e) => setUniversityName(e.target.value)}
                      aria-label="University name"
                    />
                  </label>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
                    Country *
                    <input
                      className="input"
                      type="text"
                      placeholder="e.g. South Africa"
                      value={country}
                      onChange={(e) => setCountry(e.target.value)}
                      aria-label="Country"
                    />
                  </label>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
                    Accreditation Body *
                    <input
                      className="input"
                      type="text"
                      placeholder="e.g. Council on Higher Education (CHE)"
                      value={accreditationBody}
                      onChange={(e) => setAccreditationBody(e.target.value)}
                      aria-label="Accreditation body"
                    />
                  </label>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
                    Contact Email *
                    <input
                      className="input"
                      type="email"
                      placeholder="registrar@university.edu"
                      value={contactEmail}
                      onChange={(e) => setContactEmail(e.target.value)}
                      aria-label="Contact email"
                    />
                  </label>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
                    Issuer Wallet Address
                    <input
                      className="input"
                      type="text"
                      value={address}
                      readOnly
                      aria-label="Connected wallet address"
                      style={{ opacity: 0.7, cursor: 'not-allowed' }}
                    />
                  </label>

                  {registrationMsg && (
                    <p style={{ fontSize: 13, color: 'var(--color-error, #ef4444)' }}>{registrationMsg}</p>
                  )}

                  <button className="btn btn--primary" onClick={handleRegister}>
                    Register Institution
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Batch Import Tab */}
        {activeTab === 'import' && (
          <>
            <div className="detail-card" style={{ marginBottom: 16 }}>
              <div className="detail-card__header">
                <span className="detail-card__title">UPLOAD CSV</span>
              </div>
              <div className="detail-card__body">
                <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
                  CSV format: <code>studentId,stellarAddress,credentialType</code>
                  <br />
                  The header row is optional. Credential types: 1=Bachelor, 2=Master, 3=Doctorate, 4=Diploma, 5=Certificate
                </p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn btn--ghost btn--sm" onClick={() => fileRef.current?.click()}>
                    📂 Upload CSV
                  </button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".csv,text/csv"
                    style={{ display: 'none' }}
                    onChange={handleCSVUpload}
                    aria-label="Upload CSV file"
                  />
                </div>
                {csvError && (
                  <p style={{ fontSize: 13, color: 'var(--color-error, #ef4444)', marginTop: 8 }}>{csvError}</p>
                )}
              </div>
            </div>

            <div className="detail-card" style={{ marginBottom: 16 }}>
              <div className="detail-card__header">
                <span className="detail-card__title">ADD STUDENT MANUALLY</span>
              </div>
              <div className="detail-card__body">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 1fr auto', gap: 8, alignItems: 'end' }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                    Student ID
                    <input
                      className="input"
                      type="text"
                      placeholder="STU-2024-001"
                      value={manualId}
                      onChange={(e) => setManualId(e.target.value)}
                      aria-label="Student ID"
                    />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                    Stellar Address
                    <input
                      className="input"
                      type="text"
                      placeholder="GABC…"
                      value={manualAddr}
                      onChange={(e) => setManualAddr(e.target.value)}
                      aria-label="Student Stellar address"
                      spellCheck={false}
                    />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                    Credential Type
                    <select
                      className="input"
                      value={manualType}
                      onChange={(e) => setManualType(e.target.value)}
                      aria-label="Credential type"
                    >
                      {CREDENTIAL_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>{t.label}</option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="btn btn--primary btn--sm"
                    onClick={handleAddManual}
                    aria-label="Add student row"
                  >
                    Add
                  </button>
                </div>
              </div>
            </div>

            {students.length > 0 && (
              <div className="detail-card" style={{ marginBottom: 16 }}>
                <div className="detail-card__header">
                  <span className="detail-card__title">STUDENT RECORDS ({students.length})</span>
                  <span className="badge badge--blue">{validRows.length} valid</span>
                </div>
                <div className="detail-card__body" style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-color, #334155)' }}>
                        <th style={{ padding: '6px 8px', color: 'var(--text-muted)' }}>Student ID</th>
                        <th style={{ padding: '6px 8px', color: 'var(--text-muted)' }}>Stellar Address</th>
                        <th style={{ padding: '6px 8px', color: 'var(--text-muted)' }}>Credential</th>
                        <th style={{ padding: '6px 8px', color: 'var(--text-muted)' }}>Status</th>
                        <th style={{ padding: '6px 8px' }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {students.map((row, i) => (
                        <tr
                          key={i}
                          style={{
                            borderBottom: '1px solid var(--border-color, #334155)',
                            background: row.valid ? 'transparent' : 'rgba(239,68,68,0.05)',
                          }}
                        >
                          <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{row.studentId}</td>
                          <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>
                            {row.stellarAddress.length > 12
                              ? row.stellarAddress.slice(0, 6) + '…' + row.stellarAddress.slice(-6)
                              : row.stellarAddress || '—'}
                          </td>
                          <td style={{ padding: '6px 8px' }}>
                            {CREDENTIAL_TYPES.find((t) => t.value === row.credentialType)?.label ?? row.credentialType}
                          </td>
                          <td style={{ padding: '6px 8px' }}>
                            {row.valid ? (
                              <span style={{ color: '#22c55e' }}>✓ Valid</span>
                            ) : (
                              <span style={{ color: '#ef4444' }}>✗ Invalid address</span>
                            )}
                          </td>
                          <td style={{ padding: '6px 8px' }}>
                            <button
                              className="btn btn--ghost btn--sm"
                              style={{ padding: '2px 6px', fontSize: 11 }}
                              onClick={() => handleRemoveRow(i)}
                              aria-label={`Remove row ${i + 1}`}
                            >
                              ✕
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                className="btn btn--primary"
                onClick={handleImport}
                disabled={importing || validRows.length === 0}
                aria-label="Prepare batch credential issuance"
              >
                {importing ? '⏳ Preparing…' : `🚀 Issue Credentials (${validRows.length})`}
              </button>
              {students.length > 0 && (
                <button
                  className="btn btn--ghost btn--sm"
                  onClick={() => { setStudents([]); setImportMsg(null); }}
                  aria-label="Clear student list"
                >
                  Clear All
                </button>
              )}
              {importMsg && (
                <p style={{ fontSize: 13, color: importMsg.startsWith('✅') ? '#22c55e' : '#ef4444', margin: 0 }}>
                  {importMsg}
                </p>
              )}
            </div>
          </>
        )}
      </main>

      <footer className="footer">
        <div className="container">
          Powered by{' '}
          <a href="https://stellar.org" target="_blank" rel="noopener">Stellar Soroban</a>
          {' · '}
          <a href="https://github.com/Phantomcall/QuorumProof" target="_blank" rel="noopener">QuorumProof</a>
        </div>
      </footer>
    </>
  );
}
