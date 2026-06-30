import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { issueCredential, createSlice } from '../lib/contracts/quorumProof';
import { useToast } from '../context/ToastContext';
import { CREDENTIAL_TYPES } from '../lib/credentialUtils';

// ── Constants matching contract constraints ───────────────────────────────────

const MAX_ATTESTORS = 20;
const MAX_METADATA_BYTES = 256; // MAX_METADATA_SIZE in contract
const MIN_METADATA_CHARS = 4;
const STORAGE_KEY = 'credential-wizard-draft';

// ── Credential type templates ─────────────────────────────────────────────────

interface Template {
  credentialType: number;
  label: string;
  description: string;
  metadataHint: string;
  suggestedRoles: string[];
  defaultThreshold: number;
}

const TEMPLATES: Template[] = [
  {
    credentialType: 1,
    label: '🎓 Degree',
    description: 'University degree attestation',
    metadataHint: 'e.g. QmXoypiz… (IPFS CID of degree document)',
    suggestedRoles: ['University Registrar', 'Department Head'],
    defaultThreshold: 1,
  },
  {
    credentialType: 2,
    label: '🏛️ License',
    description: 'National engineering society license',
    metadataHint: 'e.g. sha256:abc123… (hash of license record)',
    suggestedRoles: ['Licensing Body', 'Regulatory Authority'],
    defaultThreshold: 1,
  },
  {
    credentialType: 3,
    label: '💼 Employment',
    description: 'Employer professional history record',
    metadataHint: 'e.g. sha256:def456… (hash of employment letter)',
    suggestedRoles: ['HR Department', 'Direct Manager'],
    defaultThreshold: 1,
  },
  {
    credentialType: 4,
    label: '📜 Certification',
    description: 'Professional certification credential',
    metadataHint: 'e.g. QmABC… (IPFS CID of certificate)',
    suggestedRoles: ['Certification Body', 'Examiner'],
    defaultThreshold: 1,
  },
  {
    credentialType: 5,
    label: '🔬 Research',
    description: 'Research publication or contribution',
    metadataHint: 'e.g. sha256:ghi789… (hash of research record)',
    suggestedRoles: ['Research Supervisor', 'Institution'],
    defaultThreshold: 2,
  },
];

// ── Form state types ──────────────────────────────────────────────────────────

interface AttestorEntry {
  id: string;
  address: string;
  role: string;
}

interface WizardState {
  credentialType: number;
  subject: string;
  metadataHash: string;
  attestors: AttestorEntry[];
  threshold: number;
}

/** Seed values that pre-fill the wizard (used for duplicate-from-template). */
export interface WizardSeed {
  credentialType?: number;
  subject?: string;
  metadataHash?: string;
  attestors?: AttestorEntry[];
  threshold?: number;
}

type StepErrors = Partial<Record<string, string>>;

const INITIAL_STATE: WizardState = {
  credentialType: 1,
  subject: '',
  metadataHash: '',
  attestors: [],
  threshold: 1,
};

// ── Validation ────────────────────────────────────────────────────────────────

function isStellarAddress(s: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(s.trim());
}

function validateStep1(state: WizardState): StepErrors {
  const errs: StepErrors = {};
  if (!state.credentialType || state.credentialType < 1) {
    errs.credentialType = 'Please select a credential type.';
  }
  return errs;
}

function validateStep2(state: WizardState): StepErrors {
  const errs: StepErrors = {};
  if (!state.subject.trim()) {
    errs.subject = 'Subject address is required.';
  } else if (!isStellarAddress(state.subject)) {
    errs.subject = 'Must be a valid Stellar address (starts with G, 56 chars).';
  }
  if (!state.metadataHash.trim()) {
    errs.metadataHash = 'Metadata hash is required.';
  } else if (state.metadataHash.trim().length < MIN_METADATA_CHARS) {
    errs.metadataHash = `Metadata hash must be at least ${MIN_METADATA_CHARS} characters.`;
  } else if (new TextEncoder().encode(state.metadataHash.trim()).length > MAX_METADATA_BYTES) {
    errs.metadataHash = `Metadata hash exceeds maximum of ${MAX_METADATA_BYTES} bytes.`;
  }
  return errs;
}

function validateStep3(state: WizardState): StepErrors {
  const errs: StepErrors = {};
  if (state.attestors.length === 0) {
    errs.attestors = 'At least one attestor is required.';
  } else if (state.attestors.length > MAX_ATTESTORS) {
    errs.attestors = `Maximum ${MAX_ATTESTORS} attestors allowed.`;
  }
  if (state.threshold < 1) {
    errs.threshold = 'Threshold must be at least 1.';
  } else if (state.threshold > state.attestors.length) {
    errs.threshold = 'Threshold cannot exceed the number of attestors.';
  }
  // Validate each attestor address
  state.attestors.forEach((a, i) => {
    if (!isStellarAddress(a.address)) {
      errs[`attestor_${i}`] = `Attestor ${i + 1}: invalid Stellar address.`;
    }
  });
  // Check for duplicate addresses
  const seen = new Set<string>();
  state.attestors.forEach((a, i) => {
    if (seen.has(a.address)) {
      errs[`attestor_dup_${i}`] = `Attestor ${i + 1}: duplicate address.`;
    }
    seen.add(a.address);
  });
  return errs;
}

const STEP_VALIDATORS = [validateStep1, validateStep2, validateStep3];

// ── Step indicator ────────────────────────────────────────────────────────────

const STEP_LABELS = ['Type', 'Details', 'Attestors', 'Preview'];

function StepIndicator({ current, errors }: { current: number; errors: StepErrors[] }) {
  return (
    <nav aria-label="Credential wizard steps" className="wizard-steps">
      {STEP_LABELS.map((label, i) => {
        const hasError = Object.keys(errors[i] ?? {}).length > 0;
        const done = i < current;
        const active = i === current;
        return (
          <div
            key={label}
            className={`wizard-step ${active ? 'wizard-step--active' : ''} ${done ? 'wizard-step--done' : ''} ${hasError ? 'wizard-step--error' : ''}`}
            aria-current={active ? 'step' : undefined}
          >
            <span className="wizard-step__dot" aria-hidden="true">
              {done ? '✓' : i + 1}
            </span>
            <span className="wizard-step__label">{label}</span>
          </div>
        );
      })}
    </nav>
  );
}

// ── Step 1: Type selection ────────────────────────────────────────────────────

function Step1({ state, errors, onChange }: {
  state: WizardState;
  errors: StepErrors;
  onChange: (patch: Partial<WizardState>) => void;
}) {
  return (
    <fieldset className="wizard-fieldset">
      <legend className="wizard-section-title">Select credential type</legend>
      <p className="wizard-hint">Choose a template to pre-fill suggested configuration.</p>
      <div className="wizard-type-grid" role="radiogroup" aria-label="Credential type">
        {TEMPLATES.map((t) => (
          <label
            key={t.credentialType}
            className={`wizard-type-card ${state.credentialType === t.credentialType ? 'wizard-type-card--selected' : ''}`}
          >
            <input
              type="radio"
              name="credentialType"
              value={t.credentialType}
              checked={state.credentialType === t.credentialType}
              onChange={() =>
                onChange({ credentialType: t.credentialType, threshold: t.defaultThreshold })
              }
              className="sr-only"
            />
            <span className="wizard-type-card__icon" aria-hidden="true">
              {t.label.split(' ')[0]}
            </span>
            <span className="wizard-type-card__name">{t.label.split(' ').slice(1).join(' ')}</span>
            <span className="wizard-type-card__desc">{t.description}</span>
          </label>
        ))}
      </div>
      {errors.credentialType && (
        <p className="issue-form__field-error" role="alert">{errors.credentialType}</p>
      )}
    </fieldset>
  );
}

// ── Step 2: Metadata input ────────────────────────────────────────────────────

function Step2({ state, errors, onChange, issuerAddress }: {
  state: WizardState;
  errors: StepErrors;
  onChange: (patch: Partial<WizardState>) => void;
  issuerAddress: string;
}) {
  const template = TEMPLATES.find((t) => t.credentialType === state.credentialType)!;
  const byteLen = new TextEncoder().encode(state.metadataHash.trim()).length;

  return (
    <fieldset className="wizard-fieldset">
      <legend className="wizard-section-title">Credential details</legend>

      {/* Issuer (read-only) */}
      <div className="form-row">
        <label className="form-label" htmlFor="wiz-issuer">Issuer address</label>
        <div className="input-wrap">
          <span className="input-icon" aria-hidden="true">🏛️</span>
          <input
            id="wiz-issuer"
            type="text"
            value={issuerAddress}
            readOnly
            aria-readonly="true"
            className="input--readonly"
          />
        </div>
        <p className="issue-form__hint">Your connected wallet acts as the issuer.</p>
      </div>

      {/* Subject */}
      <div className="form-row">
        <label className="form-label" htmlFor="wiz-subject">
          Subject Stellar address <span aria-hidden="true" className="required-mark">*</span>
        </label>
        <div className="input-wrap">
          <span className="input-icon" aria-hidden="true">👤</span>
          <input
            id="wiz-subject"
            type="text"
            placeholder="GABC…XYZ"
            value={state.subject}
            onChange={(e) => onChange({ subject: e.target.value })}
            aria-describedby={errors.subject ? 'wiz-subject-err' : 'wiz-subject-hint'}
            aria-invalid={!!errors.subject}
            aria-required="true"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <p id="wiz-subject-hint" className="issue-form__hint">
          The engineer's Stellar public key receiving this credential.
        </p>
        {errors.subject && (
          <p id="wiz-subject-err" className="issue-form__field-error" role="alert">{errors.subject}</p>
        )}
      </div>

      {/* Metadata Hash */}
      <div className="form-row">
        <label className="form-label" htmlFor="wiz-meta">
          Metadata hash <span aria-hidden="true" className="required-mark">*</span>
        </label>
        <div className="input-wrap">
          <span className="input-icon" aria-hidden="true">#</span>
          <input
            id="wiz-meta"
            type="text"
            placeholder={template.metadataHint}
            value={state.metadataHash}
            onChange={(e) => onChange({ metadataHash: e.target.value })}
            aria-describedby="wiz-meta-hint wiz-meta-len"
            aria-invalid={!!errors.metadataHash}
            aria-required="true"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="wizard-meta-footer">
          <p id="wiz-meta-hint" className="issue-form__hint">
            An IPFS CID or SHA-256 hash pointing to the off-chain credential document.
          </p>
          <span
            id="wiz-meta-len"
            className={`wizard-byte-counter ${byteLen > MAX_METADATA_BYTES ? 'wizard-byte-counter--error' : ''}`}
            aria-live="polite"
          >
            {byteLen} / {MAX_METADATA_BYTES} bytes
          </span>
        </div>
        {errors.metadataHash && (
          <p className="issue-form__field-error" role="alert">{errors.metadataHash}</p>
        )}
      </div>
    </fieldset>
  );
}

// ── Step 3: Attestor configuration ───────────────────────────────────────────

function Step3({ state, errors, onChange }: {
  state: WizardState;
  errors: StepErrors;
  onChange: (patch: Partial<WizardState>) => void;
}) {
  const [newAddr, setNewAddr] = useState('');
  const [newRole, setNewRole] = useState('');
  const [addError, setAddError] = useState('');
  const addInputRef = useRef<HTMLInputElement>(null);

  const template = TEMPLATES.find((t) => t.credentialType === state.credentialType)!;

  function addAttestor() {
    setAddError('');
    const addr = newAddr.trim();
    if (!addr) { setAddError('Address is required.'); return; }
    if (!isStellarAddress(addr)) { setAddError('Invalid Stellar address.'); return; }
    if (state.attestors.some((a) => a.address === addr)) {
      setAddError('This address is already in the slice.');
      return;
    }
    if (state.attestors.length >= MAX_ATTESTORS) {
      setAddError(`Maximum ${MAX_ATTESTORS} attestors reached.`);
      return;
    }
    const next = [
      ...state.attestors,
      { id: crypto.randomUUID(), address: addr, role: newRole.trim() || template.suggestedRoles[state.attestors.length] || 'Attestor' },
    ];
    onChange({ attestors: next });
    setNewAddr('');
    setNewRole('');
    addInputRef.current?.focus();
  }

  function removeAttestor(id: string) {
    const next = state.attestors.filter((a) => a.id !== id);
    onChange({
      attestors: next,
      threshold: Math.min(state.threshold, Math.max(1, next.length)),
    });
  }

  return (
    <fieldset className="wizard-fieldset">
      <legend className="wizard-section-title">Attestor configuration</legend>
      <p className="wizard-hint">
        Add the institutions that will co-sign this credential. Suggested: {template.suggestedRoles.join(', ')}.
      </p>

      {/* Add attestor form */}
      <div className="wizard-add-attestor" role="group" aria-label="Add attestor">
        <div className="form-row" style={{ flex: 2 }}>
          <label className="form-label" htmlFor="wiz-att-addr">Stellar address</label>
          <div className="input-wrap">
            <span className="input-icon" aria-hidden="true">👤</span>
            <input
              ref={addInputRef}
              id="wiz-att-addr"
              type="text"
              placeholder="GABC…"
              value={newAddr}
              onChange={(e) => { setNewAddr(e.target.value); setAddError(''); }}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addAttestor())}
              aria-invalid={!!addError}
              aria-describedby={addError ? 'wiz-att-err' : undefined}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        </div>
        <div className="form-row" style={{ flex: 1 }}>
          <label className="form-label" htmlFor="wiz-att-role">Role (optional)</label>
          <input
            id="wiz-att-role"
            type="text"
            placeholder={template.suggestedRoles[state.attestors.length] ?? 'Attestor'}
            value={newRole}
            onChange={(e) => setNewRole(e.target.value)}
            maxLength={40}
          />
        </div>
        <button
          type="button"
          className="btn btn--secondary wizard-add-btn"
          onClick={addAttestor}
          aria-label="Add attestor to slice"
          disabled={state.attestors.length >= MAX_ATTESTORS}
        >
          + Add
        </button>
      </div>
      {addError && (
        <p id="wiz-att-err" className="issue-form__field-error" role="alert">{addError}</p>
      )}
      {errors.attestors && (
        <p className="issue-form__field-error" role="alert">{errors.attestors}</p>
      )}

      {/* Attestor list */}
      {state.attestors.length > 0 ? (
        <ul className="wizard-attestor-list" aria-label="Attestors">
          {state.attestors.map((a, i) => (
            <li key={a.id} className="wizard-attestor-item">
              <span className="wizard-attestor-index" aria-hidden="true">{i + 1}</span>
              <span className="wizard-attestor-addr" title={a.address}>
                {a.address.slice(0, 8)}…{a.address.slice(-6)}
              </span>
              <span className="wizard-attestor-role">{a.role}</span>
              {errors[`attestor_${i}`] && (
                <span className="issue-form__field-error" role="alert">{errors[`attestor_${i}`]}</span>
              )}
              <button
                type="button"
                className="btn btn--ghost wizard-remove-btn"
                onClick={() => removeAttestor(a.id)}
                aria-label={`Remove attestor ${a.role}`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="wizard-empty-attestors">No attestors added yet. Add at least one.</p>
      )}

      {/* Threshold */}
      {state.attestors.length > 0 && (
        <div className="form-row" style={{ marginTop: '1.5rem' }}>
          <label className="form-label" htmlFor="wiz-threshold">
            Attestation threshold
            <span className="issue-form__hint" style={{ marginLeft: 8 }}>
              ({state.threshold} of {state.attestors.length} required)
            </span>
          </label>
          <input
            id="wiz-threshold"
            type="number"
            min={1}
            max={state.attestors.length}
            value={state.threshold}
            onChange={(e) => onChange({ threshold: Number(e.target.value) })}
            aria-describedby="wiz-threshold-hint"
            aria-invalid={!!errors.threshold}
          />
          <p id="wiz-threshold-hint" className="issue-form__hint">
            Minimum number of attestors who must sign for this credential to be considered attested.
          </p>
          {errors.threshold && (
            <p className="issue-form__field-error" role="alert">{errors.threshold}</p>
          )}
        </div>
      )}
    </fieldset>
  );
}

// ── Step 4: Preview ───────────────────────────────────────────────────────────

function Step4({ state, issuerAddress }: { state: WizardState; issuerAddress: string }) {
  const template = TEMPLATES.find((t) => t.credentialType === state.credentialType)!;

  return (
    <section className="wizard-preview" aria-label="Credential preview">
      <h3 className="wizard-section-title">Review before submitting</h3>
      <p className="wizard-hint">
        Submitting will call <code>issue_credential</code> and <code>create_slice</code> on-chain. This action is irreversible.
      </p>
      <dl className="wizard-preview-list">
        <div className="wizard-preview-row">
          <dt>Credential type</dt>
          <dd>{template.label}</dd>
        </div>
        <div className="wizard-preview-row">
          <dt>Issuer</dt>
          <dd className="wizard-preview-addr" title={issuerAddress}>
            {issuerAddress.slice(0, 8)}…{issuerAddress.slice(-6)}
          </dd>
        </div>
        <div className="wizard-preview-row">
          <dt>Subject</dt>
          <dd className="wizard-preview-addr" title={state.subject}>
            {state.subject.slice(0, 8)}…{state.subject.slice(-6)}
          </dd>
        </div>
        <div className="wizard-preview-row">
          <dt>Metadata hash</dt>
          <dd className="wizard-preview-meta">{state.metadataHash}</dd>
        </div>
        <div className="wizard-preview-row">
          <dt>Attestors</dt>
          <dd>
            <ul className="wizard-preview-attestors">
              {state.attestors.map((a) => (
                <li key={a.id}>
                  <span title={a.address}>{a.address.slice(0, 8)}…{a.address.slice(-6)}</span>
                  <span className="wizard-attestor-role">{a.role}</span>
                </li>
              ))}
            </ul>
          </dd>
        </div>
        <div className="wizard-preview-row">
          <dt>Threshold</dt>
          <dd>{state.threshold} of {state.attestors.length} attestors</dd>
        </div>
      </dl>
    </section>
  );
}

// ── Main wizard component ─────────────────────────────────────────────────────

export function CredentialWizard({ issuerAddress, seed }: { issuerAddress: string; seed?: WizardSeed }) {
  const navigate = useNavigate();
  const { addToast, removeToast } = useToast();

  const [step, setStep] = useState(0);
  const [state, setState] = useState<WizardState>(() => {
    // A seed (duplicate-from-template) takes priority over any saved draft
    if (seed && Object.keys(seed).length > 0) {
      return { ...INITIAL_STATE, ...seed };
    }
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY);
      return saved ? { ...INITIAL_STATE, ...JSON.parse(saved) } : INITIAL_STATE;
    } catch {
      return INITIAL_STATE;
    }
  });
  // Per-step error caches (only shown after "Next" is clicked)
  const [stepErrors, setStepErrors] = useState<StepErrors[]>([{}, {}, {}, {}]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Auto-save draft to sessionStorage
  useEffect(() => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  function patch(delta: Partial<WizardState>) {
    setState((prev) => ({ ...prev, ...delta }));
  }

  function validateCurrent(): boolean {
    if (step >= STEP_VALIDATORS.length) return true; // step 4 = preview, no validation
    const errs = STEP_VALIDATORS[step](state);
    setStepErrors((prev) => {
      const next = [...prev];
      next[step] = errs;
      return next;
    });
    return Object.keys(errs).length === 0;
  }

  function handleNext() {
    if (validateCurrent()) setStep((s) => s + 1);
  }

  function handleBack() {
    setStep((s) => Math.max(0, s - 1));
    setSubmitError(null);
  }

  async function handleSubmit() {
    setSubmitError(null);
    setSubmitting(true);
    const pendingId = addToast({ type: 'pending', message: 'Submitting credential to blockchain…' });

    try {
      const credentialId = await issueCredential(
        issuerAddress,
        state.subject.trim(),
        state.credentialType,
        new TextEncoder().encode(state.metadataHash.trim()),
      );
      await createSlice(
        issuerAddress,
        state.attestors.map((a) => a.address),
        state.threshold,
      );
      removeToast(pendingId);
      addToast({
        type: 'success',
        message: `Credential #${credentialId} issued and quorum slice created.`,
        explorerUrl: `https://stellar.expert/explorer/testnet/tx/${credentialId.toString()}`,
      });
      sessionStorage.removeItem(STORAGE_KEY);
      navigate(`/verify?credentialId=${credentialId.toString()}`);
    } catch (err: unknown) {
      removeToast(pendingId);
      const msg = err instanceof Error ? err.message : 'Submission failed.';
      addToast({ type: 'error', message: `Transaction failed: ${msg}` });
      setSubmitError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  function handleReset() {
    setState(INITIAL_STATE);
    setStepErrors([{}, {}, {}, {}]);
    setStep(0);
    setSubmitError(null);
    sessionStorage.removeItem(STORAGE_KEY);
  }

  return (
    <div className="credential-wizard" aria-label="Credential issuance wizard">
      <StepIndicator current={step} errors={stepErrors} />

      <div className="wizard-body">
        {step === 0 && (
          <Step1 state={state} errors={stepErrors[0]} onChange={patch} />
        )}
        {step === 1 && (
          <Step2 state={state} errors={stepErrors[1]} onChange={patch} issuerAddress={issuerAddress} />
        )}
        {step === 2 && (
          <Step3 state={state} errors={stepErrors[2]} onChange={patch} />
        )}
        {step === 3 && (
          <Step4 state={state} issuerAddress={issuerAddress} />
        )}
      </div>

      {submitError && (
        <div className="error-card" role="alert">
          <span className="error-card__icon">⚠️</span>
          <div>
            <div className="error-card__title">Submission Failed</div>
            <div className="error-card__msg">{submitError}</div>
          </div>
        </div>
      )}

      <div className="wizard-nav">
        <div className="wizard-nav__left">
          {step > 0 && (
            <button type="button" className="btn btn--ghost" onClick={handleBack} disabled={submitting}>
              ← Back
            </button>
          )}
          <button
            type="button"
            className="btn btn--ghost wizard-reset-btn"
            onClick={handleReset}
            disabled={submitting}
            aria-label="Reset wizard and clear draft"
          >
            Reset
          </button>
        </div>
        <div className="wizard-nav__right">
          {step < 3 ? (
            <button type="button" className="btn btn--primary" onClick={handleNext}>
              Next →
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              onClick={handleSubmit}
              disabled={submitting}
              aria-busy={submitting}
            >
              {submitting ? (
                <>
                  <span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} aria-hidden="true" />
                  Submitting…
                </>
              ) : (
                'Submit to Blockchain'
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
