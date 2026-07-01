/**
 * SliceImportExport — issue #948
 * Export/import quorum slice configurations in JSON format for backup and sharing.
 */
import { useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { exportSliceAsJson, importSliceFromJson } from '../lib/sliceBuilderUtils';
import type { SliceDraft } from '../lib/sliceBuilderUtils';

interface SliceImportExportProps {
  /** Current slice state to export (null when no attestors added yet). */
  slice: SliceDraft | null;
  /** Called with the parsed draft when a JSON file is successfully imported. */
  onImport: (draft: SliceDraft) => void;
}

export function SliceImportExport({ slice, onImport }: SliceImportExportProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState('');
  const [importSuccess, setImportSuccess] = useState(false);

  function handleExport() {
    if (!slice) return;
    exportSliceAsJson(slice);
  }

  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError('');
    setImportSuccess(false);
    try {
      const text = await file.text();
      const draft = importSliceFromJson(text);
      onImport(draft);
      setImportSuccess(true);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed.');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <section className="qsb__section" aria-label="Import / Export slice configuration">
      <div className="qsb__section-header">
        <span className="detail-card__title">Import / Export JSON</span>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={handleExport}
          disabled={!slice}
          data-testid="export-slice-btn"
        >
          ⬇ Export JSON
        </button>

        <label className="btn btn--ghost btn--sm" style={{ cursor: 'pointer' }}>
          ⬆ Import JSON
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={handleFileChange}
            data-testid="import-slice-input"
            aria-label="Import slice JSON file"
          />
        </label>
      </div>

      {importError && (
        <p className="issue-form__field-error" role="alert" style={{ marginTop: 8 }} data-testid="import-error">
          {importError}
        </p>
      )}
      {importSuccess && (
        <p style={{ fontSize: 13, color: 'var(--green)', marginTop: 8 }} role="status" data-testid="import-success">
          ✅ Slice configuration imported.
        </p>
      )}
      {!slice && (
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
          Add attestors to enable export.
        </p>
      )}
    </section>
  );
}
