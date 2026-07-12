import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { SpanStatus } from '../core/tracing/index.ts';
import type { ObservabilityService, Logger } from '../core/observability/index.ts';
import type { TraceManager } from '../core/tracing/index.ts';
import type { MetricsRegistry } from '../core/metrics/index.ts';

export interface RequestContextDependencies {
  observability: ObservabilityService;
  tracing: TraceManager;
  metrics: MetricsRegistry;
}

/** What every downstream handler can read off res.locals once this middleware has run. */
export interface RequestLocals {
  requestId: string;
  logger: Logger;
}

// The one place every request touches Observability, Tracing, and Metrics
// on the way in and out — controllers stay free of that plumbing. Mirrors
// the framework's existing event-bus bridges (ObservabilityService/
// TraceManager.observeEventBus): one correlation id ties the log entry,
// the span, and the metric labels for a single request together.
export function createRequestContextMiddleware(deps: RequestContextDependencies): RequestHandler {
  const { observability, tracing, metrics } = deps;
  const httpLogger = observability.getLogger('http');
  const httpTracer = tracing.getTracer('http');
  const requestsTotal = metrics.counter('http_requests_total', 'Total HTTP requests handled.');
  const requestDuration = metrics.histogram(
    'http_request_duration_ms',
    'HTTP request duration in milliseconds.',
  );

  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = req.header('x-request-id') || randomUUID();
    res.setHeader('X-Request-Id', requestId);

    const logger = httpLogger.withCorrelation(requestId);
    const span = httpTracer.startSpan(`${req.method} ${req.path}`, {
      attributes: { 'http.method': req.method, 'http.path': req.path },
    });

    const locals: RequestLocals = { requestId, logger };
    Object.assign(res.locals, locals);

    const startedAt = Date.now();
    logger.info('request started', { method: req.method, path: req.path });

    res.on('finish', () => {
      const durationMs = Date.now() - startedAt;
      const labels = { method: req.method, route: req.path, status: String(res.statusCode) };

      span.setAttribute('http.status_code', res.statusCode);
      span.end(res.statusCode >= 500 ? SpanStatus.Error : SpanStatus.Ok);

      logger.info('request completed', {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs,
      });

      requestsTotal.inc(1, labels);
      requestDuration.observe(durationMs, labels);
    });

    next();
  };
}
