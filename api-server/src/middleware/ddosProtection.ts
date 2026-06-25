import { Request, Response, NextFunction } from 'express';

export interface DDoSProtectionConfig {
  maxBodySize: number;
  maxConcurrentPerIp: number;
  burstWindowMs: number;
  burstMaxRequests: number;
}

interface IpConnection {
  count: number;
  timestamps: number[];
}

const DEFAULT_CONFIG: DDoSProtectionConfig = {
  maxBodySize: 100 * 1024,
  maxConcurrentPerIp: 20,
  burstWindowMs: 2000,
  burstMaxRequests: 20,
};

export function createDDoSProtection(config?: Partial<DDoSProtectionConfig>) {
  const opts = { ...DEFAULT_CONFIG, ...config };
  const connections = new Map<string, IpConnection>();

  function clientIp(req: Request): string {
    return (req.ip ?? req.socket.remoteAddress ?? 'unknown');
  }

  function middleware(req: Request, res: Response, next: NextFunction): void {
    const ip = clientIp(req);

    const conn = connections.get(ip) ?? { count: 0, timestamps: [] };
    conn.count++;
    conn.timestamps.push(Date.now());
    connections.set(ip, conn);

    res.on('finish', () => {
      const c = connections.get(ip);
      if (c) {
        c.count--;
        if (c.count <= 0 && c.timestamps.length === 0) {
          connections.delete(ip);
        }
      }
    });

    if (conn.count > opts.maxConcurrentPerIp) {
      res.status(429).json({
        error: 'Too many concurrent requests',
        message: `Maximum ${opts.maxConcurrentPerIp} concurrent requests per IP allowed`,
      });
      return;
    }

    const now = Date.now();
    const windowStart = now - opts.burstWindowMs;
    while (conn.timestamps.length > 0 && conn.timestamps[0] < windowStart) {
      conn.timestamps.shift();
    }
    if (conn.timestamps.length > opts.burstMaxRequests) {
      res.status(429).json({
        error: 'Request burst detected',
        message: `Maximum ${opts.burstMaxRequests} requests per ${opts.burstWindowMs}ms allowed`,
      });
      return;
    }

    const contentLength = parseInt(req.headers['content-length'] ?? '0', 10);
    if (!isNaN(contentLength) && contentLength > opts.maxBodySize) {
      res.status(413).json({
        error: 'Request entity too large',
        message: `Maximum body size is ${opts.maxBodySize} bytes`,
      });
      return;
    }

    next();
  }

  middleware.reset = () => connections.clear();
  middleware.connections = connections;

  return middleware;
}
