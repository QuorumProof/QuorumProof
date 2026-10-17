import { describe, expect, it } from 'vitest';
import { HealthCheckManager } from '../src/services/healthCheck.js';

describe('HealthCheckManager', () => {
  it('aggregates healthy, degraded, unhealthy, and thrown health checks', async () => {
    const manager = new HealthCheckManager();
    manager.registerHealthCheck('healthy', async () => ({ status: 'healthy' }));
    manager.registerHealthCheck('degraded', async () => ({ status: 'degraded', message: 'high load' }));
    manager.registerHealthCheck('throws', async () => {
      throw new Error('dependency unavailable');
    });

    const result = await manager.getHealthStatus();

    expect(result.status).toBe('unhealthy');
    expect(result.checks['healthy']).toMatchObject({ status: 'healthy' });
    expect(result.checks['degraded']).toMatchObject({ status: 'degraded', message: 'high load' });
    expect(result.checks['throws']).toMatchObject({
      status: 'unhealthy',
      error: 'dependency unavailable',
    });
    expect(result.checks['healthy']?.responseTime).toEqual(expect.any(Number));
    expect(Date.parse(result.timestamp)).not.toBeNaN();
    expect(result.uptime).toBeGreaterThanOrEqual(0);
  });

  it('keeps the aggregate degraded when no check reports unhealthy', async () => {
    const manager = new HealthCheckManager();
    manager.registerHealthCheck('cache', async () => ({ status: 'degraded' }));

    await expect(manager.getHealthStatus()).resolves.toMatchObject({
      status: 'degraded',
      checks: { cache: { status: 'degraded' } },
    });
  });

  it('reports readiness false for failed or throwing service checks', async () => {
    const manager = new HealthCheckManager();
    manager.registerReadinessCheck('database', async () => false);
    manager.registerReadinessCheck('queue', async () => {
      throw new Error('queue unavailable');
    });

    const result = await manager.getReadinessStatus();

    expect(result.ready).toBe(false);
    expect(result.services).toEqual({ database: false, queue: false });
    expect(Date.parse(result.timestamp)).not.toBeNaN();
  });

  it('reports liveness independently of readiness and health checks', () => {
    const manager = new HealthCheckManager();

    const result = manager.getLivenessStatus();

    expect(result.alive).toBe(true);
    expect(result.memoryUsage.heapUsed).toEqual(expect.any(Number));
    expect(result.uptime).toBeGreaterThanOrEqual(0);
    expect(Date.parse(result.timestamp)).not.toBeNaN();
  });
});
