/**
 * SliceBackupRestore — issue #469
 * Backup and restore quorum slice configuration with encryption.
 */
import { useState, useRef } from 'react';
import type { ChangeEvent } from 'react';
import { encryptBackup, decryptBackup, downloadBackupFile } from '../lib/sliceBackup';
import type { SliceBackupData } from '../lib/sliceBackup';

interface SliceBackupRestoreProps {
  /** Current slice data to back up (null if no slice loaded yet) */
  sliceData: SliceBackupData | null;
  /** Called when a backup is successfully restored */
  onRestore: (data: SliceBackupData) => void;
}

export function SliceBackupRestore({ sliceData, onRestore }: SliceBackupRestoreProps) {
  const [backupPassword, setBackupPassword] = useState('');
  const [restorePassword, setRestorePassword] = useState('');
  const [backupError, setBackupError] = useState('');
  const [restoreError, setRestoreError] = useState('');
  const [restoreSuccess, setRestoreSuccess] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleBackup() {
    if (!sliceData) return;
    if (!backupPassword) { setBackupError('Password is required.'); return; }
    setBackupError('');
    setBackupBusy(true);
    try {
      const blob = await encryptBackup(sliceData, backupPassword);
      downloadBackupFile(blob);
      setBackupPassword('');
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : 'Backup failed.');
    } finally {
      setBackupBusy(false);
    }
  }

  async function handleRestore(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!restorePassword) { setRestoreError('Enter a password before selecting a file.'); return; }
    setRestoreError('');
    setRestoreSuccess(false);
    setRestoreBusy(true);
    try {
      const blob = await file.text();
      const data = await decryptBackup(blob.trim(), restorePassword);
      onRestore(data);
      setRestoreSuccess(true);
      setRestorePassword('');
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : 'Restore failed.');
    } finally {
      setRestoreBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div className="slice-backup" aria-label="Slice backup and recovery">
      {/* ── Backup ── */}
      <section style={{ marginBottom: '20px' }}>
        <div className="detail-card__title" style={{ marginBottom: '10px' }}>💾 Backup Slice</div>
        <div className="form-row">
          <label htmlFor="backup-pw" className="form-label">Encryption Password</label>
          <input
            id="backup-pw"
            type="password"
            placeholder="Enter a strong password"
            value={backupPassword}
            onChange={(e) => { setBackupPassword(e.target.value); setBackupError(''); }}
            aria-describedby={backupError ? 'backup-pw-err' : undefined}
            aria-invalid={!!backupError}
          />
          {backupError && <p id="backup-pw-err" className="issue-form__field-error" role="alert">{backupError}</p>}
        </div>
        <button
          className="btn btn--ghost btn--sm"
          onClick={handleBackup}
          disabled={!sliceData || backupBusy}
          aria-busy={backupBusy}
          data-testid="backup-btn"
        >
          {backupBusy ? 'Encrypting…' : '⬇ Download Encrypted Backup'}
        </button>
        {!sliceData && (
          <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px' }}>
            No slice loaded. Create or load a slice first.
          </p>
        )}
      </section>

      <div className="divider" />

      {/* ── Restore ── */}
      <section>
        <div className="detail-card__title" style={{ marginBottom: '10px' }}>🔄 Restore Slice</div>
        <div className="form-row">
          <label htmlFor="restore-pw" className="form-label">Decryption Password</label>
          <input
            id="restore-pw"
            type="password"
            placeholder="Password used during backup"
            value={restorePassword}
            onChange={(e) => { setRestorePassword(e.target.value); setRestoreError(''); setRestoreSuccess(false); }}
            aria-describedby={restoreError ? 'restore-pw-err' : undefined}
            aria-invalid={!!restoreError}
          />
          {restoreError && <p id="restore-pw-err" className="issue-form__field-error" role="alert">{restoreError}</p>}
        </div>
        <label className="btn btn--ghost btn--sm" style={{ cursor: 'pointer', display: 'inline-block' }}>
          {restoreBusy ? 'Decrypting…' : '⬆ Select Backup File'}
          <input
            ref={fileRef}
            type="file"
            accept=".qpb,.txt"
            style={{ display: 'none' }}
            onChange={handleRestore}
            data-testid="restore-file-input"
            aria-label="Select backup file"
          />
        </label>
        {restoreSuccess && (
          <p style={{ fontSize: '13px', color: 'var(--green)', marginTop: '8px' }} role="status" data-testid="restore-success">
            ✅ Slice restored successfully.
          </p>
        )}
      </section>
    </div>
  );
}
