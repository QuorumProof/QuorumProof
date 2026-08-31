import { useState } from 'react';
import type { FormEvent, ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { issueCredential } from '../lib/contracts/quorumProof';
import { useToast } from '../context/ToastContextValue';

// Credential types matching the on-chain enum (1-indexed)
const CREDENTIAL_TYPE_KEYS = [
  { value: 1, key: 'degree' },
  { value: 2, key: 'license' },
  { value: 3, key: 'employment' },
] as const;

function encodeMetadataHash(input: string): Uint8Array {
  return new TextEncoder().encode(input.trim());
}

function isValidStellarAddress(addr: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(addr.trim());
}

interface FormState {
  subject: string;
  credentialType: number;
  metadataHash: string;
}

interface FormErrors {
  subject?: string;
  credentialType?: string;
  metadataHash?: string;
}

interface SuccessState {
  credentialId: bigint;
}

export function IssueCredentialForm({ issuerAddress }: { issuerAddress: string }) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { addToast, removeToast } = useToast();
  const [form, setForm] = useState<FormState>({
    subject: '',
    credentialType: 1,
    metadataHash: '',
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [success, setSuccess] = useState<SuccessState | null>(null);

  function validate(): FormErrors {
    const errs: FormErrors = {};
    if (!form.subject.trim()) {
      errs.subject = t('issueCredential.errSubjectRequired');
    } else if (!isValidStellarAddress(form.subject)) {
      errs.subject = t('issueCredential.errSubjectInvalid');
    }
    if (!form.credentialType) {
      errs.credentialType = t('issueCredential.errTypeRequired');
    }
    if (!form.metadataHash.trim()) {
      errs.metadataHash = t('issueCredential.errMetaRequired');
    } else if (form.metadataHash.trim().length < 4) {
      errs.metadataHash = t('issueCredential.errMetaTooShort');
    }
    return errs;
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitError(null);
    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    setErrors({});
    setSubmitting(true);
    const pendingId = addToast({ type: 'pending', message: t('issueCredential.txPending') });
    try {
      const credentialId = await issueCredential(
        issuerAddress,
        form.subject.trim(),
        form.credentialType,
        encodeMetadataHash(form.metadataHash),
      );
      removeToast(pendingId);
      addToast({
        type: 'success',
        message: t('issueCredential.txConfirmed'),
        explorerUrl: `https://stellar.expert/explorer/testnet/tx/${credentialId.toString()}`,
      });
      setSuccess({ credentialId });
    } catch (err: unknown) {
      removeToast(pendingId);
      const msg = err instanceof Error ? err.message : t('common.error');
      addToast({ type: 'error', message: t('issueCredential.txFailed', { message: msg }) });
      setSubmitError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  function handleChange(field: keyof FormState, value: string | number) {
    setForm((prev: FormState) => ({ ...prev, [field]: value }));
    if (errors[field as keyof FormErrors]) {
      setErrors((prev: FormErrors) => ({ ...prev, [field]: undefined }));
    }
  }

  if (success) {
    return (
      <div className="issue-form__success" role="status" aria-live="polite">
        <div className="status-banner status-banner--valid">
          <div className="status-banner__icon">✅</div>
          <div>
            <div className="status-banner__title">{t('issueCredential.successTitle')}</div>
            <div className="status-banner__sub">
              {t('issueCredential.successSub', { credentialId: success.credentialId.toString() })}
            </div>
          </div>
        </div>
        <div className="issue-form__success-actions">
          <button
            className="btn btn--primary"
            onClick={() =>
              navigate(`/verify?credentialId=${success.credentialId.toString()}`)
            }
          >
            {t('issueCredential.viewCredential')}
          </button>
          <button
            className="btn btn--ghost"
            onClick={() => {
              setSuccess(null);
              setForm({ subject: '', credentialType: 1, metadataHash: '' });
            }}
          >
            {t('issueCredential.issueAnother')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="issue-form"
      onSubmit={handleSubmit}
      noValidate
      aria-label={t('issueCredential.formLabel')}
    >
      {/* Subject Address */}
      <div className="form-row">
        <label htmlFor="icf-subject" className="form-label">
          {t('issueCredential.subjectLabel')}
        </label>
        <div className="input-wrap">
          <span className="input-icon" aria-hidden="true">👤</span>
          <input
            id="icf-subject"
            type="text"
            placeholder={t('issueCredential.subjectPlaceholder')}
            value={form.subject}
            onChange={(e: ChangeEvent<HTMLInputElement>) => handleChange('subject', e.target.value)}
            aria-describedby={errors.subject ? 'icf-subject-err' : undefined}
            aria-invalid={!!errors.subject}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        {errors.subject && (
          <p id="icf-subject-err" className="issue-form__field-error" role="alert">
            {errors.subject}
          </p>
        )}
      </div>

      {/* Credential Type */}
      <div className="form-row">
        <label htmlFor="icf-type" className="form-label">
          {t('issueCredential.typeLabel')}
        </label>
        <div className="input-wrap">
          <span className="input-icon" aria-hidden="true">📋</span>
          <select
            id="icf-type"
            value={form.credentialType}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => handleChange('credentialType', Number(e.target.value))}
            aria-invalid={!!errors.credentialType}
          >
            {CREDENTIAL_TYPE_KEYS.map((ct) => (
              <option key={ct.value} value={ct.value}>
                {t(`issueCredential.credentialTypes.${ct.key}`)}
              </option>
            ))}
          </select>
        </div>
        {errors.credentialType && (
          <p className="issue-form__field-error" role="alert">
            {errors.credentialType}
          </p>
        )}
      </div>

      {/* Metadata Hash */}
      <div className="form-row">
        <label htmlFor="icf-meta" className="form-label">
          {t('issueCredential.metaLabel')}
        </label>
        <div className="input-wrap">
          <span className="input-icon" aria-hidden="true">#</span>
          <input
            id="icf-meta"
            type="text"
            placeholder={t('issueCredential.metaPlaceholder')}
            value={form.metadataHash}
            onChange={(e: ChangeEvent<HTMLInputElement>) => handleChange('metadataHash', e.target.value)}
            aria-describedby="icf-meta-hint icf-meta-err"
            aria-invalid={!!errors.metadataHash}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <p id="icf-meta-hint" className="issue-form__hint">
          {t('issueCredential.metaHint')}
        </p>
        {errors.metadataHash && (
          <p id="icf-meta-err" className="issue-form__field-error" role="alert">
            {errors.metadataHash}
          </p>
        )}
      </div>

      {/* Submit error */}
      {submitError && (
        <div className="error-card" role="alert">
          <span className="error-card__icon">⚠️</span>
          <div>
            <div className="error-card__title">{t('issueCredential.errorTitle')}</div>
            <div className="error-card__msg">{submitError}</div>
          </div>
        </div>
      )}

      <button
        type="submit"
        className="btn btn--primary issue-form__submit"
        disabled={submitting}
        aria-busy={submitting}
      >
        {submitting ? (
          <>
            <span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} aria-hidden="true" />
            {t('issueCredential.submitting')}
          </>
        ) : (
          t('issueCredential.submitButton')
        )}
      </button>
    </form>
  );
}
