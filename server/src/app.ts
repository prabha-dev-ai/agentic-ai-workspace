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

// Infrastructure endpoints, not business features — so they live here
// instead of in a routes module, same reasoning as v2.0.0's /health and
// /diagnostics. Used by load balancers, monitoring, and Prometheus scrape
// jobs. Response shapes are additive-only versus v2.0.0 — see
// controllers/health.controller.ts's doc comments for what changed.
app.get('/health', createHealthHandler());
app.get('/ready', createReadinessHandler(container));
app.get('/diagnostics', createDiagnosticsHandler(container, frameworkVersion));
app.get('/metrics', createMetricsHandler(container));
app.get('/openapi.json', createOpenApiHandler(frameworkVersion));

app.use(
  '/chat',
  createChatRouter(
    container.get(TOKENS.llmService),
    container.get(TOKENS.streaming),
    container.get(TOKENS.security),
  ),
);
app.use('/agent', createAgentRouter(container.get(TOKENS.agentLifecycle), container.get(TOKENS.security)));
app.use('/workflow', createWorkflowRouter(container.get(TOKENS.workflows)));

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
