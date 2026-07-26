/**
 * Issue #1000 — Credential Export API
 *
 * Routes:
 *   GET /api/credentials/:id/export?format=json|pdf|qrcode
 */
import { Router, Request, Response } from 'express';
import QRCode from 'qrcode';
import PDFDocument from 'pdfkit';
import type { SorobanClient } from './credentials.js';

function serializeBigInt(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(serializeBigInt);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, serializeBigInt(v)])
    );
  }
  return value;
}

const EXPORT_FORMATS = ['json', 'pdf', 'qrcode'] as const;
type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * Public URL a holder's verifier can visit (or a QR scanner lands on) to
 * check a credential's live status. Configurable via `PUBLIC_APP_BASE_URL`
 * since the API server doesn't otherwise know its own externally-reachable
 * origin (it may sit behind a load balancer / reverse proxy).
 */
function verificationUrl(credentialId: number): string {
  const base = (process.env.PUBLIC_APP_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}/api/verify/${credentialId}`;
}

/**
 * Renders a single-credential PDF: title, issuer logo (best-effort — the
 * export still succeeds if the logo URL is missing or unreachable), core
 * credential fields, and a footer with the verification URL.
 */
async function renderCredentialPdf(
  record: Record<string, unknown>,
  credentialId: number,
  verifyUrl: string
): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const metadata = (record.metadata as Record<string, unknown> | undefined) ?? {};
  const logoUrl = typeof metadata.issuer_logo_url === 'string' ? metadata.issuer_logo_url : undefined;

  let logoEmbedded = false;
  if (logoUrl) {
    try {
      const resp = await fetch(logoUrl);
      if (resp.ok) {
        const bytes = Buffer.from(await resp.arrayBuffer());
        doc.image(bytes, 50, 45, { width: 60, height: 60 });
        logoEmbedded = true;
      }
    } catch {
      // Best-effort: the export must still succeed without the logo.
    }
  }

  doc
    .fontSize(20)
    .text('QuorumProof Credential', logoEmbedded ? 125 : 50, 50);
  doc.moveDown(logoEmbedded ? 1.5 : 2);

  doc.fontSize(12).fillColor('black');
  const fields: Array<[string, unknown]> = [
    ['Credential ID', credentialId],
    ['Subject', record.subject],
    ['Issuer', record.issuer],
    ['Credential Type', record.credential_type],
    ['Metadata Hash', record.metadata_hash],
    ['Revoked', record.revoked ? 'Yes' : 'No'],
    ['Suspended', record.suspended ? 'Yes' : 'No'],
    ['Expires At', record.expires_at ?? 'Never'],
    ['Created At', record.created_at ?? 'Unknown'],
    ['Version', record.version],
  ];
  for (const [label, value] of fields) {
    doc.text(`${label}: ${value === null || value === undefined ? 'N/A' : String(value)}`);
  }

  doc.moveDown();
  doc
    .fontSize(10)
    .fillColor('gray')
    .text(`Verify at: ${verifyUrl}`)
    .text(`Exported: ${new Date().toISOString()}`);

  doc.end();
  return finished;
}

export function createCredentialExportRouter(soroban: SorobanClient) {
  const router = Router();

  /**
   * GET /api/credentials/:id/export
   * Query params:
   *   - format: "json" (default) | "pdf" | "qrcode"
   */
  router.get('/:id/export', async (req: Request, res: Response) => {
    const credentialId = parseInt(req.params.id, 10);
    if (!Number.isInteger(credentialId) || credentialId <= 0) {
      res.status(400).json({ error: 'Invalid credential ID' });
      return;
    }

    const format = (typeof req.query.format === 'string' ? req.query.format : 'json') as ExportFormat;
    if (!EXPORT_FORMATS.includes(format)) {
      res.status(400).json({ error: `format must be one of: ${EXPORT_FORMATS.join(', ')}` });
      return;
    }

    let record: Record<string, unknown>;
    try {
      const cred = await soroban.simulateCall('get_credential', [soroban.u64Val(credentialId)]);
      record = serializeBigInt(cred) as Record<string, unknown>;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('credentialnotfound') || msg.toLowerCase().includes('not found')) {
        res.status(404).json({ error: 'Credential not found' });
      } else {
        res.status(500).json({ error: msg });
      }
      return;
    }

    const verifyUrl = verificationUrl(credentialId);

    if (format === 'json') {
      res.json({
        credential: record,
        verification_url: verifyUrl,
        exported_at: new Date().toISOString(),
      });
      return;
    }

    if (format === 'qrcode') {
      try {
        const png = await QRCode.toBuffer(verifyUrl, {
          type: 'png',
          errorCorrectionLevel: 'M',
          margin: 2,
          width: 300,
        });
        res.set('Content-Type', 'image/png');
        res.set('Content-Disposition', `inline; filename="credential-${credentialId}-qrcode.png"`);
        res.send(png);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: msg });
      }
      return;
    }

    // format === 'pdf'
    try {
      const pdfBuffer = await renderCredentialPdf(record, credentialId, verifyUrl);
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `attachment; filename="credential-${credentialId}.pdf"`);
      res.send(pdfBuffer);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}

// Default export using the real Soroban client
import { simulateCall, u64Val, u32Val, addressVal } from '../soroban.js';
export default createCredentialExportRouter({
  simulateCall,
  u64Val: u64Val as unknown as SorobanClient['u64Val'],
  u32Val: u32Val as unknown as SorobanClient['u32Val'],
  addressVal: addressVal as unknown as SorobanClient['addressVal'],
});
