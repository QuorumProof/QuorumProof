import { useState, useRef } from 'react';
import type { Credential } from '../lib/contracts/quorumProof';
import { parseImportFile } from '../lib/importUtils';

interface ImportCredentialsDialogProps {
  onImport: (credentials: Credential[]) => void;
  onClose: () => void;
}

export function ImportCredentialsDialog({ onImport, onClose }: ImportCredentialsDialogProps) {
  const [format, setFormat] = useState<'json' | 'csv'>('json');
  const [errors, setErrors] = useState<string[]>([]);
  const [preview, setPreview] = useState<Credential[] | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = (file: File) => {
    setErrors([]);
    setPreview(null);
    setFileName(file.name);

    const detectedFormat = file.name.endsWith('.csv') ? 'csv' : 'json';
    setFormat(detectedFormat);

    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      const result = parseImportFile(content, detectedFormat);
      setErrors(result.errors);
      if (result.credentials.length > 0) setPreview(result.credentials);
    };
    reader.readAsText(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const handleConfirm = () => {
    if (preview && preview.length > 0) {
      onImport(preview);
      onClose();
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Import Credentials</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="modal-body">
          <div
            className="import-dropzone"
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => fileRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && fileRef.current?.click()}
            aria-label="Drop a JSON or CSV file here, or click to browse"
          >
            <input
              ref={fileRef}
              type="file"
              accept=".json,.csv"
              style={{ display: 'none' }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
            />
            {fileName
              ? <p>{fileName}</p>
              : <p>Drop a <strong>JSON</strong> or <strong>CSV</strong> file here, or click to browse</p>
            }
          </div>

          {errors.length > 0 && (
            <div className="error-card" style={{ marginTop: '12px' }}>
              <div className="error-card__title">Validation errors ({errors.length})</div>
              <ul style={{ margin: '4px 0 0', paddingLeft: '16px', fontSize: '13px' }}>
                {errors.map((err, i) => <li key={i}>{err}</li>)}
              </ul>
            </div>
          )}

          {preview && (
            <p style={{ marginTop: '12px', fontSize: '14px' }}>
              ✅ {preview.length} credential(s) ready to import
              {errors.length > 0 && ` (${errors.length} row(s) skipped)`}
            </p>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn--primary"
            onClick={handleConfirm}
            disabled={!preview || preview.length === 0}
          >
            Import
          </button>
        </div>
      </div>
    </div>
  );
}
