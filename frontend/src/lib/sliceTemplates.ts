/**
 * Slice Template Library — pre-built QuorumSlice configurations.
 *
 * Each template is ready to apply: attestors carry placeholder addresses
 * that the user replaces after loading the template, and a threshold that
 * reflects a sensible default for the described trust scenario.
 */

export type TemplateCategory =
  | 'Academic'
  | 'Professional'
  | 'Multi-Region'
  | 'Minimal'
  | 'Enterprise';

export interface TemplateAttestor {
  /** Placeholder address — user must fill in a real Stellar address. */
  address: string;
  role: string;
  weight: number;
}

export interface SliceTemplate {
  id: string;
  label: string;
  description: string;
  category: TemplateCategory;
  tags: string[];
  attestors: TemplateAttestor[];
  threshold: number;
}

/** Reusable blank placeholder per role (users replace before submitting). */
const BLANK = '';

export const SLICE_TEMPLATES: SliceTemplate[] = [
  // ── Academic ───────────────────────────────────────────────────────────────

  {
    id: 'academic-basic',
    label: '🎓 Academic Basic',
    description: 'University + licensing body, both required. Ideal for single-country credential verification.',
    category: 'Academic',
    tags: ['university', 'license'],
    attestors: [
      { address: BLANK, role: 'University', weight: 2 },
      { address: BLANK, role: 'Licensing Body', weight: 2 },
    ],
    threshold: 4,
  },
  {
    id: 'academic-extended',
    label: '🎓 Academic + Employer',
    description: 'University, licensing body, and one employer — majority consensus required.',
    category: 'Academic',
    tags: ['university', 'license', 'employer'],
    attestors: [
      { address: BLANK, role: 'University', weight: 3 },
      { address: BLANK, role: 'Licensing Body', weight: 3 },
      { address: BLANK, role: 'Employer', weight: 2 },
    ],
    threshold: 6,
  },
  {
    id: 'academic-dual-degree',
    label: '🎓 Dual-Degree',
    description: 'Two universities required alongside a licensing body — useful for double-degree holders.',
    category: 'Academic',
    tags: ['university', 'dual', 'license'],
    attestors: [
      { address: BLANK, role: 'University', weight: 2 },
      { address: BLANK, role: 'University', weight: 2 },
      { address: BLANK, role: 'Licensing Body', weight: 2 },
    ],
    threshold: 6,
  },

  // ── Professional ──────────────────────────────────────────────────────────

  {
    id: 'professional-basic',
    label: '💼 Professional',
    description: 'University + two employers. Any two of the three nodes can reach consensus.',
    category: 'Professional',
    tags: ['employer', 'university'],
    attestors: [
      { address: BLANK, role: 'University', weight: 2 },
      { address: BLANK, role: 'Employer', weight: 1 },
      { address: BLANK, role: 'Employer', weight: 1 },
    ],
    threshold: 3,
  },
  {
    id: 'professional-full',
    label: '🏛️ Full Trust',
    description: 'All four node types — university, licensing body, employer, and other — with a supermajority threshold.',
    category: 'Professional',
    tags: ['university', 'license', 'employer', 'full'],
    attestors: [
      { address: BLANK, role: 'University', weight: 3 },
      { address: BLANK, role: 'Licensing Body', weight: 3 },
      { address: BLANK, role: 'Employer', weight: 2 },
      { address: BLANK, role: 'Other', weight: 1 },
    ],
    threshold: 7,
  },
  {
    id: 'professional-senior',
    label: '💼 Senior Engineer',
    description: 'Licensing body carries highest weight alongside multiple employers — suited for senior-level verification.',
    category: 'Professional',
    tags: ['license', 'employer', 'senior'],
    attestors: [
      { address: BLANK, role: 'Licensing Body', weight: 4 },
      { address: BLANK, role: 'Employer', weight: 2 },
      { address: BLANK, role: 'Employer', weight: 2 },
    ],
    threshold: 6,
  },

  // ── Multi-Region ──────────────────────────────────────────────────────────

  {
    id: 'multi-region-basic',
    label: '🌍 Multi-Region Trust',
    description: 'Two licensing bodies from different jurisdictions — either alone is insufficient; both required.',
    category: 'Multi-Region',
    tags: ['multi-region', 'license', 'international'],
    attestors: [
      { address: BLANK, role: 'Licensing Body', weight: 3 },
      { address: BLANK, role: 'Licensing Body', weight: 3 },
    ],
    threshold: 6,
  },
  {
    id: 'multi-region-employer',
    label: '🌍 Multi-Region + Employer',
    description: 'Two regional licensing bodies plus an employer. Licensing bodies form a majority even without the employer.',
    category: 'Multi-Region',
    tags: ['multi-region', 'license', 'employer', 'international'],
    attestors: [
      { address: BLANK, role: 'Licensing Body', weight: 3 },
      { address: BLANK, role: 'Licensing Body', weight: 3 },
      { address: BLANK, role: 'Employer', weight: 2 },
    ],
    threshold: 6,
  },
  {
    id: 'multi-region-full',
    label: '🌐 Global Credential',
    description: 'University, two regional licensing bodies, and an employer — designed for maximum international portability.',
    category: 'Multi-Region',
    tags: ['multi-region', 'university', 'license', 'employer', 'international'],
    attestors: [
      { address: BLANK, role: 'University', weight: 2 },
      { address: BLANK, role: 'Licensing Body', weight: 3 },
      { address: BLANK, role: 'Licensing Body', weight: 3 },
      { address: BLANK, role: 'Employer', weight: 2 },
    ],
    threshold: 8,
  },

  // ── Minimal ────────────────────────────────────────────────────────────────

  {
    id: 'minimal-university',
    label: '📋 University Only',
    description: 'Single university attestor — the simplest possible slice for degree-only verification.',
    category: 'Minimal',
    tags: ['university', 'minimal'],
    attestors: [
      { address: BLANK, role: 'University', weight: 1 },
    ],
    threshold: 1,
  },
  {
    id: 'minimal-employer',
    label: '📋 Employer Only',
    description: 'Single employer attestor — fast setup for employment history verification.',
    category: 'Minimal',
    tags: ['employer', 'minimal'],
    attestors: [
      { address: BLANK, role: 'Employer', weight: 1 },
    ],
    threshold: 1,
  },

  // ── Enterprise ─────────────────────────────────────────────────────────────

  {
    id: 'enterprise-consortium',
    label: '🏢 Enterprise Consortium',
    description: 'Three employers with equal weight — at least two must co-sign. Suitable for industry consortiums.',
    category: 'Enterprise',
    tags: ['employer', 'consortium', 'enterprise'],
    attestors: [
      { address: BLANK, role: 'Employer', weight: 2 },
      { address: BLANK, role: 'Employer', weight: 2 },
      { address: BLANK, role: 'Employer', weight: 2 },
    ],
    threshold: 4,
  },
  {
    id: 'enterprise-full',
    label: '🏢 Enterprise Full Stack',
    description: 'University + licensing body + three employers. Designed for large enterprise hiring pipelines.',
    category: 'Enterprise',
    tags: ['university', 'license', 'employer', 'enterprise'],
    attestors: [
      { address: BLANK, role: 'University', weight: 2 },
      { address: BLANK, role: 'Licensing Body', weight: 3 },
      { address: BLANK, role: 'Employer', weight: 2 },
      { address: BLANK, role: 'Employer', weight: 2 },
      { address: BLANK, role: 'Employer', weight: 1 },
    ],
    threshold: 8,
  },
];

/** All distinct categories present in the catalogue. */
export const TEMPLATE_CATEGORIES: TemplateCategory[] = [
  'Academic',
  'Professional',
  'Multi-Region',
  'Minimal',
  'Enterprise',
];

/** Filter templates by category. Returns all if category is undefined. */
export function filterByCategory(
  templates: SliceTemplate[],
  category: TemplateCategory | undefined,
): SliceTemplate[] {
  if (!category) return templates;
  return templates.filter((t) => t.category === category);
}
