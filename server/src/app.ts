import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { bootstrap } from './core/bootstrap.ts';
import { TOKENS } from './core/tokens.ts';
import { createChatRouter } from './routes/chat.routes.ts';
import { createAgentRouter } from './routes/agent.routes.ts';
import { createWorkflowRouter } from './routes/workflow.routes.ts';
import {
  createDiagnosticsHandler,
  createHealthHandler,
  createMetricsHandler,
  createReadinessHandler,
} from './controllers/health.controller.ts';
import { createOpenApiHandler } from './controllers/openapi.controller.ts';
import { createRequestContextMiddleware } from './middleware/requestContext.middleware.ts';
import { createErrorHandler } from './middleware/errorHandler.middleware.ts';
import { createNotFoundHandler } from './middleware/notFound.middleware.ts';
import { createAuthenticateMiddleware } from './middleware/authenticate.middleware.ts';
import { createRequirePermissionMiddleware } from './middleware/authorize.middleware.ts';
import type { PermissionGuard } from './middleware/authorize.middleware.ts';
import { createRateLimitMiddleware } from './middleware/rateLimit.middleware.ts';
import { Permission } from './core/auth/index.ts';

// Wire the framework once at startup (top-level await: plugins install
// before the first request); hand each route its dependencies.
const container = await bootstrap();

// Read once at startup rather than per-request — the version never
// changes while the process is running.
const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
const { version: frameworkVersion } = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
  version: string;
};

const app = express();

// Middleware order matters: CORS first so every response (including
// errors) carries the headers, then body parsing for JSON requests, then
// the request-context bridge (Observability/Tracing/Metrics) so it can
// time and log absolutely everything that follows, including 404s and
// errors.
app.use(cors());
app.use(express.json());
app.use(
  createRequestContextMiddleware({
    observability: container.get(TOKENS.observability),
    tracing: container.get(TOKENS.tracing),
    metrics: container.get(TOKENS.metrics),
  }),
);

// AAI-038: identifies the caller (if credentials are present) for every
// request, before any route-specific authorization runs. A no-op when no
// Authorization header is sent — see authenticate.middleware.ts.
app.use(
  createAuthenticateMiddleware({
    auth: container.get(TOKENS.auth),
    observability: container.get(TOKENS.observability),
    tracing: container.get(TOKENS.tracing),
    metrics: container.get(TOKENS.metrics),
  }),
);

// Rate limiting is optional (TOKENS.rateLimiter is registered only when
// RATE_LIMIT_WINDOW_MS/RATE_LIMIT_MAX are both configured — see
// core/bootstrap.ts) and, when present, keys by the principal set above.
const rateLimiter = container.resolve(TOKENS.rateLimiter);
if (rateLimiter) {
  app.use(
    createRateLimitMiddleware({
      rateLimiter,
      observability: container.get(TOKENS.observability),
      metrics: container.get(TOKENS.metrics),
    }),
  );
}

// A no-op per-route guard when AuthService.isEnabled() is false (no
// API_KEYS/JWT_SECRET configured) — every route stays exactly as open as
// it was in AAI-037. See middleware/authorize.middleware.ts.
const requirePermission: PermissionGuard = (permission) =>
  createRequirePermissionMiddleware(
    {
      auth: container.get(TOKENS.auth),
      observability: container.get(TOKENS.observability),
      tracing: container.get(TOKENS.tracing),
    },
    permission,
  );

// Infrastructure endpoints, not business features — so they live here
// instead of in a routes module, same reasoning as v2.0.0's /health and
// /diagnostics. Used by load balancers, monitoring, and Prometheus scrape
// jobs. Response shapes are additive-only versus v2.0.0 — see
// controllers/health.controller.ts's doc comments for what changed.
// /health and /ready stay unauthenticated on purpose: a load balancer or
// orchestrator probing liveness/readiness has no way to present a
// credential.
app.get('/health', createHealthHandler());
app.get('/ready', createReadinessHandler(container));
app.get('/diagnostics', requirePermission(Permission.DiagnosticsRead), createDiagnosticsHandler(container, frameworkVersion));
app.get('/metrics', requirePermission(Permission.MetricsRead), createMetricsHandler(container));
app.get('/openapi.json', createOpenApiHandler(frameworkVersion));

app.use(
  '/chat',
  createChatRouter(
    container.get(TOKENS.llmService),
    container.get(TOKENS.streaming),
    container.get(TOKENS.security),
    requirePermission,
  ),
);
app.use(
  '/agent',
  createAgentRouter(container.get(TOKENS.agentLifecycle), container.get(TOKENS.security), requirePermission),
);
app.use('/workflow', createWorkflowRouter(container.get(TOKENS.workflows), requirePermission));

// Must be last: unmatched routes, then errors thrown by anything above
// (Express 5 forwards both sync throws and rejected promises here
// automatically — see errorHandler.middleware.ts's doc comment).
app.use(createNotFoundHandler());
app.use(
  createErrorHandler({
    observability: container.get(TOKENS.observability),
    security: container.get(TOKENS.security),
  }),
);

export { app, container };
