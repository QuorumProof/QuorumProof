/**
 * Gas/resource-fee cost tracking per contract operation (issue #4).
 *
 * Operators previously had no visibility into what each contract
 * invocation actually costs — Soroban RPC's `simulateTransaction` returns a
 * `minResourceFee` (in stroops) per call, but nothing recorded it. This
 * tracks that fee per `simulateCall` method, exposes an aggregated report,
 * lets an operator project costs for hypothetical volumes, and flags the
 * operations most worth optimizing (by total contribution to spend, not
 * just per-call cost — a cheap operation called constantly can cost more
 * than an expensive one called rarely).
 */
import path from 'path';
import { DurableLog } from './durableLog.js';

const STROOPS_PER_XLM = 10_000_000n;

export interface OperationCostStats {
  operation: string;
  callCount: number;
  totalStroops: string;
  minStroops: string;
  maxStroops: string;
  avgStroops: string;
}

export interface CostReport {
  generatedAt: string;
  xlmUsdPrice: number;
  totalCalls: number;
  totalStroops: string;
  totalXlm: number;
  totalUsd: number;
  byOperation: OperationCostStats[];
}

export interface CostProjection {
  operation: string;
  callsPerDay: number;
  days: number;
  projectedStroops: string;
  projectedXlm: number;
  projectedUsd: number;
  basedOnAvgStroops: string;
}

export interface OptimizationRecommendation {
  operation: string;
  totalXlmContribution: number;
  callCount: number;
  avgStroops: string;
  reason: string;
}

interface PersistedStats {
  callCount: number;
  totalStroops: string;
  minStroops: string;
  maxStroops: string;
}

function xlmUsdPrice(): number {
  const configured = parseFloat(process.env.XLM_USD_PRICE ?? '');
  return Number.isFinite(configured) && configured > 0 ? configured : 0.12;
}

function stroopsToXlm(stroops: bigint): number {
  return Number(stroops) / Number(STROOPS_PER_XLM);
}

export class GasCostTracker {
  private readonly log: DurableLog<PersistedStats>;

  constructor(dataDir?: string) {
    const dir = dataDir ?? process.env.GAS_COST_DATA_DIR ?? path.join(process.cwd(), '.data', 'gas-costs');
    this.log = new DurableLog<PersistedStats>(path.join(dir, 'operation-costs.jsonl'));
  }

  /** Record one call's resource fee (stroops) against its operation name. Never throws — cost tracking must not break the call it's observing. */
  record(operation: string, feeStroops: string | bigint | undefined): void {
    if (feeStroops === undefined) return;
    let fee: bigint;
    try {
      fee = BigInt(feeStroops);
    } catch {
      return;
    }

    const existing = this.log.get(operation);
    if (!existing) {
      this.log.set(operation, {
        callCount: 1,
        totalStroops: fee.toString(),
        minStroops: fee.toString(),
        maxStroops: fee.toString(),
      });
      return;
    }

    const total = BigInt(existing.totalStroops) + fee;
    const min = fee < BigInt(existing.minStroops) ? fee : BigInt(existing.minStroops);
    const max = fee > BigInt(existing.maxStroops) ? fee : BigInt(existing.maxStroops);
    this.log.set(operation, {
      callCount: existing.callCount + 1,
      totalStroops: total.toString(),
      minStroops: min.toString(),
      maxStroops: max.toString(),
    });
  }

  private allStats(): { operation: string; stats: PersistedStats }[] {
    return this.log.keys().map((operation) => ({ operation, stats: this.log.get(operation)! }));
  }

  getReport(): CostReport {
    const price = xlmUsdPrice();
    const entries = this.allStats();
    let totalCalls = 0;
    let totalStroops = 0n;

    const byOperation: OperationCostStats[] = entries.map(({ operation, stats }) => {
      totalCalls += stats.callCount;
      const total = BigInt(stats.totalStroops);
      totalStroops += total;
      const avg = stats.callCount > 0 ? total / BigInt(stats.callCount) : 0n;
      return {
        operation,
        callCount: stats.callCount,
        totalStroops: stats.totalStroops,
        minStroops: stats.minStroops,
        maxStroops: stats.maxStroops,
        avgStroops: avg.toString(),
      };
    });
    byOperation.sort((a, b) => Number(BigInt(b.totalStroops) - BigInt(a.totalStroops)));

    const totalXlm = stroopsToXlm(totalStroops);
    return {
      generatedAt: new Date().toISOString(),
      xlmUsdPrice: price,
      totalCalls,
      totalStroops: totalStroops.toString(),
      totalXlm,
      totalUsd: totalXlm * price,
      byOperation,
    };
  }

  /** Project cost for a hypothetical volume, using this operation's observed average fee. */
  project(operation: string, callsPerDay: number, days: number): CostProjection | null {
    const stats = this.log.get(operation);
    if (!stats || stats.callCount === 0) return null;

    const avg = BigInt(stats.totalStroops) / BigInt(stats.callCount);
    const projectedCalls = BigInt(Math.max(0, Math.round(callsPerDay * days)));
    const projectedStroops = avg * projectedCalls;
    const projectedXlm = stroopsToXlm(projectedStroops);
    const price = xlmUsdPrice();

    return {
      operation,
      callsPerDay,
      days,
      projectedStroops: projectedStroops.toString(),
      projectedXlm,
      projectedUsd: projectedXlm * price,
      basedOnAvgStroops: avg.toString(),
    };
  }

  /**
   * Flags operations worth optimizing, ranked by total XLM contribution
   * (not per-call cost) so a high-volume cheap operation outranks a
   * low-volume expensive one when it dominates actual spend.
   */
  getOptimizationRecommendations(topN = 5): OptimizationRecommendation[] {
    const report = this.getReport();
    if (report.totalStroops === '0' || report.byOperation.length === 0) return [];

    const totalStroops = BigInt(report.totalStroops);
    return report.byOperation.slice(0, topN).map((op) => {
      const share = totalStroops > 0n ? Number((BigInt(op.totalStroops) * 10000n) / totalStroops) / 100 : 0;
      const avgXlm = stroopsToXlm(BigInt(op.avgStroops));
      let reason: string;
      if (share >= 30) {
        reason = `Accounts for ${share.toFixed(1)}% of total gas spend (${op.callCount} calls) — the highest-leverage target for optimization; even a small per-call reduction compounds across volume.`;
      } else if (avgXlm > stroopsToXlm(totalStroops / BigInt(Math.max(1, report.totalCalls))) * 2) {
        reason = `Average cost per call (${avgXlm.toFixed(7)} XLM) is more than 2x the overall per-call average — investigate whether this operation reads/writes more contract state than necessary.`;
      } else {
        reason = `High call volume (${op.callCount} calls) — batching or caching (see rpcCircuitBreaker.ts's fallback cache) may reduce redundant simulations.`;
      }
      return {
        operation: op.operation,
        totalXlmContribution: stroopsToXlm(BigInt(op.totalStroops)),
        callCount: op.callCount,
        avgStroops: op.avgStroops,
        reason,
      };
    });
  }

  /** Reset all recorded stats — for testing only. */
  _resetForTest(): void {
    for (const key of this.log.keys()) this.log.delete(key);
  }
}

let defaultTracker: GasCostTracker | undefined;

export function getDefaultGasCostTracker(): GasCostTracker {
  if (!defaultTracker) defaultTracker = new GasCostTracker();
  return defaultTracker;
}

export function _setDefaultGasCostTrackerForTest(tracker: GasCostTracker | undefined): void {
  defaultTracker = tracker;
}
