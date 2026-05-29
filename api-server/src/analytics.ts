/** In-process analytics store for contract function call tracking (#585). */

interface FunctionStats {
  calls: number;
  errors: number;
  lastCalledAt: string | null;
}

const stats: Record<string, FunctionStats> = {};

export function recordCall(fn: string, error = false): void {
  if (!stats[fn]) stats[fn] = { calls: 0, errors: 0, lastCalledAt: null };
  stats[fn].calls++;
  if (error) stats[fn].errors++;
  stats[fn].lastCalledAt = new Date().toISOString();
}

export function getUsageReport() {
  return {
    generatedAt: new Date().toISOString(),
    functions: Object.entries(stats).map(([name, s]) => ({
      name,
      calls: s.calls,
      errors: s.errors,
      errorRate: s.calls > 0 ? +(s.errors / s.calls).toFixed(4) : 0,
      lastCalledAt: s.lastCalledAt,
    })),
  };
}

export function resetStats(): void {
  for (const key of Object.keys(stats)) delete stats[key];
}
