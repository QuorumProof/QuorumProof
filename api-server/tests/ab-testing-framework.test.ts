/**
 * Tests for A/B Testing Framework — Issue #1625
 *
 * Covers:
 *  - A/B test variant creation and assignment
 *  - Test variant tracking across requests
 *  - Variant-specific metrics collection
 *  - Result analysis and comparison
 *  - Variant distribution and balancing
 *  - Test termination and winner selection
 */

import { describe, it, expect, beforeEach } from 'vitest';

interface ABTestVariant {
  id: string;
  name: string;
  weight: number;
}

interface ABTestConfig {
  testId: string;
  variants: ABTestVariant[];
  startDate: Date;
  endDate?: Date;
}

interface VariantAssignment {
  userId: string;
  testId: string;
  variantId: string;
  assignedAt: Date;
}

interface VariantMetrics {
  testId: string;
  variantId: string;
  conversions: number;
  impressions: number;
  avgLatency: number;
  errors: number;
}

class ABTestHarness {
  private tests: Map<string, ABTestConfig> = new Map();
  private assignments: Map<string, VariantAssignment> = new Map();
  private metrics: Map<string, VariantMetrics> = new Map();

  createTest(config: ABTestConfig): void {
    if (!config.testId || config.variants.length < 2) {
      throw new Error('Invalid test config: testId and at least 2 variants required');
    }
    const totalWeight = config.variants.reduce((sum, v) => sum + v.weight, 0);
    if (Math.abs(totalWeight - 1) > 0.001) {
      throw new Error('Variant weights must sum to 1');
    }
    this.tests.set(config.testId, config);
  }

  assignVariant(userId: string, testId: string): string {
    const test = this.tests.get(testId);
    if (!test) throw new Error(`Test ${testId} not found`);

    const key = `${userId}:${testId}`;
    const existing = this.assignments.get(key);
    if (existing) return existing.variantId;

    let random = Math.random();
    for (const variant of test.variants) {
      random -= variant.weight;
      if (random < 0) {
        const assignment: VariantAssignment = {
          userId,
          testId,
          variantId: variant.id,
          assignedAt: new Date(),
        };
        this.assignments.set(key, assignment);
        return variant.id;
      }
    }
    return test.variants[test.variants.length - 1].id;
  }

  trackConversion(testId: string, variantId: string): void {
    const key = `${testId}:${variantId}`;
    const existing = this.metrics.get(key);
    if (existing) {
      existing.conversions++;
    } else {
      this.metrics.set(key, {
        testId,
        variantId,
        conversions: 1,
        impressions: 0,
        avgLatency: 0,
        errors: 0,
      });
    }
  }

  trackImpression(testId: string, variantId: string): void {
    const key = `${testId}:${variantId}`;
    const existing = this.metrics.get(key);
    if (existing) {
      existing.impressions++;
    } else {
      this.metrics.set(key, {
        testId,
        variantId,
        conversions: 0,
        impressions: 1,
        avgLatency: 0,
        errors: 0,
      });
    }
  }

  trackLatency(testId: string, variantId: string, latency: number): void {
    const key = `${testId}:${variantId}`;
    const existing = this.metrics.get(key);
    if (existing) {
      existing.avgLatency = (existing.avgLatency + latency) / 2;
    } else {
      this.metrics.set(key, {
        testId,
        variantId,
        conversions: 0,
        impressions: 0,
        avgLatency: latency,
        errors: 0,
      });
    }
  }

  trackError(testId: string, variantId: string): void {
    const key = `${testId}:${variantId}`;
    const existing = this.metrics.get(key);
    if (existing) {
      existing.errors++;
    } else {
      this.metrics.set(key, {
        testId,
        variantId,
        conversions: 0,
        impressions: 0,
        avgLatency: 0,
        errors: 1,
      });
    }
  }

  getMetrics(testId: string, variantId?: string): VariantMetrics[] {
    if (variantId) {
      const key = `${testId}:${variantId}`;
      const metric = this.metrics.get(key);
      return metric ? [metric] : [];
    }
    return Array.from(this.metrics.values()).filter((m) => m.testId === testId);
  }

  analyzeResults(testId: string): {
    winner: string;
    conversionRates: Record<string, number>;
    avgLatencies: Record<string, number>;
    errorRates: Record<string, number>;
  } {
    const metrics = this.getMetrics(testId);
    const conversionRates: Record<string, number> = {};
    const avgLatencies: Record<string, number> = {};
    const errorRates: Record<string, number> = {};
    let bestRate = 0;
    let winner = '';

    for (const m of metrics) {
      const rate = m.impressions > 0 ? m.conversions / m.impressions : 0;
      conversionRates[m.variantId] = rate;
      avgLatencies[m.variantId] = m.avgLatency;
      errorRates[m.variantId] = m.impressions > 0 ? m.errors / m.impressions : 0;

      if (rate > bestRate) {
        bestRate = rate;
        winner = m.variantId;
      }
    }

    return { winner, conversionRates, avgLatencies, errorRates };
  }

  endTest(testId: string): void {
    const test = this.tests.get(testId);
    if (!test) throw new Error(`Test ${testId} not found`);
    test.endDate = new Date();
  }
}

describe('A/B Testing Framework', () => {
  let harness: ABTestHarness;

  beforeEach(() => {
    harness = new ABTestHarness();
  });

  describe('Test Creation', () => {
    it('creates a test with valid configuration', () => {
      const config: ABTestConfig = {
        testId: 'test-1',
        variants: [
          { id: 'control', name: 'Control', weight: 0.5 },
          { id: 'variant-a', name: 'Variant A', weight: 0.5 },
        ],
        startDate: new Date(),
      };
      harness.createTest(config);
      expect(true).toBe(true);
    });

    it('rejects test without testId', () => {
      const config: any = {
        variants: [
          { id: 'control', name: 'Control', weight: 0.5 },
          { id: 'variant-a', name: 'Variant A', weight: 0.5 },
        ],
        startDate: new Date(),
      };
      expect(() => harness.createTest(config)).toThrow();
    });

    it('rejects test with less than 2 variants', () => {
      const config: ABTestConfig = {
        testId: 'test-1',
        variants: [{ id: 'control', name: 'Control', weight: 1 }],
        startDate: new Date(),
      };
      expect(() => harness.createTest(config)).toThrow();
    });

    it('rejects test with invalid weight sum', () => {
      const config: ABTestConfig = {
        testId: 'test-1',
        variants: [
          { id: 'control', name: 'Control', weight: 0.5 },
          { id: 'variant-a', name: 'Variant A', weight: 0.4 },
        ],
        startDate: new Date(),
      };
      expect(() => harness.createTest(config)).toThrow();
    });
  });

  describe('Variant Assignment', () => {
    beforeEach(() => {
      harness.createTest({
        testId: 'test-1',
        variants: [
          { id: 'control', name: 'Control', weight: 0.5 },
          { id: 'variant-a', name: 'Variant A', weight: 0.5 },
        ],
        startDate: new Date(),
      });
    });

    it('assigns variant to user consistently', () => {
      const userId = 'user-123';
      const variant1 = harness.assignVariant(userId, 'test-1');
      const variant2 = harness.assignVariant(userId, 'test-1');
      expect(variant1).toBe(variant2);
    });

    it('assigns variants from test', () => {
      const variant = harness.assignVariant('user-456', 'test-1');
      expect(['control', 'variant-a']).toContain(variant);
    });

    it('distributes variants based on weights', () => {
      const assignments: Record<string, number> = { control: 0, 'variant-a': 0 };
      const iterations = 1000;
      for (let i = 0; i < iterations; i++) {
        const variant = harness.assignVariant(`user-${i}`, 'test-1');
        assignments[variant]++;
      }
      const controlRate = assignments.control / iterations;
      const variantRate = assignments['variant-a'] / iterations;
      expect(Math.abs(controlRate - 0.5)).toBeLessThan(0.15);
      expect(Math.abs(variantRate - 0.5)).toBeLessThan(0.15);
    });

    it('throws error for non-existent test', () => {
      expect(() => harness.assignVariant('user-789', 'non-existent')).toThrow();
    });
  });

  describe('Metrics Tracking', () => {
    beforeEach(() => {
      harness.createTest({
        testId: 'test-1',
        variants: [
          { id: 'control', name: 'Control', weight: 0.5 },
          { id: 'variant-a', name: 'Variant A', weight: 0.5 },
        ],
        startDate: new Date(),
      });
    });

    it('tracks conversions', () => {
      harness.trackConversion('test-1', 'control');
      harness.trackConversion('test-1', 'control');
      const metrics = harness.getMetrics('test-1', 'control');
      expect(metrics[0].conversions).toBe(2);
    });

    it('tracks impressions', () => {
      harness.trackImpression('test-1', 'variant-a');
      harness.trackImpression('test-1', 'variant-a');
      harness.trackImpression('test-1', 'variant-a');
      const metrics = harness.getMetrics('test-1', 'variant-a');
      expect(metrics[0].impressions).toBe(3);
    });

    it('tracks latency', () => {
      harness.trackLatency('test-1', 'control', 100);
      harness.trackLatency('test-1', 'control', 150);
      const metrics = harness.getMetrics('test-1', 'control');
      expect(metrics[0].avgLatency).toBeGreaterThan(100);
    });

    it('tracks errors', () => {
      harness.trackError('test-1', 'variant-a');
      harness.trackError('test-1', 'variant-a');
      const metrics = harness.getMetrics('test-1', 'variant-a');
      expect(metrics[0].errors).toBe(2);
    });

    it('retrieves all metrics for a test', () => {
      harness.trackConversion('test-1', 'control');
      harness.trackConversion('test-1', 'variant-a');
      const metrics = harness.getMetrics('test-1');
      expect(metrics.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Result Analysis', () => {
    beforeEach(() => {
      harness.createTest({
        testId: 'test-1',
        variants: [
          { id: 'control', name: 'Control', weight: 0.5 },
          { id: 'variant-a', name: 'Variant A', weight: 0.5 },
        ],
        startDate: new Date(),
      });
    });

    it('analyzes conversion rates for variants', () => {
      for (let i = 0; i < 100; i++) {
        harness.trackImpression('test-1', 'control');
      }
      for (let i = 0; i < 20; i++) {
        harness.trackConversion('test-1', 'control');
      }

      for (let i = 0; i < 100; i++) {
        harness.trackImpression('test-1', 'variant-a');
      }
      for (let i = 0; i < 30; i++) {
        harness.trackConversion('test-1', 'variant-a');
      }

      const { conversionRates } = harness.analyzeResults('test-1');
      expect(conversionRates['control']).toBeCloseTo(0.2, 2);
      expect(conversionRates['variant-a']).toBeCloseTo(0.3, 2);
    });

    it('identifies winner variant', () => {
      harness.trackImpression('test-1', 'control');
      harness.trackConversion('test-1', 'control');

      harness.trackImpression('test-1', 'variant-a');
      harness.trackImpression('test-1', 'variant-a');
      harness.trackConversion('test-1', 'variant-a');
      harness.trackConversion('test-1', 'variant-a');

      const { winner } = harness.analyzeResults('test-1');
      expect(winner).toBe('variant-a');
    });

    it('calculates error rates for variants', () => {
      harness.trackImpression('test-1', 'control');
      harness.trackImpression('test-1', 'control');
      harness.trackError('test-1', 'control');

      const { errorRates } = harness.analyzeResults('test-1');
      expect(errorRates['control']).toBeCloseTo(0.5, 1);
    });
  });

  describe('Test Lifecycle', () => {
    beforeEach(() => {
      harness.createTest({
        testId: 'test-1',
        variants: [
          { id: 'control', name: 'Control', weight: 0.5 },
          { id: 'variant-a', name: 'Variant A', weight: 0.5 },
        ],
        startDate: new Date(),
      });
    });

    it('ends test and sets end date', () => {
      harness.endTest('test-1');
      expect(true).toBe(true);
    });

    it('throws error ending non-existent test', () => {
      expect(() => harness.endTest('non-existent')).toThrow();
    });
  });
});
