import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AuthService } from '../core/auth/index.ts';
import type { ObservabilityService } from '../core/observability/index.ts';
import type { TraceManager } from '../core/tracing/index.ts';
import type { MetricsRegistry } from '../core/metrics/index.ts';

export interface AuthenticateDependencies {
  auth: AuthService;
  observability: ObservabilityService;
  tracing: TraceManager;
  metrics: MetricsRegistry;
}

/**
 * Identifies the caller if credentials are present on the request —
 * never rejects by itself. authorize.middleware.ts's requireAuth()/
 * requirePermission() decide whether an unauthenticated request is
 * actually allowed through for a given route. Mounted globally (once,
 * before any router) so every route's res.locals.principal is populated
 * consistently, the same way requestContext.middleware.ts populates
 * res.locals.requestId/logger for every request regardless of route.
 */
export function createAuthenticateMiddleware(deps: AuthenticateDependencies): RequestHandler {
  const { auth, observability, tracing, metrics } = deps;
  const logger = observability.getLogger('security.audit');
  const tracer = tracing.getTracer('security.auth');
  const attempts = metrics.counter(
    'auth_attempts_total',
    'Authentication attempts, by method and result.',
  );

  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header('authorization');
    if (!header) {
      next();
      return;
    }

    const [scheme, credential] = header.split(' ');
    if (!scheme || !credential) {
      next();
      return;
    }

    const method = scheme === 'Bearer' ? 'jwt' : 'api-key';

    tracer.withSpan(
      'auth.authenticate',
      (span) => {
        const principal = auth.authenticate(scheme, credential);
        span.setAttribute('auth.method', method);
        span.setAttribute('auth.result', principal ? 'success' : 'failure');

        if (principal) {
          (res.locals as Record<string, unknown>).principal = principal;
          attempts.inc(1, { method, result: 'success' });
          logger.info('authentication succeeded', {
            subject: principal.subject,
            method: principal.authMethod,
            path: req.path,
          });
        } else {
          attempts.inc(1, { method, result: 'failure' });
          logger.warn('authentication failed', {
            method,
            path: req.path,
            // Never log the raw credential — only its length, enough to
            // spot "empty header" vs "wrong key" during an incident
            // without ever putting a real secret in a log line.
            credentialLength: credential.length,
          });
        }
      },
      { attributes: { 'http.path': req.path } },
    );

    next();
  };
}
