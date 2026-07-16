import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Principal, RateLimiter } from '../core/auth/index.ts';
import type { ObservabilityService } from '../core/observability/index.ts';
import type { MetricsRegistry } from '../core/metrics/index.ts';
import { HttpError } from './HttpError.ts';

export interface RateLimitDependencies {
  rateLimiter: RateLimiter;
  observability: ObservabilityService;
  metrics: MetricsRegistry;
}

/**
 * Mounted once, globally, after createAuthenticateMiddleware — so it can
 * key by the authenticated principal's subject when one is present, and
 * fall back to the request IP otherwise (an unauthenticated caller still
 * gets rate-limited; only enabled at all when RATE_LIMIT_WINDOW_MS/
 * RATE_LIMIT_MAX are both configured — see config/env.ts).
 */
export function createRateLimitMiddleware(deps: RateLimitDependencies): RequestHandler {
  const { rateLimiter, observability, metrics } = deps;
  const logger = observability.getLogger('security.audit');
  const exceeded = metrics.counter(
    'rate_limit_exceeded_total',
    'Requests rejected for exceeding the rate limit.',
  );

  return (req: Request, res: Response, next: NextFunction): void => {
    const principal = (res.locals as Record<string, unknown>).principal as Principal | undefined;
    const key = principal?.subject ?? req.ip ?? 'unknown';

    const result = rateLimiter.consume(key);
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));

    if (!result.allowed) {
      const retryAfterSeconds = Math.max(0, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      exceeded.inc(1, { key });
      logger.warn('rate limit exceeded', { key, path: req.path });
      next(new HttpError(429, 'Rate limit exceeded.'));
      return;
    }

    next();
  };
}
