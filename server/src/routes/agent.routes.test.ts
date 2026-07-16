import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { ObservabilityService } from '../core/observability/index.ts';
import { SecurityService } from '../core/security/index.ts';
import { AuthService } from '../core/auth/index.ts';
import { TraceManager } from '../core/tracing/index.ts';
import { createErrorHandler } from '../middleware/errorHandler.middleware.ts';
import { createRequirePermissionMiddleware } from '../middleware/authorize.middleware.ts';
import { createAgentRouter } from './agent.routes.ts';
import type { AgentSession, AgentLifecycleManager } from '../agents/agent-lifecycle.ts';
import type { Agent } from '../agents/agent.types.ts';
import type { AgentRuntimeCreationOptions } from '../agents/agent.runtime.ts';

// A fake AgentLifecycleManager — the router only depends on the
// interface, so no OpenAI client (and no network call) is needed to
// exercise the HTTP surface. Mirrors the fake-LlmService idiom already
// used to test chat.controller.ts-adjacent code.
function fakeLifecycle(): AgentLifecycleManager {
  const sessions = new Map<string, AgentSession>();

  return {
    spawn(agent: Agent, _options?: AgentRuntimeCreationOptions): AgentSession {
      const session: AgentSession = {
        id: `session-${sessions.size + 1}`,
        agent,
        status: 'idle',
        createdAt: new Date(),
        lastActiveAt: null,
        runCount: 0,
      };
      sessions.set(session.id, session);
      return session;
    },
    async run(sessionId: string, message: string): Promise<string> {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Unknown agent session "${sessionId}".`);
      }
      if (session.status === 'terminated') {
        throw new Error(`Agent session "${sessionId}" is terminated.`);
      }
      session.runCount++;
      session.lastActiveAt = new Date();
      return `echo: ${message}`;
    },
    get(sessionId: string): AgentSession {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Unknown agent session "${sessionId}".`);
      }
      return session;
    },
    list(): AgentSession[] {
      return [...sessions.values()];
    },
    terminate(sessionId: string): void {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Unknown agent session "${sessionId}".`);
      }
      session.status = 'terminated';
    },
    terminateAll(): void {
      for (const session of sessions.values()) {
        session.status = 'terminated';
      }
    },
  };
}

function listen(app: express.Express) {
  const server = app.listen(0);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected server to bind to a TCP port');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function buildApp(lifecycle: AgentLifecycleManager) {
  const security = new SecurityService();
  const observability = new ObservabilityService();
  const tracing = new TraceManager();
  // An AuthService with no ApiKeyStore/JwtService configured is disabled
  // (isEnabled() === false), so requirePermission is a no-op here — these
  // tests exercise the agent routes' own behavior, not RBAC (see
  // middleware/authorize.middleware.test.ts and routes/agent.routes.auth.test.ts
  // for auth-enabled coverage).
  const auth = new AuthService();
  const requirePermission = (permission: Parameters<typeof createRequirePermissionMiddleware>[1]) =>
    createRequirePermissionMiddleware({ auth, observability, tracing }, permission);

  const app = express();
  app.use(express.json());
  app.use('/agent', createAgentRouter(lifecycle, security, requirePermission));
  app.use(createErrorHandler({ observability, security }));
  return app;
}

describe('agent routes', () => {
  test('spawns a session, runs a message, and reads it back', async () => {
    const { server, baseUrl } = listen(buildApp(fakeLifecycle()));
    try {
      const spawnResponse = await fetch(`${baseUrl}/agent/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Assistant', systemPrompt: 'Be helpful.' }),
      });
      const spawned = (await spawnResponse.json()) as { id: string; status: string };
      assert.equal(spawnResponse.status, 201);
      assert.equal(spawned.status, 'idle');

      const runResponse = await fetch(`${baseUrl}/agent/sessions/${spawned.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hi' }),
      });
      const run = (await runResponse.json()) as { reply: string };
      assert.equal(runResponse.status, 200);
      assert.equal(run.reply, 'echo: hi');

      const getResponse = await fetch(`${baseUrl}/agent/sessions/${spawned.id}`);
      const session = (await getResponse.json()) as { runCount: number };
      assert.equal(session.runCount, 1);

      const listResponse = await fetch(`${baseUrl}/agent/sessions`);
      const list = (await listResponse.json()) as { sessions: unknown[] };
      assert.equal(list.sessions.length, 1);
    } finally {
      server.close();
    }
  });

  test('rejects spawning without a system prompt', async () => {
    const { server, baseUrl } = listen(buildApp(fakeLifecycle()));
    try {
      const response = await fetch(`${baseUrl}/agent/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Assistant' }),
      });
      assert.equal(response.status, 400);
    } finally {
      server.close();
    }
  });

  test('running an unknown session returns 404', async () => {
    const { server, baseUrl } = listen(buildApp(fakeLifecycle()));
    try {
      const response = await fetch(`${baseUrl}/agent/sessions/missing/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hi' }),
      });
      assert.equal(response.status, 404);
    } finally {
      server.close();
    }
  });

  test('terminating a session then getting it still returns it, with terminated status', async () => {
    const { server, baseUrl } = listen(buildApp(fakeLifecycle()));
    try {
      const spawnResponse = await fetch(`${baseUrl}/agent/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Assistant', systemPrompt: 'Be helpful.' }),
      });
      const spawned = (await spawnResponse.json()) as { id: string };

      const deleteResponse = await fetch(`${baseUrl}/agent/sessions/${spawned.id}`, { method: 'DELETE' });
      assert.equal(deleteResponse.status, 204);

      const getResponse = await fetch(`${baseUrl}/agent/sessions/${spawned.id}`);
      const session = (await getResponse.json()) as { status: string };
      assert.equal(getResponse.status, 200);
      assert.equal(session.status, 'terminated');

      const runResponse = await fetch(`${baseUrl}/agent/sessions/${spawned.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hi' }),
      });
      assert.equal(runResponse.status, 409);
    } finally {
      server.close();
    }
  });
});
