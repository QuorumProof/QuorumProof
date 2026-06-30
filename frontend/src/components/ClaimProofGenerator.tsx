import { useState } from 'react';
import { generateProofRequest } from '../lib/contracts/zkVerifier';
import type { ClaimType, ProofRequest } from '../lib/contracts/zkVerifier';
import {
  CLAIM_TYPE_OPTIONS,
  findClaimTypeOption,
  encodeProofRequest,
  buildProofShareUrl,
} from '../lib/claimDisclosure';

interface Props {
  credentialId: bigint;
}

type GenerateState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'success'; request: ProofRequest }
  | { kind: 'error'; message: string };

export function ClaimProofGenerator({ credentialId }: Props) {
  const [claimType, setClaimType] = useState<ClaimType>('HasDegree');
  const [state, setState] = useState<GenerateState>({ kind: 'idle' });
  const [proofCopied, setProofCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  const option = findClaimTypeOption(claimType);

  async function handleGenerate() {
    setState({ kind: 'loading' });
    setProofCopied(false);
    setLinkCopied(false);
    try {
      const request = await generateProofRequest(credentialId, claimType);
      setState({ kind: 'success', request });
    } catch (err: unknown) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to generate proof request.',
      });
    }
  }

  function handleCopyProof() {
    if (state.kind !== 'success') return;
    navigator.clipboard.writeText(encodeProofRequest(state.request)).then(() => {
      setProofCopied(true);
      setTimeout(() => setProofCopied(false), 2000);
    });
  }

  function handleCopyLink() {
    if (state.kind !== 'success') return;
    navigator.clipboard.writeText(buildProofShareUrl(state.request)).then(() => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    });
  }

  return (
    <div className="zk-card" data-testid="claim-proof-generator">
      <div className="zk-card__header">
        <span className="zk-card__icon" aria-hidden="true">🛡️</span>
        <div>
          <div className="zk-card__title">Generate a Privacy-Preserving Proof</div>
          <div className="zk-card__sub">
            Prove a single claim about this credential without revealing the rest of its details.
          </div>
        </div>
      </div>

      <div className="zk-card__body">
        <fieldset className="form-row" style={{ border: 'none', padding: 0, margin: 0 }}>
          <legend className="form-label">Claim type</legend>
          <select
            data-testid="claim-type-select"
            aria-label="Claim type"
            value={claimType}
            onChange={(e) => {
              setClaimType(e.target.value as ClaimType);
              setState({ kind: 'idle' });
            }}
          >
            {CLAIM_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.icon} {opt.label}
              </option>
            ))}
          </select>
        </fieldset>

        <div
          className="disclosure-preview"
          data-testid="disclosure-preview"
          aria-label={`Disclosure preview for ${option.label} claim`}
        >
          <div className="disclosure-preview__section">
            <div className="disclosure-preview__heading disclosure-preview__heading--shown">
              ✅ Will be disclosed
            </div>
            <p className="disclosure-preview__text">{option.discloses}</p>
            <p className="disclosure-preview__text" style={{ color: 'var(--text-muted)' }}>
              Credential #{credentialId.toString()} is referenced so a verifier can check this proof on-chain.
            </p>
          </div>
          <div className="disclosure-preview__section">
            <div className="disclosure-preview__heading disclosure-preview__heading--hidden">
              🔒 Stays private
            </div>
            <ul className="disclosure-preview__list">
              {option.hides.map((field) => (
                <li key={field}>{field}</li>
              ))}
            </ul>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 16 }}>
          <button
            className="btn btn--primary"
            onClick={handleGenerate}
            disabled={state.kind === 'loading'}
            data-testid="generate-proof-btn"
          >
            {state.kind === 'loading' ? '⏳ Generating…' : '🛡️ Generate Proof'}
          </button>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>No wallet required</span>
        </div>

        {state.kind === 'error' && (
          <div className="zk-result zk-result--error" role="alert">
            ⚠️ {state.message}
          </div>
        )}

        {state.kind === 'success' && (
          <div className="zk-result zk-result--success" role="status" data-testid="proof-result" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 12 }}>
            <div>✅ Proof request generated for <strong>{option.label}</strong></div>

            <div>
              <label className="form-label" htmlFor="proof-request-output">Proof request</label>
              <textarea
                id="proof-request-output"
                readOnly
                value={encodeProofRequest(state.request)}
                style={{ fontSize: 12 }}
                aria-label="Generated proof request, JSON encoded"
              />
              <button
                className="btn btn--ghost btn--sm"
                onClick={handleCopyProof}
                aria-label="Copy proof request to clipboard"
                data-testid="copy-proof-btn"
                style={{ marginTop: 8 }}
              >
                {proofCopied ? '✅ Copied' : '📋 Copy proof'}
              </button>
            </div>

            <div>
              <label className="form-label" htmlFor="proof-share-link">Shareable verification link</label>
              <div className="share-bar" id="proof-share-link">
                <span className="share-bar__url">{buildProofShareUrl(state.request)}</span>
                <button
                  className="btn btn--ghost btn--sm"
                  onClick={handleCopyLink}
                  aria-label="Copy shareable verification link to clipboard"
                  data-testid="copy-link-btn"
                >
                  {linkCopied ? '✅ Copied' : '📋 Copy link'}
                </button>
              </div>
            </div>

            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
              This proof is tied to the current ledger sequence (nonce {state.request.nonce.toString()}) and a
              verifier must submit it before that sequence advances too far. It only proves the selected claim —
              it does not by itself confirm the credential hasn't expired or been revoked.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
