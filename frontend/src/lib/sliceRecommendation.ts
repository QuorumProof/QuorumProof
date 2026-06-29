export interface AttestorCandidate {
  address: string;
  role: string;
  reputationScore: number; // 0–100
  available: boolean;
}

export interface SliceRecommendation {
  attestors: AttestorCandidate[];
  threshold: number;
  score: number; // overall recommendation score 0–100
  reasons: Record<string, string>; // address → human-readable reason
}

/**
 * Context that drives context-aware recommendations.
 * All fields are optional — falls back to the basic reputation/availability ranking.
 */
export interface RecommendationContext {
  /** Credential type ID matching CREDENTIAL_TYPES (1=Degree,2=License,3=Employment,4=Certification,5=Research) */
  credentialType?: number;
  /** Industry string, e.g. "civil", "mechanical", "software", "biomedical" */
  industry?: string;
  /** Historical attestor usage: address → number of prior attestations */
  history?: Record<string, number>;
}

// ── Rules ────────────────────────────────────────────────────────────────────

/**
 * Required roles per credential type.
 * An attestor whose role appears in the required list receives a bonus.
 */
const CREDENTIAL_TYPE_REQUIRED_ROLES: Record<number, string[]> = {
  1: ['University'],                           // Degree — university is essential
  2: ['Licensing Body'],                        // License — licensing body is essential
  3: ['Employer'],                              // Employment — employer is essential
  4: ['University', 'Licensing Body'],          // Certification — academic + body
  5: ['University', 'Licensing Body'],          // Research — academic + body
};

/**
 * Role weight bonuses per industry.
 * Additive bonus (0–30) applied on top of reputation.
 */
const INDUSTRY_ROLE_BONUS: Record<string, Record<string, number>> = {
  civil:       { 'Licensing Body': 25, University: 15, Employer: 10 },
  mechanical:  { 'Licensing Body': 20, University: 15, Employer: 10 },
  electrical:  { 'Licensing Body': 20, University: 15, Employer: 10 },
  software:    { Employer: 25, University: 15, 'Licensing Body': 5 },
  biomedical:  { University: 25, 'Licensing Body': 20, Employer: 10 },
  chemical:    { 'Licensing Body': 25, University: 20, Employer: 10 },
  aerospace:   { 'Licensing Body': 20, University: 20, Employer: 15 },
};

// ── Scoring ──────────────────────────────────────────────────────────────────

function scoreCandidate(
  candidate: AttestorCandidate,
  ctx: RecommendationContext,
): { score: number; reason: string } {
  let score = candidate.reputationScore;
  const reasons: string[] = [];

  // Availability penalty — unavailable candidates get a hard penalty
  if (!candidate.available) {
    score -= 40;
    reasons.push('unavailable');
  }

  // Credential-type rule bonus
  const requiredRoles = ctx.credentialType ? CREDENTIAL_TYPE_REQUIRED_ROLES[ctx.credentialType] : undefined;
  if (requiredRoles?.includes(candidate.role)) {
    score += 30;
    reasons.push(`required for ${credentialTypeLabel(ctx.credentialType!)}`);
  }

  // Industry bonus
  const industryKey = ctx.industry?.toLowerCase();
  if (industryKey && INDUSTRY_ROLE_BONUS[industryKey]) {
    const bonus = INDUSTRY_ROLE_BONUS[industryKey][candidate.role] ?? 0;
    if (bonus > 0) {
      score += bonus;
      reasons.push(`valued in ${ctx.industry} industry`);
    }
  }

  // Historical pattern bonus — prior successful attestation signals trust
  const historyCount = ctx.history?.[candidate.address] ?? 0;
  if (historyCount > 0) {
    const histBonus = Math.min(historyCount * 5, 20); // up to +20
    score += histBonus;
    reasons.push(`attested ${historyCount}× previously`);
  }

  const reason = reasons.length
    ? reasons.join(', ')
    : 'high reputation';

  return { score, reason };
}

function credentialTypeLabel(typeId: number): string {
  const labels: Record<number, string> = {
    1: 'Degree', 2: 'License', 3: 'Employment', 4: 'Certification', 5: 'Research',
  };
  return labels[typeId] ?? `type ${typeId}`;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Recommends a quorum slice from a pool of candidates.
 *
 * When a RecommendationContext is provided the scoring accounts for:
 *  - credential type → required roles receive a +30 bonus
 *  - industry        → industry-specific role bonuses (up to +25)
 *  - history         → prior attestation counts add up to +20
 *
 * Falls back to availability + reputation ranking when no context is given.
 */
export function recommendSlice(
  candidates: AttestorCandidate[],
  maxSize = 3,
  ctx: RecommendationContext = {},
): SliceRecommendation | null {
  if (candidates.length === 0) return null;

  const scored = candidates.map((c) => {
    const { score, reason } = scoreCandidate(c, ctx);
    return { candidate: c, score, reason };
  });

  const ranked = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSize);

  const threshold = Math.ceil(ranked.length / 2);
  const avgReputation = Math.round(
    ranked.reduce((sum, { candidate }) => sum + candidate.reputationScore, 0) / ranked.length
  );

  const reasons: Record<string, string> = {};
  for (const { candidate, reason } of ranked) {
    reasons[candidate.address] = reason;
  }

  return {
    attestors: ranked.map((r) => r.candidate),
    threshold,
    score: avgReputation,
    reasons,
  };
}
