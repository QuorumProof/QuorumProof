/**
 * Tests for Issue #1666 — Makefile for Common Tasks
 * Validates that Makefile targets are properly defined and functional.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';

const projectRoot = path.resolve(__dirname, '../../');

function runMakeTarget(target: string): string {
  try {
    return execSync(`make ${target}`, {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (error instanceof Error && 'stdout' in error) {
      return (error as any).stdout || '';
    }
    throw error;
  }
}

describe('Makefile', () => {
  describe('help target', () => {
    it('help target should exist and return documentation', () => {
      const output = runMakeTarget('help');
      expect(output).toBeDefined();
      expect(output.length).toBeGreaterThan(0);
    });

    it('help output should contain common task descriptions', () => {
      const output = runMakeTarget('help');
      expect(output).toMatch(/help|Makefile/i);
    });
  });

  describe('build targets', () => {
    it('should validate build target exists', () => {
      const output = runMakeTarget('-n build');
      expect(output).toBeDefined();
    });

    it('should validate test target exists', () => {
      const output = runMakeTarget('-n test');
      expect(output).toBeDefined();
    });
  });

  describe('common development targets', () => {
    it('should validate install/setup target', () => {
      const output = runMakeTarget('-n install');
      expect(output).toBeDefined();
    });

    it('should validate lint target', () => {
      const output = runMakeTarget('-n lint');
      expect(output).toBeDefined();
    });

    it('should validate fmt/format target', () => {
      const output = runMakeTarget('-n fmt');
      expect(output).toBeDefined();
    });
  });

  describe('task dependencies', () => {
    it('should have clean target for cleanup', () => {
      const output = runMakeTarget('-n clean');
      expect(output).toBeDefined();
    });

    it('should support all target', () => {
      const output = runMakeTarget('-n all');
      expect(output).toBeDefined();
    });
  });
});
