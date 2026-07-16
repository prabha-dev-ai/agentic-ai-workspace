import { Router } from 'express';
import {
  createGetAgentSessionHandler,
  createListAgentSessionsHandler,
  createRunAgentHandler,
  createSpawnAgentHandler,
  createTerminateAgentSessionHandler,
} from '../controllers/agent.controller.ts';
import type { AgentLifecycleManager } from '../agents/agent-lifecycle.ts';
import type { SecurityService } from '../core/security/index.ts';
import { Permission } from '../core/auth/index.ts';
import type { PermissionGuard } from '../middleware/authorize.middleware.ts';

// Mounted at "/agent" in app.ts. Sessions are the HTTP-facing resource —
// they map directly onto AgentLifecycleManager, the pre-existing hub that
// already owns spawn/run/terminate and the idle/busy/terminated state
// machine; this router adds no new agent-lifecycle behavior of its own.
// requirePermission is a no-op when auth is unconfigured (see
// middleware/authorize.middleware.ts) — reads need agent:read, actions
// that spawn/run/terminate a live session need agent:write.
export function createAgentRouter(
  lifecycle: AgentLifecycleManager,
  security: SecurityService,
  requirePermission: PermissionGuard,
): Router {
  const agentRouter = Router();

  agentRouter.post('/sessions', requirePermission(Permission.AgentWrite), createSpawnAgentHandler(lifecycle, security));
  agentRouter.get('/sessions', requirePermission(Permission.AgentRead), createListAgentSessionsHandler(lifecycle));
  agentRouter.get(
    '/sessions/:sessionId',
    requirePermission(Permission.AgentRead),
    createGetAgentSessionHandler(lifecycle),
  );
  agentRouter.post(
    '/sessions/:sessionId/run',
    requirePermission(Permission.AgentWrite),
    createRunAgentHandler(lifecycle, security),
  );
  agentRouter.delete(
    '/sessions/:sessionId',
    requirePermission(Permission.AgentWrite),
    createTerminateAgentSessionHandler(lifecycle),
  );

  return agentRouter;
}
