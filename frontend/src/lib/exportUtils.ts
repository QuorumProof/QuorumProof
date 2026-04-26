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
    // PDF export would require a library like jsPDF
    // For now, we'll export as JSON with a note
    const content = exportToJSON(credentials);
    downloadFile(content, `credentials-${timestamp}.json`, 'application/json');
  }
}
