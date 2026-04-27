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
            <p>Exporting {credentials.length} credential(s) as {format.toUpperCase()}</p>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn--primary"
            onClick={handleExport}
            disabled={isExporting}
          >
            {isExporting ? 'Exporting...' : 'Export'}
          </button>
        </div>
      </div>
    </div>
  );
}
