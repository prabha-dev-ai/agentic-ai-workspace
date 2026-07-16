import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { ObservabilityService } from '../core/observability/index.ts';
import { SecurityService } from '../core/security/index.ts';
import { TraceManager } from '../core/tracing/index.ts';
import { ApiKeyStore, AuthService, Permission } from '../core/auth/index.ts';
import { createErrorHandler } from './errorHandler.middleware.ts';
import { createRequireAuthMiddleware, createRequirePermissionMiddleware } from './authorize.middleware.ts';

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
  const security = new SecurityService();

  const app = express();
  // No authenticate middleware here — tests set res.locals.principal
  // directly via a query-triggered stub, isolating authorize.middleware.ts's
  // own behavior from authenticate.middleware.ts's (covered separately).
  app.use((req, res, next) => {
    const subject = req.query.subject;
    const roles = req.query.roles;
    if (typeof subject === 'string' && typeof roles === 'string') {
      (res.locals as Record<string, unknown>).principal = {
        subject,
        roles: roles.split(','),
        authMethod: 'api-key',
      };
    }
    next();
  });

  app.get('/require-auth', createRequireAuthMiddleware({ auth, observability, tracing }), (_req, res) =>
    res.status(200).json({ ok: true }),
  );
  app.get(
    '/agent-read',
    createRequirePermissionMiddleware({ auth, observability, tracing }, Permission.AgentRead),
    (_req, res) => res.status(200).json({ ok: true }),
  );
  app.use(createErrorHandler({ observability, security }));
  return app;
}

describe('createRequireAuthMiddleware', () => {
  test('is a no-op when auth is disabled — no principal needed', async () => {
    const { server, baseUrl } = listen(buildApp(new AuthService()));
    try {
      const response = await fetch(`${baseUrl}/require-auth`);
      assert.equal(response.status, 200);
    } finally {
      server.close();
    }
  });

  test('rejects with 401 when auth is enabled and no principal is present', async () => {
    const auth = new AuthService({ apiKeyStore: new ApiKeyStore([{ key: 'k1', subject: 'alice', roles: ['admin'] }]) });
    const { server, baseUrl } = listen(buildApp(auth));
    try {
      const response = await fetch(`${baseUrl}/require-auth`);
      assert.equal(response.status, 401);
    } finally {
      server.close();
    }
  });

  test('passes when auth is enabled and a principal is present', async () => {
    const auth = new AuthService({ apiKeyStore: new ApiKeyStore([{ key: 'k1', subject: 'alice', roles: ['admin'] }]) });
    const { server, baseUrl } = listen(buildApp(auth));
    try {
      const response = await fetch(`${baseUrl}/require-auth?subject=alice&roles=admin`);
      assert.equal(response.status, 200);
    } finally {
      server.close();
    }
  });
});

describe('createRequirePermissionMiddleware', () => {
  test('is a no-op when auth is disabled', async () => {
    const { server, baseUrl } = listen(buildApp(new AuthService()));
    try {
      const response = await fetch(`${baseUrl}/agent-read`);
      assert.equal(response.status, 200);
    } finally {
      server.close();
    }
  });

  test('rejects with 401 when enabled and unauthenticated', async () => {
    const auth = new AuthService({ apiKeyStore: new ApiKeyStore([{ key: 'k1', subject: 'alice', roles: ['admin'] }]) });
    const { server, baseUrl } = listen(buildApp(auth));
    try {
      const response = await fetch(`${baseUrl}/agent-read`);
      assert.equal(response.status, 401);
    } finally {
      server.close();
    }
  });

  test('rejects with 403 when authenticated but lacking the permission', async () => {
    const auth = new AuthService({ apiKeyStore: new ApiKeyStore([{ key: 'k1', subject: 'bob', roles: ['viewer'] }]) });
    const { server, baseUrl } = listen(buildApp(auth));
    try {
      // Viewer has agent:read, so use a role with nothing granted instead.
      const response = await fetch(`${baseUrl}/agent-read?subject=bob&roles=nobody`);
      assert.equal(response.status, 403);
    } finally {
      server.close();
    }
  });

  test('passes when authenticated and the role grants the permission', async () => {
    const auth = new AuthService({ apiKeyStore: new ApiKeyStore([{ key: 'k1', subject: 'bob', roles: ['viewer'] }]) });
    const { server, baseUrl } = listen(buildApp(auth));
    try {
      const response = await fetch(`${baseUrl}/agent-read?subject=bob&roles=viewer`);
      assert.equal(response.status, 200);
    } finally {
      server.close();
    }
  });
});
