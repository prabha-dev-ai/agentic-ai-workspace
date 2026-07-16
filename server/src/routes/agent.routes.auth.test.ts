import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { ObservabilityService } from '../core/observability/index.ts';
import { SecurityService } from '../core/security/index.ts';
import { TraceManager } from '../core/tracing/index.ts';
import { MetricsRegistry } from '../core/metrics/index.ts';
import { ApiKeyStore, AuthService } from '../core/auth/index.ts';
import { createAuthenticateMiddleware } from '../middleware/authenticate.middleware.ts';
import { createRequirePermissionMiddleware } from '../middleware/authorize.middleware.ts';
import type { PermissionGuard } from '../middleware/authorize.middleware.ts';
import { createErrorHandler } from '../middleware/errorHandler.middleware.ts';
import { createAgentRouter } from './agent.routes.ts';
import type { AgentSession, AgentLifecycleManager } from '../agents/agent-lifecycle.ts';
import type { Agent } from '../agents/agent.types.ts';

// A real end-to-end RBAC test: authenticate + requirePermission wired the
// same way app.ts wires them, over the real agent router — not a stub
// route. Complements agent.routes.test.ts (which exercises the router's
// own behavior with auth disabled) by exercising RBAC enforcement itself.
function fakeLifecycle(): AgentLifecycleManager {
  const sessions = new Map<string, AgentSession>();
  return {
    spawn(agent: Agent): AgentSession {
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
    async run(): Promise<string> {
      return 'unused';
    },
    get(sessionId: string): AgentSession {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`Unknown agent session "${sessionId}".`);
      return session;
    },
    list(): AgentSession[] {
      return [...sessions.values()];
    },
    terminate(): void {},
    terminateAll(): void {},
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

function buildApp(auth: AuthService) {
  const observability = new ObservabilityService();
  const tracing = new TraceManager();
  const metrics = new MetricsRegistry();
  const security = new SecurityService();

  const requirePermission: PermissionGuard = (permission) =>
    createRequirePermissionMiddleware({ auth, observability, tracing }, permission);

  const app = express();
  app.use(express.json());
  app.use(createAuthenticateMiddleware({ auth, observability, tracing, metrics }));
  app.use('/agent', createAgentRouter(fakeLifecycle(), security, requirePermission));
  app.use(createErrorHandler({ observability, security }));
  return app;
}

describe('agent routes with RBAC enabled', () => {
  const auth = new AuthService({
    apiKeyStore: new ApiKeyStore([
      { key: 'admin-key', subject: 'alice', roles: ['admin'] },
      { key: 'viewer-key', subject: 'bob', roles: ['viewer'] },
    ]),
  });

  test('rejects an unauthenticated request with 401', async () => {
    const { server, baseUrl } = listen(buildApp(auth));
    try {
      const response = await fetch(`${baseUrl}/agent/sessions`);
      assert.equal(response.status, 401);
    } finally {
      server.close();
    }
  });

  test('rejects an authenticated viewer spawning a session with 403 (needs agent:write)', async () => {
    const { server, baseUrl } = listen(buildApp(auth));
    try {
      const response = await fetch(`${baseUrl}/agent/sessions`, {
        method: 'POST',
        headers: { Authorization: 'ApiKey viewer-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Assistant', systemPrompt: 'Be helpful.' }),
      });
      assert.equal(response.status, 403);
    } finally {
      server.close();
    }
  });

  test('allows a viewer to list sessions (agent:read)', async () => {
    const { server, baseUrl } = listen(buildApp(auth));
    try {
      const response = await fetch(`${baseUrl}/agent/sessions`, {
        headers: { Authorization: 'ApiKey viewer-key' },
      });
      assert.equal(response.status, 200);
    } finally {
      server.close();
    }
  });

  test('allows an admin to spawn a session (agent:write)', async () => {
    const { server, baseUrl } = listen(buildApp(auth));
    try {
      const response = await fetch(`${baseUrl}/agent/sessions`, {
        method: 'POST',
        headers: { Authorization: 'ApiKey admin-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Assistant', systemPrompt: 'Be helpful.' }),
      });
      assert.equal(response.status, 201);
    } finally {
      server.close();
    }
  });

  test('rejects an invalid API key with 401', async () => {
    const { server, baseUrl } = listen(buildApp(auth));
    try {
      const response = await fetch(`${baseUrl}/agent/sessions`, {
        headers: { Authorization: 'ApiKey not-a-real-key' },
      });
      assert.equal(response.status, 401);
    } finally {
      server.close();
    }
  });
});
