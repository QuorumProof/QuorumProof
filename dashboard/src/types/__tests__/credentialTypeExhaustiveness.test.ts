/**
 * Compile-time exhaustiveness test for CredentialType icon/label mappings.
 *
 * This file contains no runtime test framework — it relies entirely on the
 * TypeScript compiler.  `tsc --noEmit` (run via `npm run type-check`) will
 * fail with a type error if:
 *
 *   1. A new value is added to CredentialType but omitted from ICON_MAP
 *      or LABEL_MAP below.
 *   2. A value is removed from CredentialType but still referenced in
 *      either map.
 *
 * The `satisfies Record<CredentialType, T>` annotation is what enforces
 * exhaustiveness — TypeScript reports an error for any missing key.
 *
 * Run:  npm run type-check
 */

import type { CredentialType } from '../types/credential'

// ---------------------------------------------------------------------------
// Icon map — one entry per CredentialType value.
// ---------------------------------------------------------------------------

/** Maps every CredentialType to a Lucide icon component name. */
const ICON_MAP = {
  degree:        'Award',
  license:       'FileText',
  employment:    'Briefcase',
  certification: 'ShieldCheck',
  research:      'BookOpen',
} satisfies Record<CredentialType, string>

// ---------------------------------------------------------------------------
// Label map — one human-readable label per CredentialType value.
// ---------------------------------------------------------------------------

/** Maps every CredentialType to a display label. */
const LABEL_MAP = {
  degree:        'Degree',
  license:       'License',
  employment:    'Employment',
  certification: 'Certification',
  research:      'Research Publication',
} satisfies Record<CredentialType, string>

// Suppress "declared but never read" without touching tsconfig.
void (ICON_MAP as unknown)
void (LABEL_MAP as unknown)

// ---------------------------------------------------------------------------
// ClaimType alignment guard
// ---------------------------------------------------------------------------
// The CredentialType values above correspond to the ClaimType enum in
// dashboard/src/lib/contracts/types.ts.  Keeping this comment (and the
// imports below) in sync documents the relationship and lets reviewers
// spot drift at a glance.
//
// CredentialType  ←→  ClaimType
// degree          ←→  ClaimType.HasDegree
// license         ←→  ClaimType.HasLicense
// employment      ←→  ClaimType.HasEmploymentHistory
// certification   ←→  ClaimType.HasCertification
// research        ←→  ClaimType.HasResearchPublication

import { ClaimType } from '../lib/contracts/types'

const _CREDENTIAL_TYPE_TO_CLAIM_TYPE: Record<CredentialType, ClaimType> = {
  degree:        ClaimType.HasDegree,
  license:       ClaimType.HasLicense,
  employment:    ClaimType.HasEmploymentHistory,
  certification: ClaimType.HasCertification,
  research:      ClaimType.HasResearchPublication,
}

void (_CREDENTIAL_TYPE_TO_CLAIM_TYPE as unknown)
