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

/**
 * Build a QR code URL for a credential verification link using the
 * Google Charts QR API (no extra dependency).
 */
export function buildQrUrl(credentialId: string, baseUrl = window.location.origin): string {
  const verifyUrl = encodeURIComponent(`${baseUrl}/verify?id=${credentialId}`);
  return `https://chart.googleapis.com/chart?cht=qr&chs=200x200&chl=${verifyUrl}`;
}

/**
 * Generate a self-contained printable HTML string for a single credential.
 * Opens in a new window so the user can Save as PDF via the browser print dialog.
 */
export function exportToPDF(credential: Credential, baseUrl = window.location.origin): void {
  const id = credential.id.toString();
  const qrUrl = buildQrUrl(id, baseUrl);
  const verifyUrl = `${baseUrl}/verify?id=${id}`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>QuorumProof Credential #${id}</title>
  <style>
    body { font-family: sans-serif; max-width: 600px; margin: 40px auto; color: #111; }
    h1 { font-size: 20px; margin-bottom: 4px; }
    .subtitle { color: #555; font-size: 13px; margin-bottom: 24px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
    td { padding: 8px 12px; border-bottom: 1px solid #e5e7eb; font-size: 14px; }
    td:first-child { font-weight: 600; width: 140px; color: #374151; }
    .qr { text-align: center; margin-top: 24px; }
    .qr img { width: 160px; height: 160px; }
    .qr p { font-size: 11px; color: #6b7280; margin-top: 8px; word-break: break-all; }
    @media print { body { margin: 20px; } }
  </style>
</head>
<body>
  <h1>QuorumProof Credential</h1>
  <p class="subtitle">Verifiable credential on Stellar Soroban</p>
  <table>
    <tr><td>Credential ID</td><td>#${id}</td></tr>
    <tr><td>Type</td><td>${credTypeLabel(credential.credential_type)}</td></tr>
    <tr><td>Subject</td><td>${credential.subject}</td></tr>
    <tr><td>Issuer</td><td>${credential.issuer}</td></tr>
    <tr><td>Status</td><td>${credential.revoked ? 'Revoked' : 'Active'}</td></tr>
    <tr><td>Expires</td><td>${credential.expires_at ? formatTimestamp(credential.expires_at) : 'Never'}</td></tr>
    <tr><td>Metadata Hash</td><td>${Buffer.from(credential.metadata_hash).toString('hex')}</td></tr>
  </table>
  <div class="qr">
    <img src="${qrUrl}" alt="QR code for credential verification" />
    <p>Scan to verify: ${verifyUrl}</p>
  </div>
  <script>window.onload = () => window.print();<\/script>
</body>
</html>`;

  const win = window.open('', '_blank');
  if (win) {
    win.document.write(html);
    win.document.close();
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
    // PDF: open each credential in a printable window; for bulk, export JSON as fallback
    if (credentials.length === 1) {
      exportToPDF(credentials[0]);
    } else {
      const content = exportToJSON(credentials);
      downloadFile(content, `credentials-${timestamp}.json`, 'application/json');
    }
  }
}
