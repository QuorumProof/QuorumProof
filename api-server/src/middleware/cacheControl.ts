import { Request, Response, NextFunction } from 'express';

const CACHE_CONTROL_VALUE = 'private, max-age=30, must-revalidate';

export function cacheControl(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET' && !res.getHeader('Cache-Control')) {
    res.setHeader('Cache-Control', CACHE_CONTROL_VALUE);
  }
  next();
}
