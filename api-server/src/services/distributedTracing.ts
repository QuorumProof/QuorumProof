import { logger } from './logger.js';

interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  status: 'active' | 'completed' | 'error';
  attributes: Record<string, any>;
  events: Array<{ timestamp: number; name: string; attributes?: Record<string, any> }>;
  error?: string;
}

interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

class DistributedTracer {
  private spans: Map<string, TraceSpan> = new Map();
  private traceContexts: Map<string, TraceContext> = new Map();
  private readonly MAX_SPANS = 10000;

  generateTraceId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }

  generateSpanId(): string {
    return Math.random().toString(36).slice(2, 11);
  }

  startSpan(
    name: string,
    attributes: Record<string, any> = {},
    parentSpanId?: string,
  ): TraceSpan {
    const traceId = attributes.traceId || this.generateTraceId();
    const spanId = this.generateSpanId();

    const span: TraceSpan = {
      traceId,
      spanId,
      parentSpanId,
      name,
      startTime: Date.now(),
      status: 'active',
      attributes: { ...attributes, traceId },
      events: [],
    };

    // Store with size limit
    if (this.spans.size >= this.MAX_SPANS) {
      const oldestKey = this.spans.keys().next().value;
      this.spans.delete(oldestKey);
    }

    const spanKey = `${traceId}:${spanId}`;
    this.spans.set(spanKey, span);

    logger.debug(
      `Span started: ${name}`,
      'tracing',
      {
        traceId,
        spanId,
        parentSpanId,
        attributes,
      },
    );

    return span;
  }

  endSpan(traceId: string, spanId: string, status: 'completed' | 'error' = 'completed', error?: string): TraceSpan | null {
    const spanKey = `${traceId}:${spanId}`;
    const span = this.spans.get(spanKey);

    if (!span) {
      logger.warn(`Attempt to end non-existent span`, 'tracing', { traceId, spanId });
      return null;
    }

    span.endTime = Date.now();
    span.duration = span.endTime - span.startTime;
    span.status = status;
    if (error) {
      span.error = error;
    }

    logger.debug(
      `Span ended: ${span.name}`,
      'tracing',
      {
        traceId,
        spanId,
        duration: span.duration,
        status,
      },
    );

    return span;
  }

  addEvent(
    traceId: string,
    spanId: string,
    eventName: string,
    attributes?: Record<string, any>,
  ): void {
    const spanKey = `${traceId}:${spanId}`;
    const span = this.spans.get(spanKey);

    if (!span) {
      logger.warn(`Attempt to add event to non-existent span`, 'tracing', { traceId, spanId, eventName });
      return;
    }

    span.events.push({
      timestamp: Date.now(),
      name: eventName,
      attributes,
    });
  }

  addAttribute(
    traceId: string,
    spanId: string,
    key: string,
    value: any,
  ): void {
    const spanKey = `${traceId}:${spanId}`;
    const span = this.spans.get(spanKey);

    if (!span) {
      logger.warn(`Attempt to add attribute to non-existent span`, 'tracing', { traceId, spanId });
      return;
    }

    span.attributes[key] = value;
  }

  getTrace(traceId: string): TraceSpan[] {
    return Array.from(this.spans.values()).filter(span => span.traceId === traceId);
  }

  getSpan(traceId: string, spanId: string): TraceSpan | null {
    const spanKey = `${traceId}:${spanId}`;
    return this.spans.get(spanKey) || null;
  }

  exportToJaeger(traceId: string): Record<string, any> {
    const trace = this.getTrace(traceId);

    if (trace.length === 0) {
      return {};
    }

    return {
      traceID: traceId,
      spans: trace.map(span => ({
        traceID: span.traceId,
        spanID: span.spanId,
        operationName: span.name,
        references: span.parentSpanId
          ? [{ refType: 'CHILD_OF', traceID: span.traceId, spanID: span.parentSpanId }]
          : [],
        startTime: span.startTime * 1000, // Convert to microseconds
        duration: (span.duration || 0) * 1000, // Convert to microseconds
        tags: Object.entries(span.attributes).map(([key, value]) => ({
          key,
          value,
        })),
        logs: span.events.map(event => ({
          timestamp: event.timestamp * 1000, // Convert to microseconds
          fields: [{ key: 'event', value: event.name }, ...Object.entries(event.attributes || {}).map(([k, v]) => ({ key: k, value: v }))],
        })),
      })),
    };
  }

  getMetrics(): Record<string, any> {
    const spans = Array.from(this.spans.values());
    const completedSpans = spans.filter(s => s.status === 'completed');
    const errorSpans = spans.filter(s => s.status === 'error');

    const durations = completedSpans
      .filter(s => s.duration !== undefined)
      .map(s => s.duration as number);

    const avgDuration = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;

    return {
      totalSpans: spans.length,
      completedSpans: completedSpans.length,
      errorSpans: errorSpans.length,
      averageDuration: Math.round(avgDuration),
      maxDuration: Math.max(...durations, 0),
      minDuration: Math.min(...durations, 0),
    };
  }
}

const distributedTracer = new DistributedTracer();

export { distributedTracer, DistributedTracer, TraceSpan, TraceContext };
