import { useState } from 'react';
import type { Credential } from '../lib/contracts/quorumProof';
import { exportCredentials } from '../lib/exportUtils';

interface ExportCredentialsDialogProps {
  credentials: Credential[];
  onClose: () => void;
}

export function ExportCredentialsDialog({ credentials, onClose }: ExportCredentialsDialogProps) {
  const [format, setFormat] = useState<'json' | 'csv' | 'pdf'>('json');
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async () => {
    setIsExporting(true);
    try {
      exportCredentials(credentials, format);
    } catch (error) {
      console.error('Export failed:', error);
    } finally {
      setIsExporting(false);
      onClose();
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Export Credentials</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          <div className="form-group">
            <label className="form-label">Export Format</label>
            <div className="radio-group">
              <label className="radio-label">
                <input
                  type="radio"
                  value="json"
                  checked={format === 'json'}
                  onChange={(e) => setFormat(e.target.value as 'json' | 'csv' | 'pdf')}
                />
                <span>JSON</span>
              </label>
              <label className="radio-label">
                <input
                  type="radio"
                  value="csv"
                  checked={format === 'csv'}
                  onChange={(e) => setFormat(e.target.value as 'json' | 'csv' | 'pdf')}
                />
                <span>CSV</span>
              </label>
              <label className="radio-label">
                <input
                  type="radio"
                  value="pdf"
                  checked={format === 'pdf'}
                  onChange={(e) => setFormat(e.target.value as 'json' | 'csv' | 'pdf')}
                />
                <span>PDF</span>
              </label>
            </div>
          </div>

          <div className="form-info">
            <p>
              {format === 'pdf' && credentials.length > 1
                ? `PDF will generate individual files for all ${credentials.length} credential(s). Each opens in a new tab for printing.`
                : `Exporting ${credentials.length} credential(s) as ${format.toUpperCase()}`}
            </p>
          </div>

          {format === 'pdf' && credentials.length === 1 && (
            <div style={{
              marginTop: 16,
              padding: 12,
              background: '#1a1f2e',
              borderRadius: 8,
              border: '1px solid #2d3748',
              fontSize: 13,
              color: '#94a3b8',
            }}>
              <p>PDF includes a styled credential template with:</p>
              <ul style={{ margin: '8px 0 0 16px', lineHeight: 1.8 }}>
                <li>QR code linking to on-chain verification</li>
                <li>Credential details (ID, type, subject, issuer)</li>
                <li>Status badge (Active/Revoked)</li>
                <li>Metadata hash for integrity verification</li>
                <li>Blockchain anchor stamp</li>
              </ul>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn--primary"
            onClick={handleExport}
            disabled={isExporting}
          >
            {isExporting ? 'Exporting...' : `Export as ${format.toUpperCase()}`}
          </button>
        </div>
      </div>
    </div>
  );
}
