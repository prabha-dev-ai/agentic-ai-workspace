import type { Request, Response } from 'express';
import { createAgent } from '../agents/agent.factory.ts';
import type { AgentLifecycleManager, AgentSession } from '../agents/agent-lifecycle.ts';
import type { SecurityService } from '../core/security/index.ts';
import { HttpError } from '../middleware/HttpError.ts';
import { optionalNumber, optionalString, requireParam, requireString } from '../middleware/validation.ts';

// Translates AgentLifecycleManager's plain-Error messages (see
// agent-lifecycle.ts's requireSession) into the right HTTP status —
// keeping AgentLifecycleManager itself HTTP-agnostic, per the layering
// rule that domain modules never depend on the HTTP layer.
async function withMappedSessionErrors<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('Unknown agent session')) {
      throw new HttpError(404, message);
    }
    if (message.includes('terminated') || message.includes('already processing')) {
      throw new HttpError(409, message);
    }
    throw error;
  }
}

function toSessionSummary(session: AgentSession) {
  return {
    id: session.id,
    agent: {
      name: session.agent.name,
      description: session.agent.description,
      model: session.agent.model,
    },
    status: session.status,
    createdAt: session.createdAt.toISOString(),
    lastActiveAt: session.lastActiveAt ? session.lastActiveAt.toISOString() : null,
    runCount: session.runCount,
  };
}

/** POST /agent/sessions — spawn a live agent session from a config. */
export function createSpawnAgentHandler(lifecycle: AgentLifecycleManager, security: SecurityService) {
  return (req: Request, res: Response): void => {
    const name = requireString(req.body, 'name');
    const description = optionalString(req.body, 'description') ?? '';
    const systemPrompt = requireString(req.body, 'systemPrompt');
    const model = optionalString(req.body, 'model');
    const maxIterations = optionalNumber(req.body, 'maxIterations');

    security.validateInput(systemPrompt, 'systemPrompt');

    let agent;
    try {
      agent = createAgent({
        name,
        description,
        systemPrompt,
        ...(model !== undefined ? { model } : {}),
        ...(maxIterations !== undefined ? { maxIterations } : {}),
      });
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    }

    const session = lifecycle.spawn(agent);
    res.status(201).json(toSessionSummary(session));
  };
}

/** GET /agent/sessions — every session this process has ever spawned. */
export function createListAgentSessionsHandler(lifecycle: AgentLifecycleManager) {
  return (_req: Request, res: Response): void => {
    res.status(200).json({ sessions: lifecycle.list().map(toSessionSummary) });
  };
}

/** GET /agent/sessions/:sessionId */
export function createGetAgentSessionHandler(lifecycle: AgentLifecycleManager) {
  return async (req: Request, res: Response): Promise<void> => {
    const sessionId = requireParam(req.params, 'sessionId');
    const session = await withMappedSessionErrors(() => lifecycle.get(sessionId));
    res.status(200).json(toSessionSummary(session));
  };
}

/** POST /agent/sessions/:sessionId/run — run one message through a session. */
export function createRunAgentHandler(lifecycle: AgentLifecycleManager, security: SecurityService) {
  return async (req: Request, res: Response): Promise<void> => {
    const sessionId = requireParam(req.params, 'sessionId');
    const message = requireString(req.body, 'message');
    security.validateInput(message, 'message');

    const answer = await withMappedSessionErrors(() => lifecycle.run(sessionId, message));
    res.status(200).json({ reply: answer });
  };
}

/** DELETE /agent/sessions/:sessionId — end a session; it stays in list() as an audit trail. */
export function createTerminateAgentSessionHandler(lifecycle: AgentLifecycleManager) {
  return async (req: Request, res: Response): Promise<void> => {
    const sessionId = requireParam(req.params, 'sessionId');
    await withMappedSessionErrors(() => lifecycle.terminate(sessionId));
    res.status(204).send();
  };
}
