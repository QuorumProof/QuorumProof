import { Router, Request, Response } from 'express';
import { distributedTracer } from '../services/distributedTracing.js';
import { logger } from '../services/logger.js';

const router = Router();

// GET /api/tracing/trace/:traceId - Get trace by ID
router.get('/trace/:traceId', (req: Request, res: Response) => {
  try {
    const traceId = String(req.params.traceId);

    const trace = distributedTracer.getTrace(traceId);

    if (trace.length === 0) {
      res.status(404).json({ error: 'Trace not found' });
      return;
    }

    res.json({
      traceId,
      spanCount: trace.length,
      spans: trace,
    });
  } catch (error) {
    logger.error(
      `Error fetching trace`,
      'tracing',
      { error: error instanceof Error ? error.message : String(error) },
    );
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/tracing/span/:traceId/:spanId - Get specific span
router.get('/span/:traceId/:spanId', (req: Request, res: Response) => {
  try {
    const traceId = String(req.params.traceId);
    const spanId = String(req.params.spanId);

    const span = distributedTracer.getSpan(traceId, spanId);

    if (!span) {
      res.status(404).json({ error: 'Span not found' });
      return;
    }

    res.json(span);
  } catch (error) {
    logger.error(
      `Error fetching span`,
      'tracing',
      { error: error instanceof Error ? error.message : String(error) },
    );
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/tracing/jaeger/:traceId - Export trace in Jaeger format
router.get('/jaeger/:traceId', (req: Request, res: Response) => {
  try {
    const traceId = String(req.params.traceId);

    const jaegerTrace = distributedTracer.exportToJaeger(traceId);

    if (!jaegerTrace.traceID) {
      res.status(404).json({ error: 'Trace not found' });
      return;
    }

    res.json(jaegerTrace);
  } catch (error) {
    logger.error(
      `Error exporting trace to Jaeger format`,
      'tracing',
      { error: error instanceof Error ? error.message : String(error) },
    );
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/tracing/metrics - Get tracing metrics
router.get('/metrics', (_req: Request, res: Response) => {
  try {
    const metrics = distributedTracer.getMetrics();

    res.json({
      timestamp: new Date().toISOString(),
      ...metrics,
    });
  } catch (error) {
    logger.error(
      `Error fetching tracing metrics`,
      'tracing',
      { error: error instanceof Error ? error.message : String(error) },
    );
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
