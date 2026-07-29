import { logger } from './logger.js';

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  checks: Record<string, HealthCheckResult>;
}

interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  message?: string;
  responseTime?: number;
  error?: string;
}

interface ReadinessStatus {
  ready: boolean;
  timestamp: string;
  services: Record<string, boolean>;
}

interface LivenessStatus {
  alive: boolean;
  timestamp: string;
  memoryUsage: NodeJS.MemoryUsage;
  uptime: number;
}

class HealthCheckManager {
  private startTime = Date.now();
  private healthChecks: Map<string, () => Promise<HealthCheckResult>> = new Map();
  private readinessChecks: Map<string, () => Promise<boolean>> = new Map();

  registerHealthCheck(name: string, check: () => Promise<HealthCheckResult>): void {
    this.healthChecks.set(name, check);
    logger.info(`Health check registered: ${name}`, 'health-check');
  }

  registerReadinessCheck(name: string, check: () => Promise<boolean>): void {
    this.readinessChecks.set(name, check);
    logger.info(`Readiness check registered: ${name}`, 'health-check');
  }

  async getHealthStatus(): Promise<HealthStatus> {
    const checks: Record<string, HealthCheckResult> = {};
    let overallStatus: HealthStatus['status'] = 'healthy';

    for (const [name, checkFn] of this.healthChecks) {
      try {
        const startTime = Date.now();
        const result = await checkFn();
        result.responseTime = Date.now() - startTime;
        checks[name] = result;

        if (result.status === 'unhealthy') {
          overallStatus = 'unhealthy';
        } else if (result.status === 'degraded' && overallStatus !== 'unhealthy') {
          overallStatus = 'degraded';
        }
      } catch (error) {
        checks[name] = {
          status: 'unhealthy',
          error: error instanceof Error ? error.message : String(error),
        };
        overallStatus = 'unhealthy';
      }
    }

    const status: HealthStatus = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptime: Date.now() - this.startTime,
      checks,
    };

    logger.debug(
      `Health check completed`,
      'health-check',
      { status: overallStatus, checksCount: Object.keys(checks).length },
    );

    return status;
  }

  async getReadinessStatus(): Promise<ReadinessStatus> {
    const services: Record<string, boolean> = {};
    let ready = true;

    for (const [name, checkFn] of this.readinessChecks) {
      try {
        services[name] = await checkFn();
        if (!services[name]) {
          ready = false;
        }
      } catch (error) {
        services[name] = false;
        ready = false;
        logger.warn(
          `Readiness check failed: ${name}`,
          'health-check',
          { error: error instanceof Error ? error.message : String(error) },
        );
      }
    }

    return {
      ready,
      timestamp: new Date().toISOString(),
      services,
    };
  }

  getLivenessStatus(): LivenessStatus {
    return {
      alive: true,
      timestamp: new Date().toISOString(),
      memoryUsage: process.memoryUsage(),
      uptime: Date.now() - this.startTime,
    };
  }
}

const healthCheckManager = new HealthCheckManager();

// Register default health checks
healthCheckManager.registerHealthCheck('memory', async () => {
  const memUsage = process.memoryUsage();
  const heapUsedPercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;

  if (heapUsedPercent > 95) {
    return { status: 'unhealthy', message: `Heap usage critical: ${heapUsedPercent.toFixed(2)}%` };
  }

  if (heapUsedPercent > 80) {
    return { status: 'degraded', message: `Heap usage high: ${heapUsedPercent.toFixed(2)}%` };
  }

  return {
    status: 'healthy',
    message: `Heap usage normal: ${heapUsedPercent.toFixed(2)}%`,
  };
});

healthCheckManager.registerHealthCheck('process', async () => {
  if (!process.cpuUsage) {
    return { status: 'healthy', message: 'Process running' };
  }

  const cpu = process.cpuUsage();
  const totalTime = (cpu.user + cpu.system) / 1000;

  return {
    status: 'healthy',
    message: `CPU time: ${totalTime.toFixed(2)}ms`,
  };
});

// Register default readiness checks
healthCheckManager.registerReadinessCheck('startup', async () => {
  const uptime = Date.now() - healthCheckManager['startTime'];
  const minStartupTime = 1000; // 1 second minimum startup
  return uptime >= minStartupTime;
});

export { healthCheckManager, HealthCheckManager, HealthStatus, ReadinessStatus, LivenessStatus };
