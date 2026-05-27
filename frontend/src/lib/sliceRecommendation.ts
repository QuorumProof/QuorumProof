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
}

/**
 * Recommends a quorum slice from a pool of candidates.
 * Ranks by: availability first, then reputation score.
 * Selects top N candidates and sets threshold to majority (ceil(N/2)).
 */
export function recommendSlice(
  candidates: AttestorCandidate[],
  maxSize = 3,
): SliceRecommendation | null {
  if (candidates.length === 0) return null;

  const ranked = [...candidates]
    .sort((a, b) => {
      if (a.available !== b.available) return a.available ? -1 : 1;
      return b.reputationScore - a.reputationScore;
    })
    .slice(0, maxSize);

  const threshold = Math.ceil(ranked.length / 2);
  const score = Math.round(
    ranked.reduce((sum, c) => sum + c.reputationScore, 0) / ranked.length
  );

  return { attestors: ranked, threshold, score };
}
