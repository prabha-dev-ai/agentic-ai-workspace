import type { ErrorRequestHandler } from 'express';
import { HttpError } from './HttpError.ts';
import { ValidationError } from '../core/security/index.ts';
import { WorkflowError } from '../core/workflow/index.ts';
import { StreamError } from '../core/streaming/index.ts';
import type { ObservabilityService } from '../core/observability/index.ts';
import type { SecurityService } from '../core/security/index.ts';

export interface ErrorHandlerDependencies {
  observability: ObservabilityService;
  security: SecurityService;
}

// The single place an HTTP status code is chosen for a thrown error.
// Express 5 forwards both synchronous throws and rejected promises from
// route handlers here automatically, so controllers never need their own
// try/catch/next boilerplate (chat.controller.ts predates Express 5's
// auto-forwarding and keeps its manual catch for that reason — every new
// controller relies on this handler instead). Known, well-typed domain
// errors map to 400 (they are always caller-input problems); anything
// unrecognized is logged and reported as a generic 500 — internal details
// (stack traces, provider errors) must never reach the client.
export function createErrorHandler(deps: ErrorHandlerDependencies): ErrorRequestHandler {
  const logger = deps.observability.getLogger('http.errors');

  return (err, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }

    const message = err instanceof Error ? err.message : String(err);

    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ error: message });
      return;
    }

    if (err instanceof ValidationError || err instanceof WorkflowError || err instanceof StreamError) {
      res.status(400).json({ error: message });
      return;
    }

    logger.error('unhandled request error', {
      method: req.method,
      path: req.path,
      error: deps.security.redact(message),
    });
    res.status(500).json({ error: 'Internal server error.' });
  };
}
