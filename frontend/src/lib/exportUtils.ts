import type { Credential } from './contracts/quorumProof';
import { credTypeLabel, formatTimestamp } from './credentialUtils';

export interface ExportOptions {
  format: 'json' | 'csv' | 'pdf';
  includeMetadata?: boolean;
}

export function exportToJSON(credentials: Credential[]): string {
  const data = credentials.map(cred => ({
    id: cred.id.toString(),
    subject: cred.subject,
    issuer: cred.issuer,
    type: credTypeLabel(cred.credential_type),
    metadataHash: Buffer.from(cred.metadata_hash).toString('hex'),
    revoked: cred.revoked,
    expiresAt: cred.expires_at ? formatTimestamp(cred.expires_at) : null,
    issuedAt: new Date().toISOString(),
  }));
  return JSON.stringify(data, null, 2);
}

export function exportToCSV(credentials: Credential[]): string {
  const headers = ['ID', 'Subject', 'Issuer', 'Type', 'Metadata Hash', 'Revoked', 'Expires At'];
  const rows = credentials.map(cred => [
    cred.id.toString(),
    cred.subject,
    cred.issuer,
    credTypeLabel(cred.credential_type),
    Buffer.from(cred.metadata_hash).toString('hex'),
    cred.revoked ? 'Yes' : 'No',
    cred.expires_at ? formatTimestamp(cred.expires_at) : 'Never',
  ]);

  const csvContent = [
    headers.join(','),
    ...rows.map(row => row.map(cell => `"${cell}"`).join(',')),
  ].join('\n');

  return csvContent;
}

export function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function buildQrUrl(credentialId: string, baseUrl = window.location.origin): string {
  const verifyUrl = encodeURIComponent(`${baseUrl}/verify?id=${credentialId}`);
  return `https://chart.googleapis.com/chart?cht=qr&chs=300x300&chl=${verifyUrl}`;
}

function credentialTemplate(credential: Credential, id: string, qrUrl: string, verifyUrl: string): string {
  const isRevoked = credential.revoked;
  const typeLabel = credTypeLabel(credential.credential_type);
  const metadataHex = Buffer.from(credential.metadata_hash).toString('hex');
  const expiresAt = credential.expires_at ? formatTimestamp(credential.expires_at) : 'Never';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>QuorumProof Credential #${id}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', -apple-system, sans-serif;
      background: #0f172a;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      padding: 32px;
    }
    .credential {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 16px;
      max-width: 800px;
      width: 100%;
      overflow: hidden;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    }
    .header {
      background: linear-gradient(135deg, #6366f1, #4f46e5);
      padding: 32px;
      color: white;
    }
    .header-badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 12px;
    }
    .badge-active { background: rgba(34,197,94,0.2); color: #22c55e; }
    .badge-revoked { background: rgba(239,68,68,0.2); color: #ef4444; }
    .header h1 {
      font-size: 24px;
      font-weight: 700;
      margin-bottom: 4px;
    }
    .header .subtitle {
      font-size: 14px;
      opacity: 0.85;
    }
    .body {
      padding: 32px;
    }
    .field-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      margin-bottom: 28px;
    }
    .field {
      border-bottom: 1px solid #334155;
      padding-bottom: 12px;
    }
    .field.full-width {
      grid-column: 1 / -1;
    }
    .field-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #94a3b8;
      font-weight: 600;
      margin-bottom: 4px;
    }
    .field-value {
      font-size: 14px;
      color: #f1f5f9;
      word-break: break-all;
      line-height: 1.5;
    }
    .field-value.mono {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
    }
    .qr-section {
      display: flex;
      align-items: center;
      gap: 24px;
      padding: 24px;
      background: #0f172a;
      border-radius: 12px;
      border: 1px solid #334155;
    }
    .qr-section img {
      width: 140px;
      height: 140px;
      border-radius: 8px;
      flex-shrink: 0;
    }
    .qr-info h3 {
      font-size: 14px;
      font-weight: 600;
      color: #f1f5f9;
      margin-bottom: 8px;
    }
    .qr-info p {
      font-size: 12px;
      color: #94a3b8;
      line-height: 1.6;
      word-break: break-all;
    }
    .qr-info .verify-link {
      color: #6366f1;
      text-decoration: none;
      font-weight: 500;
    }
    .footer {
      padding: 16px 32px;
      border-top: 1px solid #334155;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .footer-logo {
      font-size: 14px;
      font-weight: 700;
      color: #6366f1;
    }
    .footer-text {
      font-size: 11px;
      color: #64748b;
    }
    .verification-hash {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: #64748b;
      background: #0f172a;
      padding: 6px 10px;
      border-radius: 6px;
      word-break: break-all;
      margin-top: 12px;
      line-height: 1.4;
    }
    .stamp {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
    }
    .stamp-verified {
      background: rgba(34,197,94,0.15);
      color: #22c55e;
      border: 1px solid rgba(34,197,94,0.3);
    }
    .stamp-blockchain {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      border-radius: 8px;
      background: rgba(99,102,241,0.15);
      color: #818cf8;
      border: 1px solid rgba(99,102,241,0.3);
      font-size: 12px;
      font-weight: 500;
      margin-top: 16px;
    }
    @media print {
      body { background: white; padding: 0; }
      .credential { box-shadow: none; border: 2px solid #e2e8f0; }
      .header { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .badge-active, .badge-revoked, .stamp-verified, .stamp-blockchain { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .qr-section { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
    @media (max-width: 600px) {
      .field-grid { grid-template-columns: 1fr; }
      .qr-section { flex-direction: column; text-align: center; }
    }
  </style>
</head>
<body>
  <div class="credential">
    <div class="header">
      <div class="header-badge ${isRevoked ? 'badge-revoked' : 'badge-active'}">
        ${isRevoked ? '● Revoked' : '● Active'}
      </div>
      <h1>⬡ QuorumProof Credential</h1>
      <p class="subtitle">Verifiable credential anchored on the Stellar Soroban blockchain</p>
    </div>

    <div class="body">
      <div class="field-grid">
        <div class="field">
          <div class="field-label">Credential ID</div>
          <div class="field-value mono">#${id}</div>
        </div>
        <div class="field">
          <div class="field-label">Type</div>
          <div class="field-value">${typeLabel}</div>
        </div>
        <div class="field">
          <div class="field-label">Subject</div>
          <div class="field-value mono">${credential.subject}</div>
        </div>
        <div class="field">
          <div class="field-label">Issuer</div>
          <div class="field-value mono">${credential.issuer}</div>
        </div>
        <div class="field">
          <div class="field-label">Status</div>
          <div class="field-value" style="color: ${isRevoked ? '#ef4444' : '#22c55e'}">
            ${isRevoked ? 'Revoked' : 'Valid & Active'}
          </div>
        </div>
        <div class="field">
          <div class="field-label">Expires</div>
          <div class="field-value">${expiresAt}</div>
        </div>
        <div class="field full-width">
          <div class="field-label">Metadata Hash</div>
          <div class="field-value mono" style="font-size: 11px">${metadataHex}</div>
        </div>
      </div>

      <div class="qr-section">
        <img src="${qrUrl}" alt="QR Code for credential verification" />
        <div class="qr-info">
          <h3>On-Chain Verification</h3>
          <p>
            Scan this QR code or visit the link below to verify this credential
            directly on the Stellar Soroban blockchain. The verification checks
            the credential's authenticity, issuer signature, and current status.
          </p>
          <p style="margin-top: 8px">
            <a href="${verifyUrl}" class="verify-link" target="_blank">${verifyUrl}</a>
          </p>
          <div class="stamp-blockchain">
            ⛓️ Anchored on Stellar Soroban
          </div>
        </div>
      </div>

      <div class="verification-hash">
        On-chain verification: ${verifyUrl}
      </div>
    </div>

    <div class="footer">
      <div class="footer-logo">⬡ QuorumProof</div>
      <div class="footer-text">Issued ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
    </div>
  </div>
  <script>window.onload = () => { setTimeout(() => window.print(), 500); };<\/script>
</body>
</html>`;
}

export function exportToPDF(credential: Credential, baseUrl = window.location.origin): void {
  const id = credential.id.toString();
  const qrUrl = buildQrUrl(id, baseUrl);
  const verifyUrl = `${baseUrl}/verify?id=${id}`;

  const html = credentialTemplate(credential, id, qrUrl, verifyUrl);

  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  if (win) {
    win.onload = () => {
      setTimeout(() => {
        win.print();
        URL.revokeObjectURL(url);
      }, 500);
    };
  }
}

export function exportCredentials(
  credentials: Credential[],
  format: 'json' | 'csv' | 'pdf'
): void {
  const timestamp = new Date().toISOString().split('T')[0];

  if (format === 'json') {
    const content = exportToJSON(credentials);
    downloadFile(content, `credentials-${timestamp}.json`, 'application/json');
  } else if (format === 'csv') {
    const content = exportToCSV(credentials);
    downloadFile(content, `credentials-${timestamp}.csv`, 'text/csv');
  } else if (format === 'pdf') {
    if (credentials.length === 1) {
      exportToPDF(credentials[0]);
    } else {
      credentials.forEach((cred, i) => {
        setTimeout(() => exportToPDF(cred), i * 300);
      });
    }
  }
}
