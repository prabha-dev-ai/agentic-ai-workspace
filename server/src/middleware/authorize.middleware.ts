import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AuthService, Permission, Principal } from '../core/auth/index.ts';
import type { ObservabilityService } from '../core/observability/index.ts';
import type { TraceManager } from '../core/tracing/index.ts';
import { SpanStatus } from '../core/tracing/index.ts';
import { HttpError } from './HttpError.ts';

export interface AuthorizeDependencies {
  auth: AuthService;
  observability: ObservabilityService;
  tracing: TraceManager;
}

/** What route files receive from app.ts: a factory that binds a
 *  permission to a ready-to-mount middleware, so each router decides its
 *  own per-route permission without constructing AuthorizeDependencies
 *  itself. */
export type PermissionGuard = (permission: Permission) => RequestHandler;

function principalOf(res: Response): Principal | undefined {
  return (res.locals as Record<string, unknown>).principal as Principal | undefined;
}

/**
 * Requires SOME authenticated principal — but only when auth is actually
 * configured (auth.isEnabled()). A zero-config deployment (AAI-037's
 * behavior) never enforces this: every request passes through exactly as
 * it did before this story.
 */
export function createRequireAuthMiddleware(deps: AuthorizeDependencies): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction): void => {
    if (!deps.auth.isEnabled()) {
      next();
      return;
    }
    if (!principalOf(res)) {
      next(new HttpError(401, 'Authentication required.'));
      return;
    }
    next();
  };
}

/**
 * Requires an authenticated principal whose roles grant `permission` —
 * the same no-op-when-disabled behavior as requireAuth above. This is
 * what route.routes.ts files call per-route for RBAC (route
 * authorization): different routes require different permissions, so the
 * check has to be a factory taking the permission, not a single shared
 * middleware instance.
 */
export function createRequirePermissionMiddleware(
  deps: AuthorizeDependencies,
  permission: Permission,
): RequestHandler {
  const { auth, observability, tracing } = deps;
  const logger = observability.getLogger('security.audit');
  const tracer = tracing.getTracer('security.auth');

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!auth.isEnabled()) {
      next();
      return;
    }

    const principal = principalOf(res);
    if (!principal) {
      next(new HttpError(401, 'Authentication required.'));
      return;
    }

    // A manually-scoped span, not tracer.withSpan(): the span must end
    // BEFORE next() runs the rest of the chain — wrapping next() inside
    // withSpan's callback would let a later handler's synchronous throw
    // propagate back through this span's try/catch and get misattributed
    // to the authorization check that already succeeded.
    const span = tracer.startSpan('auth.authorize', { attributes: { 'http.path': req.path } });
    const granted = auth.authorize(principal, permission);
    span.setAttribute('auth.permission', permission);
    span.setAttribute('auth.result', granted ? 'granted' : 'denied');
    span.end(granted ? SpanStatus.Ok : SpanStatus.Error, granted ? undefined : 'permission denied');

    if (!granted) {
      logger.warn('authorization denied', {
        subject: principal.subject,
        permission,
        path: req.path,
      });
      next(new HttpError(403, `Principal "${principal.subject}" lacks permission "${permission}".`));
      return;
    }

    next();
  };
}
