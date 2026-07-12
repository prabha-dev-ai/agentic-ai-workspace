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

// Mounted at "/agent" in app.ts. Sessions are the HTTP-facing resource —
// they map directly onto AgentLifecycleManager, the pre-existing hub that
// already owns spawn/run/terminate and the idle/busy/terminated state
// machine; this router adds no new agent-lifecycle behavior of its own.
export function createAgentRouter(lifecycle: AgentLifecycleManager, security: SecurityService): Router {
  const agentRouter = Router();

  agentRouter.post('/sessions', createSpawnAgentHandler(lifecycle, security));
  agentRouter.get('/sessions', createListAgentSessionsHandler(lifecycle));
  agentRouter.get('/sessions/:sessionId', createGetAgentSessionHandler(lifecycle));
  agentRouter.post('/sessions/:sessionId/run', createRunAgentHandler(lifecycle, security));
  agentRouter.delete('/sessions/:sessionId', createTerminateAgentSessionHandler(lifecycle));

  return agentRouter;
}
